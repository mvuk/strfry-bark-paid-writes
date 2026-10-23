// Black-box tests: spawn the plugin exactly as strfry would, feed it JSONL
// requests on stdin, and check the JSONL replies. barkd is a local mock.
//
//   node --test plugins/bark-paid-writes/test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBarkd } = require('./mock-barkd.js');

const PLUGIN = path.join(__dirname, '..', 'bark-paid-writes.js');
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);

let seq = 0;
function req(pubkey, { kind = 1, sourceType = 'IP4', authed } = {}) {
    const id = (++seq).toString(16).padStart(64, '0');
    const r = {
        type: 'new',
        event: { id, pubkey, created_at: 1760000000, kind, tags: [], content: 'hi', sig: 'f'.repeat(128) },
        receivedAt: 1760000000,
        sourceType,
        sourceInfo: sourceType.startsWith('IP') ? '127.0.0.1' : 'test',
    };
    if (authed) r.authed = authed;
    return r;
}

function startPlugin(env) {
    const child = spawn(process.execPath, [PLUGIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.env = env;
    let out = '';
    let waiters = [];
    child.stderrText = '';
    child.stderr.on('data', (d) => child.stderrText += d);
    child.stdout.on('data', (d) => {
        out += d;
        let nl;
        while ((nl = out.indexOf('\n')) >= 0 && waiters.length) {
            const line = out.slice(0, nl);
            out = out.slice(nl + 1);
            waiters.shift()(JSON.parse(line));
        }
    });
    child.send = (r) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply for ${r.event.id}\nstderr:\n${child.stderrText}`)), 5000);
        waiters.push((res) => { clearTimeout(t); assert.equal(res.id, r.event.id, 'reply must echo the event id'); resolve(res); });
        child.stdin.write(JSON.stringify(r) + '\n');
    });
    child.stop = () => new Promise((resolve) => { child.on('exit', resolve); child.stdin.end(); });
    return child;
}

function dir0(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-paid-writes-read-'));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(50);
    }
    throw new Error('condition not met in time');
}

async function setup(t, extraEnv = {}, mockOpts = {}) {
    const mock = createMockBarkd(mockOpts);
    const url = await mock.listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-paid-writes-'));
    const env = { BARKD_URL: url, BARK_LEDGER: path.join(dir, 'ledger.json'), BARK_POLL_SECONDS: '0.1', ...extraEnv };
    const plugin = startPlugin(env);
    t.after(async () => {
        if (plugin.exitCode === null) await plugin.stop();
        await mock.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { mock, plugin, env, dir };
}


test('events from import/sync/stream are not charged', async (t) => {
    const { plugin } = await setup(t);
    for (const sourceType of ['Import', 'Sync', 'Stream', 'Stored']) {
        assert.equal((await plugin.send(req(ALICE, { sourceType }))).action, 'accept');
    }
});

test('out of credit: reject with restricted: and a reusable per-pubkey Ark address', async (t) => {
    const { plugin, mock } = await setup(t);
    const r1 = await plugin.send(req(ALICE));
    assert.equal(r1.action, 'reject');
    assert.match(r1.msg, /^restricted: payment required \(1 sat per event, balance 0 sat\)\. Send any amount over Ark to tark1mockaddress0/);

    const r2 = await plugin.send(req(ALICE));
    assert.match(r2.msg, /tark1mockaddress0/, 'same address on the second rejection');
    const r3 = await plugin.send(req(BOB));
    assert.match(r3.msg, /tark1mockaddress1/, 'different pubkey, different address');
    assert.equal(mock.state.calls.filter((c) => c === 'POST /api/v1/wallet/addresses/next').length, 2);
});

test('arkoor payment to the pubkey address buys exactly that many events', async (t) => {
    const { plugin, mock } = await setup(t);
    await plugin.send(req(ALICE)); // allocates tark1mockaddress0
    mock.receiveArk('tark1mockaddress0', 3);
    await waitFor(() => /credited 3 sat/.test(plugin.stderrText));

    for (let i = 0; i < 3; i++) assert.equal((await plugin.send(req(ALICE))).action, 'accept');
    const r = await plugin.send(req(ALICE));
    assert.equal(r.action, 'reject');
    assert.match(r.msg, /balance 0 sat/);
    assert.equal((await plugin.send(req(BOB))).action, 'reject', "Alice's payment does not credit Bob");
});

test('pending movements are ignored; each movement is credited once', async (t) => {
    const { plugin, mock } = await setup(t);
    await plugin.send(req(ALICE));
    const m = mock.receiveArk('tark1mockaddress0', 2, 'pending');
    mock.receiveArk('tark1someoneelse', 50); // not ours: ignored
    await sleep(400);
    assert.equal((await plugin.send(req(ALICE))).action, 'reject');

    m.status = 'successful';
    await waitFor(() => /credited 2 sat/.test(plugin.stderrText));
    await sleep(400); // several more polls see the same movement
    assert.equal(plugin.stderrText.match(/credited/g).length, 1);
    assert.equal((await plugin.send(req(ALICE))).action, 'accept');
    assert.equal((await plugin.send(req(ALICE))).action, 'accept');
    assert.equal((await plugin.send(req(ALICE))).action, 'reject');
});

test('Lightning top-up via the local endpoint credits the net amount received', async (t) => {
    const { plugin, mock } = await setup(t, { BARK_TOPUP_PORT: '0', BARK_TOPUP_URL: 'https://relay.example/topup' });
    await waitFor(() => /top-up endpoint on (\S+)/.test(plugin.stderrText));
    const endpoint = plugin.stderrText.match(/top-up endpoint on (\S+)/)[1];

    const bad = await fetch(`${endpoint}?pubkey=nothex`);
    assert.equal(bad.status, 400);

    const res = await (await fetch(`${endpoint}?pubkey=${CAROL}&sats=10`)).json();
    assert.equal(res.pubkey, CAROL);
    assert.equal(res.balance_sat, 0);
    assert.match(res.ark_address, /^tark1mock/);
    assert.match(res.invoice, /^lntbs10mock/);
    assert.equal(mock.state.invoices[res.invoice].description, `relay credit for ${CAROL}`);

    const rej = await plugin.send(req(CAROL));
    assert.match(rej.msg, / or top up with Lightning at https:\/\/relay\.example\/topup; credit goes to pubkey cccccccc/);

    mock.settleInvoice(res.invoice, 2); // server keeps a 2 sat receive fee
    await waitFor(() => /credited 8 sat/.test(plugin.stderrText));
    const after = await (await fetch(`${endpoint}?pubkey=${CAROL}`)).json();
    assert.equal(after.balance_sat, 8);
    assert.equal(after.invoice, undefined);
});

test("BARK_CHARGE=authed charges the NIP-42 pubkey and asks unauthenticated clients to auth", async (t) => {
    const { plugin, mock } = await setup(t, { BARK_CHARGE: 'authed' });
    const r = await plugin.send(req(ALICE));
    assert.equal(r.action, 'reject');
    assert.match(r.msg, /^auth-required: /);

    await plugin.send(req(ALICE, { authed: BOB })); // allocates Bob's address
    mock.receiveArk('tark1mockaddress0', 1);
    await waitFor(() => /credited 1 sat to b{64}/.test(plugin.stderrText));
    assert.equal((await plugin.send(req(ALICE, { authed: BOB }))).action, 'accept', 'Bob pays for an event signed by Alice');
});

test('free kinds, free pubkeys and fractional prices', async (t) => {
    const { plugin, mock } = await setup(t, { BARK_FREE_KINDS: '0, 10002', BARK_FREE_PUBKEYS: BOB, BARK_FEE_SATS: '0.5' });
    assert.equal((await plugin.send(req(ALICE, { kind: 0 }))).action, 'accept');
    assert.equal((await plugin.send(req(ALICE, { kind: 10002 }))).action, 'accept');
    assert.equal((await plugin.send(req(BOB))).action, 'accept');

    const r = await plugin.send(req(ALICE));
    assert.match(r.msg, /0\.5 sat per event/);
    mock.receiveArk('tark1mockaddress0', 1);
    await waitFor(() => /credited 1 sat/.test(plugin.stderrText));
    assert.equal((await plugin.send(req(ALICE))).action, 'accept');
    assert.equal((await plugin.send(req(ALICE))).action, 'accept');
    assert.equal((await plugin.send(req(ALICE))).action, 'reject');
});

test('ledger survives a restart, and a second copy cannot charge against it', async (t) => {
    const { plugin, mock, env } = await setup(t);
    await plugin.send(req(ALICE));
    mock.receiveArk('tark1mockaddress0', 5);
    await waitFor(() => /credited 5 sat/.test(plugin.stderrText));
    await plugin.send(req(ALICE)); // 4 left

    // A second copy (e.g. `strfry stream` using the same config) while the first is running.
    const second = startPlugin(env);
    assert.equal((await second.send(req(ALICE, { sourceType: 'Stream' }))).action, 'accept');
    const r = await second.send(req(ALICE));
    assert.deepEqual([r.action, r.msg], ['reject', 'error: payment ledger unavailable']);
    await second.stop();

    await plugin.stop(); // flushes the batched debit and releases the lock
    const ledger = JSON.parse(fs.readFileSync(env.BARK_LEDGER, 'utf8'));
    assert.equal(ledger.balances[ALICE], 4000);

    const again = startPlugin(env);
    t.after(() => again.exitCode === null && again.stop());
    for (let i = 0; i < 4; i++) assert.equal((await again.send(req(ALICE))).action, 'accept');
    const r2 = await again.send(req(ALICE));
    assert.equal(r2.action, 'reject');
    assert.match(r2.msg, /tark1mockaddress0/, 'address kept across restarts');
    await sleep(300);
    assert.doesNotMatch(again.stderrText, /credited/, 'old movement not credited twice after restart');
});

test('barkd down: still answers every event, with a message and no address', async (t) => {
    const { plugin, mock } = await setup(t);
    mock.state.down = true;
    const r = await plugin.send(req(ALICE));
    assert.equal(r.action, 'reject');
    assert.equal(r.msg, 'restricted: payment required (1 sat per event, balance 0 sat).');
    mock.state.down = false;
    assert.match((await plugin.send(req(ALICE))).msg, /tark1mockaddress0/);
});

test('sends the barkd bearer token', async (t) => {
    const { plugin } = await setup(t, { BARKD_TOKEN: 'secret-token' }, { token: 'secret-token' });
    assert.match((await plugin.send(req(ALICE))).msg, /tark1mockaddress0/);
});

test('wrong barkd token is logged, not fatal', async (t) => {
    const { plugin } = await setup(t, { BARKD_TOKEN: 'wrong' }, { token: 'secret-token' });
    const r = await plugin.send(req(ALICE));
    assert.equal(r.action, 'reject');
    assert.match(plugin.stderrText, /HTTP 401/);
});

test('sample-events.jsonl gets one reply per line', async (t) => {
    const { plugin } = await setup(t);
    const lines = fs.readFileSync(path.join(__dirname, 'sample-events.jsonl'), 'utf8').trim().split('\n');
    for (const line of lines) {
        const r = JSON.parse(line);
        const res = await plugin.send(r);
        assert.ok(['accept', 'reject'].includes(res.action));
    }
});

test('per-kind prices override the default', async (t) => {
    const { plugin, mock } = await setup(t, { BARK_FEE_SATS: '1', BARK_KIND_FEES: '7:0.1, 30023:5' });
    const r = await plugin.send(req(ALICE, { kind: 30023 }));
    assert.match(r.msg, /^restricted: payment required \(5 sat per kind 30023 event, balance 0 sat\)/);
    mock.receiveArk('tark1mockaddress0', 6);
    await waitFor(() => /credited 6 sat/.test(plugin.stderrText));
    assert.equal((await plugin.send(req(ALICE, { kind: 30023 }))).action, 'accept'); // 1 sat left
    for (let i = 0; i < 10; i++) assert.equal((await plugin.send(req(ALICE, { kind: 7 }))).action, 'accept'); // 10 x 0.1
    assert.equal((await plugin.send(req(ALICE, { kind: 7 }))).action, 'reject');
});

test('bad BARK_KIND_FEES makes the plugin exit with a clear error', async () => {
    const child = spawn(process.execPath, [PLUGIN], { env: { ...process.env, BARK_KIND_FEES: 'seven:1' } });
    let err = '';
    child.stderr.on('data', (d) => err += d);
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1);
    assert.match(err, /bad BARK_KIND_FEES entry 'seven:1'/);
});

test('BARK_READ_ALLOWLIST lists pubkeys with enough credit, plus free pubkeys', async (t) => {
    const { plugin, mock } = await setup(t, { BARK_READ_ALLOWLIST: path.join(dir0(t), 'read.txt'), BARK_FREE_PUBKEYS: BOB, BARK_READ_MIN_SATS: '2' });
    const file = plugin.env.BARK_READ_ALLOWLIST;
    const keys = () => fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}$/.test(l));

    await waitFor(() => fs.existsSync(file));
    assert.deepEqual(keys(), [BOB]);

    await plugin.send(req(ALICE));
    mock.receiveArk('tark1mockaddress0', 3);
    await waitFor(() => keys().includes(ALICE));
    assert.deepEqual(keys(), [ALICE, BOB]);

    await plugin.send(req(ALICE)); // 2 left: still a reader
    await plugin.send(req(ALICE)); // 1 left: below BARK_READ_MIN_SATS
    await waitFor(() => !keys().includes(ALICE));
    assert.deepEqual(keys(), [BOB]);
});
