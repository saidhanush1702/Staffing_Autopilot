/**
 * ── TALKING TO THE HUB ────────────────────────────────────────────────
 *
 * Every authenticated call carries three headers:
 *
 *   Authorization: Device <token>    who we are
 *   X-Machine-Fingerprint            which machine        (R-21)
 *   X-App-Version                    what is running
 *
 * ── 401 IS NOT AN ERROR, IT IS AN INSTRUCTION ─────────────────────────
 *
 * The hub answers 401 when a device is revoked, when the consultant is no longer
 * active, or when the token is presented from a different machine. In every one
 * of those cases the correct response is the same and it is not a retry: stop,
 * delete everything held locally, and go back to the activation screen.
 *
 * That is the whole of R-21's "revocable instantly … which kills the app
 * immediately". There is no push channel and nothing to keep in sync — the next
 * call simply fails, which is at most one heartbeat away.
 */
const axios = require('axios');
const { HUB_URL, APP_VERSION } = require('./config.js');

class Revoked extends Error {
    constructor(message) {
        super(message ?? 'This device is no longer authorised.');
        this.name = 'Revoked';
    }
}

class HubClient {
    /**
     * @param onRevoked called once when the hub refuses this device. The caller
     *   wipes local state; doing it in here would put policy in a transport.
     */
    constructor({ getToken, fingerprint, onRevoked, baseURL = HUB_URL }) {
        this.getToken = getToken;
        this.fingerprint = fingerprint;
        this.onRevoked = onRevoked;
        this.http = axios.create({ baseURL, timeout: 20_000 });
    }

    #headers() {
        const token = this.getToken();
        if (!token) throw new Revoked('This device has not been activated.');
        return {
            Authorization: `Device ${token}`,
            'X-Machine-Fingerprint': this.fingerprint,
            'X-App-Version': APP_VERSION,
        };
    }

    async #call(method, path, body) {
        try {
            const res = await this.http.request({
                method, url: path, data: body, headers: this.#headers(),
            });
            return res.data;
        } catch (err) {
            if (err instanceof Revoked) throw err;
            const status = err.response?.status;
            if (status === 401) {
                const reason = err.response?.data?.error;
                this.onRevoked?.(reason);
                throw new Revoked(reason);
            }
            // Everything else is surfaced with the hub's own words where it gave
            // any: a 409 from the state machine is actionable, "Request failed
            // with status code 409" is not.
            throw new Error(err.response?.data?.error ?? err.message);
        }
    }

    /** The only unauthenticated call. Trades a one-time code for a token. */
    async activate({ activationCode, machineFingerprint, machineLabel }) {
        try {
            const { data } = await this.http.post('/device/activate', {
                activationCode, machineFingerprint, machineLabel, appVersion: APP_VERSION,
            });
            return data;
        } catch (err) {
            throw new Error(err.response?.data?.error ?? err.message);
        }
    }

    heartbeat() { return this.#call('get', '/device/heartbeat'); }
    queue() { return this.#call('get', '/device/queue'); }

    lease(id) { return this.#call('post', `/device/queue/${id}/lease`); }
    filled(id, body) { return this.#call('post', `/device/queue/${id}/filled`, body ?? {}); }
    parked(id, body) { return this.#call('post', `/device/queue/${id}/parked`, body); }
    skipped(id, body) { return this.#call('post', `/device/queue/${id}/skipped`, body); }
    reclassify(id, body) { return this.#call('post', `/device/queue/${id}/reclassify`, body ?? {}); }
    submitted(id, body) { return this.#call('post', `/device/queue/${id}/submitted`, body); }
    boardStatus(body) { return this.#call('post', '/device/board-status', body); }

    /** Used by the outbox drainer, which already knows the path and body. */
    post(path, body) { return this.#call('post', path, body); }
}

module.exports = { HubClient, Revoked };
