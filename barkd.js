// Minimal client for the barkd REST API (bark-rest, /api/v1).
//
// Only the three calls this plugin needs are wrapped. Anything with the same
// method names can stand in for it (the tests run against a mock HTTP server).
//
//   newArkAddress()               POST /api/v1/wallet/addresses/next
//   createInvoice(sats, memo)     POST /api/v1/lightning/receives/invoice
//   history()                     GET  /api/v1/history

'use strict';

class BarkdClient {
    constructor({ url, token, timeoutMs = 3000 }) {
        if (!url) throw new Error('barkd url is required');
        this.url = url.replace(/\/+$/, '');
        this.token = token || '';
        this.timeoutMs = timeoutMs;
    }

    async request(method, path, body) {
        const headers = { 'accept': 'application/json' };
        if (this.token) headers['authorization'] = `Bearer ${this.token}`;
        if (body !== undefined) headers['content-type'] = 'application/json';

        const res = await fetch(this.url + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
        });

        const text = await res.text();
        if (!res.ok) throw new Error(`barkd ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
        return text ? JSON.parse(text) : null;
    }

    // Returns a fresh Ark address string from the wallet's HD keychain.
    async newArkAddress() {
        const r = await this.request('POST', '/api/v1/wallet/addresses/next');
        return r.address;
    }

    // Returns a BOLT11 invoice string. The amount received after the Ark
    // server's Lightning receive fee is what ends up in history.
    async createInvoice(amountSat, description) {
        const r = await this.request('POST', '/api/v1/lightning/receives/invoice', {
            amount_sat: amountSat,
            description,
        });
        return r.invoice;
    }

    // Returns all wallet movements, newest first. Each has
    // { id, status, received_on: [{ destination: { type, value }, amount_sat }], ... }
    async history() {
        return this.request('GET', '/api/v1/history');
    }
}

module.exports = { BarkdClient };
