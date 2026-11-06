const MAX_BYTES = 1_000_000;
const MAX_ENTRIES = 500;
const FILE_NAME = 'MUAZCO.lua';
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const PLAYER_GUID = /^Player-[0-9]{1,12}-[0-9A-Fa-f]{1,32}(?![\s\S])/;
const ENCODED_NAME = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/;
const ASCII_CONTROL = /[\x00-\x1f\x7f]/;
const TRIVIA = /(?:[ \t\r\n\v\f]+|--(?!\[=*\[)[^\r\n]*)*/y;
const IDENTIFIER = /[A-Za-z_][A-Za-z_0-9]*/y;
const INTEGER = /[0-9]+/y;
const DECIMAL_ESCAPE = /[0-9]{0,2}/y;
const LUA_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39 };
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const specs = {
    DRUID: { BALANCE: 'DAMAGER', FERAL_COMBAT: 'DAMAGER', RESTORATION: 'HEALER' },
    HUNTER: { BEAST_MASTERY: 'DAMAGER', MARKSMANSHIP: 'DAMAGER', SURVIVAL: 'DAMAGER' },
    MAGE: { ARCANE: 'DAMAGER', FIRE: 'DAMAGER', FROST: 'DAMAGER' },
    PALADIN: { HOLY: 'HEALER', PROTECTION: 'TANK', RETRIBUTION: 'DAMAGER' },
    PRIEST: { DISCIPLINE: 'HEALER', HOLY: 'HEALER', SHADOW: 'DAMAGER' },
    ROGUE: { ASSASSINATION: 'DAMAGER', COMBAT: 'DAMAGER', SUBTLETY: 'DAMAGER' },
    SHAMAN: { ELEMENTAL: 'DAMAGER', ENHANCEMENT: 'DAMAGER', RESTORATION: 'HEALER' },
    WARLOCK: { AFFLICTION: 'DAMAGER', DEMONOLOGY: 'DAMAGER', DESTRUCTION: 'DAMAGER' },
    WARRIOR: { ARMS: 'DAMAGER', FURY: 'DAMAGER', PROTECTION: 'TANK' },
};

export class PrivateInboxError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PrivateInboxError';
        this.code = code;
    }
}

function invalid(message = 'Die Datei enthält kein gültiges privates MUAZCO-Postfach.') {
    return new PrivateInboxError('INVALID_FILE', message);
}

function tooLarge() {
    return new PrivateInboxError('TOO_LARGE', 'Die MUAZCO-Datei ist zu groß.');
}

function validName(value, maxBytes) {
    return typeof value === 'string' && value.trim() !== ''
        && !ASCII_CONTROL.test(value) && utf8Encoder.encode(value).length <= maxBytes;
}

function decodeCharacter(value) {
    if (!ENCODED_NAME.test(value)) {
        throw invalid('Ein Auftrag enthält einen ungültigen Charakternamen.');
    }
    let name;
    try {
        name = decodeURIComponent(value);
    } catch {
        throw invalid('Ein Auftrag enthält einen ungültigen Charakternamen.');
    }
    // The WoW encoder leaves ASCII unreserved bytes intact.
    const unnecessaryEscape = /%([0-9A-F]{2})/g;
    const canonical = value.replace(unnecessaryEscape, (escape, hex) => {
        const character = String.fromCharCode(Number.parseInt(hex, 16));
        return /^[A-Za-z0-9._~-]$/.test(character) ? character : escape;
    });
    if (canonical !== value || !validName(name, 120)) {
        throw invalid('Ein Auftrag enthält einen ungültigen Charakternamen.');
    }
    return name;
}

export function parsePrivateRequest(exportCode) {
    if (typeof exportCode !== 'string' || exportCode.length > 960 || /[^\x21-\x7e]/.test(exportCode)) {
        throw invalid('Das Postfach enthält einen ungültigen MUAZCO-Auftrag.');
    }
    const fields = exportCode.split('|');
    const [version, action, memberId, requestId, raidId] = fields;
    const signup = action === 'SIGNUP';
    if (version !== 'MUAZCO1' || (!signup && action !== 'CANCEL')
        || fields.length !== (signup ? 10 : 6) || !ID.test(memberId) || !ID.test(requestId)
        || requestId === '-' || !ID.test(raidId)) {
        throw invalid('Das Postfach enthält einen ungültigen MUAZCO-Auftrag.');
    }
    const revisionText = fields[signup ? 8 : 5];
    const expectedRevision = Number(revisionText);
    if (!/^(?:0|[1-9][0-9]*)$/.test(revisionText) || !Number.isSafeInteger(expectedRevision)) {
        throw invalid('Ein Auftrag enthält einen ungültigen Versionsstand.');
    }
    const request = {
        action, memberId, requestId, raidId, expectedRevision,
        character: null, class: null, role: null, spec: null,
    };
    if (signup) {
        const [, , , , , character, className, role, , spec] = fields;
        const classSpecs = Object.hasOwn(specs, className) ? specs[className] : {};
        const feralTank = className === 'DRUID' && spec === 'FERAL_COMBAT' && role === 'TANK';
        if (!Object.hasOwn(classSpecs, spec) || (classSpecs[spec] !== role && !feralTank)) {
            throw invalid('Klasse, Spezialisierung und Rolle eines Auftrags passen nicht zusammen.');
        }
        Object.assign(request, { character: decodeCharacter(character), class: className, role, spec });
    }
    return request;
}

class SavedVariablesReader {
    constructor(text) {
        this.text = text;
        this.index = text.startsWith('\uFEFF') ? 1 : 0;
    }

    match(pattern) {
        pattern.lastIndex = this.index;
        const match = pattern.exec(this.text);
        if (match) {
            this.index = pattern.lastIndex;
            return match[0];
        }
        return null;
    }

    consume(token) {
        this.match(TRIVIA);
        if (!this.text.startsWith(token, this.index)) {
            return false;
        }
        this.index += token.length;
        return true;
    }

    expect(token) {
        if (!this.consume(token)) {
            throw invalid();
        }
    }

    identifier() {
        this.match(TRIVIA);
        const name = this.match(IDENTIFIER);
        if (!name) {
            throw invalid();
        }
        return name;
    }

    escapeByte() {
        const escape = this.text[this.index++];
        if (Object.hasOwn(LUA_ESCAPES, escape)) {
            return LUA_ESCAPES[escape];
        }
        if (escape === '\r' || escape === '\n') {
            if (escape === '\r' && this.text[this.index] === '\n') {
                this.index++;
            }
            return 10;
        }
        if (escape && /^[0-9]$/.test(escape)) {
            const byte = Number(escape + this.match(DECIMAL_ESCAPE));
            if (byte <= 255) {
                return byte;
            }
        }
        if (escape === 'x') {
            const hex = this.text.slice(this.index, this.index + 2);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                this.index += 2;
                return Number.parseInt(hex, 16);
            }
        }
        throw invalid();
    }

    quoted() {
        this.match(TRIVIA);
        const quote = this.text[this.index++];
        if (quote !== '"' && quote !== "'") {
            throw invalid();
        }
        const bytes = [];
        const start = this.index;
        let rawStart = start;
        while (this.index < this.text.length && this.index - start <= 4096) {
            const character = this.text[this.index++];
            if (character === quote || character === '\\') {
                bytes.push(...utf8Encoder.encode(this.text.slice(rawStart, this.index - 1)));
                if (character === quote) {
                    try {
                        return utf8Decoder.decode(Uint8Array.from(bytes));
                    } catch {
                        throw invalid('Die MUAZCO-Datei enthält ungültigen UTF-8-Text.');
                    }
                }
                bytes.push(this.escapeByte());
                rawStart = this.index;
            } else if (character === '\r' || character === '\n') {
                throw invalid();
            }
        }
        throw invalid();
    }

    table(readValue, limit, allowBareKeys = false) {
        this.expect('{');
        const values = new Map();
        while (!this.consume('}')) {
            if (values.size >= limit) {
                throw invalid('Die MUAZCO-Datei enthält zu viele Felder oder Aufträge.');
            }
            let key;
            if (this.consume('[')) {
                key = this.quoted();
                this.expect(']');
            } else if (allowBareKeys) {
                key = this.identifier();
            } else {
                throw invalid();
            }
            if (values.has(key)) {
                throw invalid('Die MUAZCO-Datei enthält einen doppelten Schlüssel.');
            }
            this.expect('=');
            values.set(key, readValue(key));
            if (!this.consume(',')) {
                this.expect('}');
                break;
            }
        }
        return values;
    }

    entry(requestId) {
        if (!ID.test(requestId) || requestId === '-') {
            throw invalid('Die MUAZCO-Datei enthält eine ungültige Auftrags-ID.');
        }
        const fields = this.table((key) => {
            switch (key) {
            case 'export':
            case 'sender':
            case 'senderGUID':
                return this.quoted();
            case 'characterGUID':
                return this.consume('nil') ? null : this.quoted();
            case 'receivedAt': {
                this.match(TRIVIA);
                const raw = this.match(INTEGER);
                const timestamp = Number(raw);
                if (timestamp < 1 || timestamp > 4_102_444_800) {
                    throw invalid('Ein Auftrag enthält eine ungültige Empfangszeit.');
                }
                return timestamp;
            }
            default:
                throw invalid('Die MUAZCO-Datei enthält ein unbekanntes Feld.');
            }
        }, 5, true);
        const exportCode = fields.get('export');
        const request = parsePrivateRequest(exportCode);
        const sender = fields.get('sender');
        const senderGUID = fields.get('senderGUID');
        const characterGUID = fields.get('characterGUID') ?? null;
        const receivedAt = fields.get('receivedAt');
        if (request.requestId !== requestId || !validName(sender, 255) || !PLAYER_GUID.test(senderGUID)
            || (request.action === 'SIGNUP' ? !PLAYER_GUID.test(characterGUID) : characterGUID !== null)
            || !receivedAt) {
            throw invalid('Ein Auftrag passt nicht zu seinem Eintrag im privaten Postfach.');
        }
        return { ...request, export: exportCode, sender, senderGUID, characterGUID, receivedAt };
    }

    read() {
        if (this.identifier() !== 'MUAZCOPrivateInbox') {
            throw invalid('Bitte die MUAZCO.lua des Empfangscharakters unter SavedVariables auswählen.');
        }
        this.expect('=');
        const entries = this.table((requestId) => this.entry(requestId), MAX_ENTRIES);
        this.match(TRIVIA);
        if (this.index !== this.text.length) {
            throw invalid('Nach dem privaten Postfach folgen unerwartete Daten.');
        }
        return [...entries.values()];
    }
}

export function parsePrivateInbox(text) {
    if (typeof text !== 'string') {
        throw invalid();
    }
    if (text.length > MAX_BYTES || utf8Encoder.encode(text).length > MAX_BYTES) {
        throw tooLarge();
    }
    return new SavedVariablesReader(text).read();
}

function requireInboxHandle(handle) {
    if (handle?.kind !== 'file' || handle.name !== FILE_NAME) {
        throw new PrivateInboxError('WRONG_FILE', 'Bitte die MUAZCO.lua des Empfangscharakters auswählen.');
    }
}

export async function pickPrivateInbox() {
    if (!globalThis.isSecureContext || typeof globalThis.showOpenFilePicker !== 'function') {
        throw new PrivateInboxError('UNSUPPORTED', 'Die Dateiauswahl braucht einen unterstützten Browser und eine sichere Seite.');
    }
    const [handle] = await globalThis.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'WoW SavedVariables', accept: { 'text/plain': ['.lua'] } }],
        excludeAcceptAllOption: true,
    });
    requireInboxHandle(handle);
    return handle;
}

async function readText(handle) {
    requireInboxHandle(handle);
    const file = await handle.getFile();
    if (file.size > MAX_BYTES) {
        throw tooLarge();
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
        throw tooLarge();
    }
    try {
        return utf8Decoder.decode(bytes);
    } catch {
        throw invalid('Die MUAZCO-Datei enthält ungültigen UTF-8-Text.');
    }
}

export async function readPrivateInbox(handle) {
    return parsePrivateInbox(await readText(handle));
}

export function watchPrivateInbox(handle, { onEntries, onError, intervalMs = 2000 }) {
    requireInboxHandle(handle);
    let active = true;
    let timer;
    let lastText;

    async function poll() {
        try {
            const text = await readText(handle);
            if (active && text !== lastText) {
                await onEntries(parsePrivateInbox(text));
                lastText = text;
            }
        } catch (error) {
            if (active) {
                lastText = undefined;
                onError?.(error);
            }
        } finally {
            if (active) {
                timer = setTimeout(poll, intervalMs);
            }
        }
    }

    void poll();
    return () => {
        active = false;
        clearTimeout(timer);
    };
}
