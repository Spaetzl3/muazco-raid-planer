import { mountPrivateSyncUI } from './private-sync-ui.mjs';

const rejectionMessages = Object.freeze({
    raid_closed: 'Der Raid ist geschlossen.',
    identity_mismatch: 'Der Charakter ist keinem freigegebenen Mitglied eindeutig zugeordnet.',
    revision_conflict: 'Die Anmeldung wurde zwischenzeitlich geändert.',
    slot_full: 'Für diese Rolle ist kein Platz mehr frei.',
    no_signup: 'Für diesen Raid besteht keine aktive Anmeldung.',
    character_conflict: 'Für diesen Raid gibt es bereits einen Eintrag mit diesem Charakternamen.',
    invalid_request: 'Der Planer hat die Anmeldedaten abgelehnt.',
});

function syncError(message) {
    const error = new Error(message);
    error.publicMessage = message;
    return error;
}

export async function uploadPrivateRequests(db, entries, { leaderId, requireLeader, signal }) {
    signal?.throwIfAborted();
    if (!leaderId || !await requireLeader()) {
        throw syncError('Für den privaten Abgleich ist eine aktive Raidleitungs-Sitzung erforderlich.');
    }

    const results = [];
    for (const entry of entries) {
        signal?.throwIfAborted();
        const query = db.rpc('submit_muazco_addon_request', {
            p_expected_leader_id: leaderId,
            p_request_id: entry.requestId,
            p_sender_guid: entry.senderGUID,
            p_character_guid: entry.characterGUID,
            p_payload: entry.export,
        });
        const { data, error } = await (signal && typeof query.abortSignal === 'function' ? query.abortSignal(signal) : query);
        if (error?.code === 'PGRST202' || error?.code === '42883') {
            throw syncError('Die private Schnittstelle ist in diesem Planer noch nicht eingerichtet.');
        }
        if (error || data?.request_id !== entry.requestId || typeof data.replayed !== 'boolean'
            || !['accepted', 'rejected'].includes(data.status)) {
            throw syncError('Der Planer konnte die Übertragung nicht bestätigen. Der Abgleich versucht es erneut.');
        }
        const rejected = data.status === 'rejected';
        results.push({
            requestId: entry.requestId,
            status: rejected ? 'rejected' : data.replayed ? 'duplicate' : 'accepted',
            message: rejected && Object.hasOwn(rejectionMessages, data.reason)
                ? rejectionMessages[data.reason] : undefined,
        });
    }
    return { results };
}

export function createRomanPrivateSync({ container, db, verifyLeader, refreshData, fileOptions }) {
    let userId;
    let panel;

    function setLeader(nextUserId) {
        if (nextUserId === userId) return;

        panel?.destroy();
        panel = undefined;
        userId = nextUserId;
        container.classList.toggle('hidden', !userId);
        if (!userId) return;

        const session = userId;
        panel = mountPrivateSyncUI(container, {
            ...fileOptions,
            async uploadEntries(entries, { signal } = {}) {
                const result = await uploadPrivateRequests(db, entries, {
                    leaderId: session,
                    requireLeader: async () => userId === session && await verifyLeader(session) && userId === session,
                    signal,
                });
                if (userId === session && !signal?.aborted) await refreshData();
                return result;
            },
        });
    }

    return { setLeader };
}
