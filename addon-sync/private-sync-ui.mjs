import { pickPrivateInbox, watchPrivateInbox } from './private-inbox.mjs';

const mounts = new WeakMap();
let nextHeading = 0;

const resultLabels = {
  accepted: 'Übernommen',
  rejected: 'Abgelehnt',
  duplicate: 'Bereits verarbeitet',
  waiting: 'Ausstehend',
};
const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const protectedFolder = 'Wenn Chrome oder Edge den WoW-Ordner sperrt, wähle eine Kopie der MUAZCO.lua in einem freigegebenen Ordner. Aktualisiere die Kopie nach jedem WoW-Speichervorgang.';

function fileFeedback(error, picking) {
  if (error?.code === 'UNSUPPORTED') {
    return 'Öffne den Planer über HTTPS in Chrome oder Edge, um eine Datei zu verbinden.';
  }
  if (error?.name === 'SecurityError' || (picking && error?.name === 'NotAllowedError')) {
    return `Der Browser hat den Dateizugriff abgelehnt. ${protectedFolder}`;
  }
  if (picking && error?.name === 'AbortError') {
    return `Dateiauswahl beendet. ${protectedFolder}`;
  }
  if (error?.name === 'NotAllowedError') {
    return 'Der Planer hat keinen Lesezugriff mehr. Wähle die Datei erneut aus.';
  }
  if (error?.name === 'NotFoundError') {
    return 'Die Datei ist momentan nicht erreichbar. Der Planer versucht es erneut. Falls sie verschoben wurde, wähle sie erneut aus.';
  }
  if (['WRONG_FILE', 'TOO_LARGE', 'INVALID_FILE'].includes(error?.code)) {
    return error.message;
  }
  return 'Die Datei konnte gerade nicht gelesen werden. Prüfe die Dateiauswahl.';
}

function uploadFeedback(error) {
  if (typeof error?.publicMessage === 'string' && error.publicMessage) {
    return error.publicMessage;
  }
  if ([401, 403].includes(error?.status) || error?.code === 'NOT_AUTHORIZED') {
    return 'Der Planer braucht eine gültige Sitzung der Raidleitung. Melde dich erneut an.';
  }
  return 'Der Planer konnte die Anfragen gerade nicht bestätigen. Der Abgleich versucht es erneut, solange die Datei verbunden ist.';
}

class UploadFailure extends Error {}

function sameEntry(before, after) {
  return before.export === after.export && before.sender === after.sender
    && before.senderGUID === after.senderGUID && before.characterGUID === after.characterGUID
    && before.receivedAt === after.receivedAt;
}

export function mountPrivateSyncUI(container, adapter) {
  if (!container?.ownerDocument || typeof adapter?.uploadEntries !== 'function') {
    throw new TypeError('mountPrivateSyncUI requires a container and an uploadEntries adapter');
  }
  if (mounts.has(container)) return mounts.get(container);

  const { uploadEntries, pickFile = pickPrivateInbox, watchFile = watchPrivateInbox, intervalMs, fileHelp } = adapter;
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const supported = pickFile !== pickPrivateInbox || (view?.isSecureContext && typeof view.showOpenFilePicker === 'function');
  let handle = null;
  let watch = null;
  let picking = false;
  let reading = false;
  let uploading = false;
  let destroyed = false;
  let lastRead = null;
  let lastUpload = null;
  let fileError = '';
  let uploadError = '';
  let selectionFeedback = '';
  let entries = [];
  const outcomes = new Map();

  function make(tag, parent, text, className) {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    parent?.append(element);
    return element;
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function button(parent, label, listener) {
    const element = make('button', parent, label);
    element.type = 'button';
    element.addEventListener('click', listener);
    return element;
  }

  const section = make('section', container, '', 'muazco-private-sync');
  const header = make('div', section, '', 'mps-header');
  const heading = make('h2', header, 'MUAZCO-Postfach');
  heading.id = `muazco-private-sync-${++nextHeading}`;
  section.setAttribute('aria-labelledby', heading.id);
  const status = make('span', header, '', 'mps-status');
  status.setAttribute('role', 'status');
  make('p', section, fileHelp ?? 'Verbinde das Postfach deines Empfangscharakters. Nach /reload oder beim Ausloggen speichert WoW die Datei. Der geöffnete Planer liest und überträgt neue Anfragen dann automatisch.');

  const actions = make('div', section, '', 'mps-actions');
  const connectButton = button(actions, 'Datei verbinden', connect);
  connectButton.className = 'mps-primary';
  const refreshButton = button(actions, 'Jetzt prüfen', refresh);
  const disconnectButton = button(actions, 'Verbindung trennen', () => {
    disconnect();
    connectButton.focus();
  });

  const fileInfo = make('p', section, '', 'mps-file');
  const details = make('details', section);
  make('summary', details, 'WoW-Datei finden');
  make('p', details, 'Wähle die MUAZCO.lua unter SavedVariables im Ordner des Empfangscharakters.');
  make('code', details, String.raw`World of Warcraft\_forever_\WTF\Account\<Konto>\<Realm>\<Charakter>\SavedVariables\MUAZCO.lua`);
  make('p', details, 'Der Planer liest nur Anfragen aus dem ausgewählten Postfach. Der Abgleich läuft, solange der Tab geöffnet ist, der Lesezugriff besteht und du als Raidleitung angemeldet bist.');

  const info = make('p', section, '', 'mps-note');
  info.setAttribute('role', 'status');
  const errorBox = make('p', section, '', 'mps-error');
  errorBox.setAttribute('role', 'alert');

  const counters = make('dl', section, '', 'mps-counters');
  const values = {};
  for (const [key, label] of [['total', 'Eingelesen'], ...Object.entries(resultLabels)]) {
    const item = make('div', counters);
    item.dataset.status = key;
    make('dt', item, label);
    values[key] = make('dd', item, '0');
  }

  const resultDetails = make('details', section, '', 'mps-results');
  const resultHeading = make('summary', resultDetails, 'Ergebnisse pro Anfrage');
  const resultList = make('ul', resultDetails);

  function resultFor(entry) {
    const result = outcomes.get(entry.requestId);
    return result && sameEntry(result.entry, entry) ? result : null;
  }

  function render() {
    const message = !supported ? 'Browser nicht unterstützt'
      : picking ? 'Dateiauswahl geöffnet'
        : fileError ? 'Datei prüfen'
          : !handle ? 'Keine Datei verbunden'
            : reading ? 'Datei wird geprüft'
              : uploading ? 'Anfragen werden übertragen' : 'Datei verbunden';
    status.dataset.state = fileError || !supported ? 'error' : handle && !reading ? 'connected' : 'neutral';
    setText(status, message);
    connectButton.disabled = !supported || picking || uploading;
    setText(connectButton, fileError ? 'Datei erneut wählen' : handle ? 'Andere Datei wählen' : 'Datei verbinden');
    refreshButton.hidden = !handle;
    refreshButton.disabled = reading || uploading || picking;
    disconnectButton.hidden = !handle;
    disconnectButton.disabled = picking;

    const timestamps = [handle?.name, lastRead && `Dateistand gelesen ${dateTime.format(lastRead)}`, lastUpload && `Planerantwort ${dateTime.format(lastUpload)}`].filter(Boolean);
    fileInfo.hidden = timestamps.length === 0;
    setText(fileInfo, timestamps.join(' · '));
    const guidance = !supported ? fileFeedback({ code: 'UNSUPPORTED' }, true) : selectionFeedback;
    info.hidden = !guidance;
    setText(info, guidance);
    const errors = [fileError, uploadError].filter(Boolean).join(' ');
    errorBox.hidden = !errors;
    setText(errorBox, errors);

    const counts = { total: entries.length, accepted: 0, rejected: 0, duplicate: 0, waiting: 0 };
    const rows = doc.createDocumentFragment();
    for (const entry of entries) {
      const result = resultFor(entry);
      const outcome = result?.status ?? 'waiting';
      counts[outcome]++;
      const row = make('li', rows);
      const action = entry.action === 'CANCEL' ? 'Absage' : 'Anmeldung';
      make('span', row, `${action} · ${entry.character ?? entry.sender ?? entry.requestId}`);
      const label = make('strong', row, resultLabels[outcome]);
      label.dataset.status = outcome;
      if (result?.message) make('small', row, result.message);
    }
    for (const [key, count] of Object.entries(counts)) setText(values[key], String(count));
    counters.hidden = !lastRead;
    resultDetails.hidden = entries.length === 0;
    setText(resultHeading, `Ergebnisse pro Anfrage (${entries.length})`);
    resultList.replaceChildren(rows);
  }

  function clearWatch() {
    if (!watch) return;
    const previous = watch;
    watch = null;
    previous.controller.abort();
    previous.stop?.();
  }

  function startWatch(selected) {
    clearWatch();
    const current = { controller: new AbortController() };
    watch = current;
    reading = true;
    fileError = '';
    render();
    const callbacks = {
      intervalMs,
      async onEntries(inbox) {
        if (watch !== current) return;
        entries = inbox;
        const present = new Set(inbox.map(entry => entry.requestId));
        for (const id of outcomes.keys()) {
          if (!present.has(id)) outcomes.delete(id);
        }
        reading = false;
        fileError = '';
        lastRead = new Date();
        const pending = inbox.filter(entry => !resultFor(entry));
        uploading = pending.length > 0;
        uploadError = '';
        render();
        if (!uploading) return;

        try {
          const response = await uploadEntries(pending, { signal: current.controller.signal });
          if (watch !== current) return;
          const pendingById = new Map(pending.map(entry => [entry.requestId, entry]));
          if (!Array.isArray(response?.results)) throw new UploadFailure();
          for (const result of response.results) {
            const entry = pendingById.get(result?.requestId);
            if (!entry || !['accepted', 'rejected', 'duplicate'].includes(result.status)) continue;
            outcomes.set(entry.requestId, { entry, status: result.status, message: typeof result.message === 'string' ? result.message : '' });
            pendingById.delete(entry.requestId);
          }
          lastUpload = new Date();
          if (pendingById.size > 0) throw new UploadFailure();
        } catch (error) {
          if (watch !== current) return;
          uploadError = uploadFeedback(error);
          throw new UploadFailure();
        } finally {
          if (watch === current) {
            uploading = false;
            render();
          }
        }
      },
      onError(error) {
        if (watch !== current || error instanceof UploadFailure) return;
        reading = false;
        fileError = fileFeedback(error, false);
        render();
      },
    };
    try {
      current.stop = watchFile(selected, callbacks);
    } catch (error) {
      callbacks.onError(error);
    }
  }

  async function connect() {
    if (destroyed || picking || uploading || !supported) return;
    picking = true;
    selectionFeedback = '';
    render();
    try {
      const selected = await pickFile();
      if (destroyed) return;
      disconnect();
      handle = selected;
      startWatch(handle);
    } catch (error) {
      if (!destroyed) selectionFeedback = fileFeedback(error, true);
    } finally {
      picking = false;
      if (!destroyed) render();
    }
  }

  function disconnect() {
    clearWatch();
    handle = null;
    reading = false;
    uploading = false;
    lastRead = null;
    lastUpload = null;
    fileError = '';
    uploadError = '';
    selectionFeedback = '';
    entries = [];
    outcomes.clear();
    render();
  }

  function refresh() {
    if (!handle || picking || uploading || reading) return false;
    startWatch(handle);
    return true;
  }

  const ui = {
    refresh,
    destroy() {
      destroyed = true;
      clearWatch();
      section.remove();
      mounts.delete(container);
    },
  };
  mounts.set(container, ui);
  render();
  return ui;
}
