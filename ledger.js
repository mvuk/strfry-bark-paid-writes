// Per-pubkey credit ledger, kept in one JSON file.
//
// Amounts are stored in millisats so that sub-sat prices per event work.
// The file is replaced atomically (write temp file, then rename). Credits and
// new payment targets are written immediately; debits are batched (at most
// one write per `debitFlushMs`), so a crash can lose a second of charges but
// never a payment.
//
// A JSON file is fine for a small relay. A busy relay would want sqlite or
// LMDB instead; only this file would need to change.

'use strict';

const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
    version: 1,
    balances: {},        // pubkey -> msat
    addressOwner: {},    // Ark address -> pubkey
    pubkeyAddress: {},   // pubkey -> Ark address
    invoiceOwner: {},    // BOLT11 invoice -> { pubkey, createdAt }
    credited: {},        // barkd movement id -> { pubkey, msat, at }  (audit trail, prevents double credit)
});

class Ledger {
    constructor(file, { debitFlushMs = 1000 } = {}) {
        this.file = path.resolve(file);
        this.lockFile = this.file + '.lock';
        this.debitFlushMs = debitFlushMs;
        this.timer = null;
        this.data = EMPTY();
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.data = Object.assign(EMPTY(), parsed);
        } catch (e) {
            if (e.code !== 'ENOENT') throw new Error(`cannot read ledger ${this.file}: ${e.message}`);
        }
    }

    // Only one process may own the ledger, or two pollers would credit the
    // same payment twice. strfry runs one write-policy plugin per relay, but
    // `strfry stream`/`strfry sync` start their own copy with the same config.
    acquireLock() {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fd = fs.openSync(this.lockFile, 'wx');
                fs.writeSync(fd, String(process.pid));
                fs.closeSync(fd);
                this.locked = true;
                return true;
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
                const pid = parseInt(fs.readFileSync(this.lockFile, 'utf8'), 10);
                if (pid && isAlive(pid)) return false;
                fs.rmSync(this.lockFile, { force: true }); // stale lock
            }
        }
        return false;
    }

    releaseLock() {
        if (!this.locked) return;
        try {
            if (parseInt(fs.readFileSync(this.lockFile, 'utf8'), 10) === process.pid) fs.rmSync(this.lockFile);
        } catch (e) { /* already gone */ }
        this.locked = false;
    }

    balance(pubkey) {
        return this.data.balances[pubkey] || 0;
    }

    // Returns true and debits if the balance covers `msat`.
    tryDebit(pubkey, msat) {
        const bal = this.balance(pubkey);
        if (bal < msat) return false;
        this.data.balances[pubkey] = bal - msat;
        this.scheduleFlush();
        return true;
    }

    // Credit once per barkd movement id. Returns false if already credited.
    credit(movementKey, pubkey, msat) {
        if (this.data.credited[movementKey]) return false;
        this.data.credited[movementKey] = { pubkey, msat, at: Math.floor(Date.now() / 1000) };
        this.data.balances[pubkey] = this.balance(pubkey) + msat;
        this.flush();
        return true;
    }

    addressFor(pubkey) {
        return this.data.pubkeyAddress[pubkey];
    }

    setAddress(pubkey, address) {
        this.data.pubkeyAddress[pubkey] = address;
        this.data.addressOwner[address] = pubkey;
        this.flush();
    }

    addInvoice(invoice, pubkey) {
        this.data.invoiceOwner[invoice] = { pubkey, createdAt: Math.floor(Date.now() / 1000) };
        this.flush();
    }

    ownerOf(type, value) {
        if (type === 'ark') return this.data.addressOwner[value];
        if (type === 'invoice') return this.data.invoiceOwner[value]?.pubkey;
        return undefined;
    }

    scheduleFlush() {
        if (this.timer) return;
        this.timer = setTimeout(() => this.flush(), this.debitFlushMs);
        this.timer.unref();
    }

    flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const tmp = `${this.file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
    }
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { Ledger };
