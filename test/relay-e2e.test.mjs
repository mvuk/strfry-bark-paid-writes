// End-to-end: a real strfry relay with the plugin as its write policy, a mock
// barkd, and a websocket client publishing signed events.
//
// Needs a strfry checkout in STRFRY_DIR with a built ./strfry binary and its
// test dependencies installed (cd $STRFRY_DIR/test && npm ci). The paid-reads
// case also needs a strfry build that has relay.auth.readAllowlistFile.
// Skips cleanly when STRFRY_DIR is not set or incomplete.
//
//   STRFRY_DIR=~/src/strfry npm run test:e2e

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.STRFRY_DIR ? path.resolve(process.env.STRFRY_DIR) : null;
const strfryBin = root && path.join(root, 'strfry');
const testDeps = root && path.join(root, 'test/node_modules/@nostr/tools/index.js');
const skip = !root ? 'set STRFRY_DIR to a built strfry checkout to run'
    : !fs.existsSync(strfryBin) ? `no strfry binary at ${strfryBin} (run make in STRFRY_DIR)`
    : !fs.existsSync(testDeps) ? `strfry test dependencies missing (cd ${root}/test && npm ci)` : false;

// Paid reads need relay.auth.readAllowlistFile, which stock strfry does not have yet.
// The config key name is compiled into the binary, so a string search is enough.
const hasReadAllowlist = () => fs.readFileSync(strfryBin).includes('readAllowlistFile');
const skipReads = skip || (hasReadAllowlist() ? false : 'this strfry build has no relay.auth.readAllowlistFile');

const { createMockBarkd } = createRequire(import.meta.url)('./mock-barkd.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('paid writes through a real strfry relay', { skip }, async (t) => {
    const { finalizeEvent } = await import(testDeps);
    const { openWebSocket, WsClient, waitForRelay } = await import(path.join(root, 'test/utils/websocketClient.js'));
    const { hexToBytes } = await import(path.join(root, 'test/utils/events.js'));
    const ids = JSON.parse(fs.readFileSync(path.join(root, 'test/utils/dummyIds.json'), 'utf8'));

    const mock = createMockBarkd();
    const barkdUrl = await mock.listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-paid-writes-e2e-'));
    fs.mkdirSync(path.join(dir, 'db'));
    const port = 40570 + Math.floor(Math.random() * 100);

    const wrapper = path.join(dir, 'plugin.sh');
    fs.writeFileSync(wrapper, [
        '#!/bin/sh',
        `export BARKD_URL=${barkdUrl} BARK_LEDGER=${dir}/ledger.json BARK_POLL_SECONDS=0.2 BARK_FREE_KINDS=0`,
        `exec ${process.execPath} ${path.join(here, '..', 'bark-paid-writes.js')}`,
        '',
    ].join('\n'), { mode: 0o755 });

    const conf = path.join(dir, 'strfry.conf');
    fs.writeFileSync(conf, `
db = "${dir}/db/"
relay {
  bind = "127.0.0.1"
  port = ${port}
  nofiles = 0
  writePolicy { plugin = "${wrapper}" }
}
`);

    const relay = spawn(strfryBin, ['--config', conf, 'relay'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    relay.stdout.on('data', (d) => logs += d);
    relay.stderr.on('data', (d) => logs += d);

    const wsUrl = `ws://127.0.0.1:${port}`;
    let client;
    t.after(async () => {
        if (client) await client.close();
        relay.kill('SIGTERM');
        await Promise.race([new Promise((r) => relay.once('exit', r)), sleep(2000)]);
        await mock.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await waitForRelay(wsUrl);
    client = new WsClient(await openWebSocket(wsUrl));

    let ts = Math.floor(Date.now() / 1000);
    const publish = async (kind, content) => {
        const ev = finalizeEvent({ kind, created_at: ts++, tags: [], content }, hexToBytes(ids[0].sec));
        client.send(['EVENT', ev]);
        const ok = await client.waitFor((m) => m[0] === 'OK' && m[1] === ev.id, 8000);
        return { ok: ok[2], msg: ok[3] };
    };

    try {
        const first = await publish(1, 'before paying');
        assert.equal(first.ok, false);
        assert.match(first.msg, /^restricted: payment required \(1 sat per event, balance 0 sat\)\. Send any amount over Ark to tark1mockaddress0/);

        assert.equal((await publish(0, '{"name":"free kind"}')).ok, true, 'free kind accepted');

        mock.receiveArk('tark1mockaddress0', 2);
        await sleep(600);

        assert.equal((await publish(1, 'paid 1')).ok, true);
        assert.equal((await publish(1, 'paid 2')).ok, true);
        assert.equal((await publish(1, 'out again')).ok, false);

        client.send(['REQ', 'r', { authors: [ids[0].pub], kinds: [1] }]);
        const msgs = await client.collectUntil((m) => m[0] === 'EOSE' && m[1] === 'r', 4000);
        assert.deepEqual(msgs.filter((m) => m[0] === 'EVENT').map((m) => m[2].content).sort(), ['paid 1', 'paid 2']);
    } catch (e) {
        e.message += `\n\nrelay logs:\n${logs}`;
        throw e;
    }
});

test('paid reads via relay.auth.readAllowlistFile', { skip: skipReads }, async (t) => {
    const { finalizeEvent } = await import(testDeps);
    const { openWebSocket, WsClient, waitForRelay } = await import(path.join(root, 'test/utils/websocketClient.js'));
    const { hexToBytes, signEvent } = await import(path.join(root, 'test/utils/events.js'));
    const ids = JSON.parse(fs.readFileSync(path.join(root, 'test/utils/dummyIds.json'), 'utf8'));

    const mock = createMockBarkd();
    const barkdUrl = await mock.listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-paid-reads-e2e-'));
    fs.mkdirSync(path.join(dir, 'db'));
    const port = 40680 + Math.floor(Math.random() * 100);
    const allowlist = path.join(dir, 'readers.txt');

    const wrapper = path.join(dir, 'plugin.sh');
    fs.writeFileSync(wrapper, [
        '#!/bin/sh',
        `export BARKD_URL=${barkdUrl} BARK_LEDGER=${dir}/ledger.json BARK_POLL_SECONDS=0.2 BARK_READ_ALLOWLIST=${allowlist}`,
        `exec ${process.execPath} ${path.join(here, '..', 'bark-paid-writes.js')}`,
        '',
    ].join('\n'), { mode: 0o755 });

    const conf = path.join(dir, 'strfry.conf');
    fs.writeFileSync(conf, `
db = "${dir}/db/"
relay {
  bind = "127.0.0.1"
  port = ${port}
  nofiles = 0
  auth { enabled = true
         serviceUrl = "wss://relay.test"
         readAllowlistFile = "${allowlist}" }
  writePolicy { plugin = "${wrapper}" }
}
`);

    const relay = spawn(strfryBin, ['--config', conf, 'relay'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    relay.stdout.on('data', (d) => logs += d);
    relay.stderr.on('data', (d) => logs += d);
    const wsUrl = `ws://127.0.0.1:${port}`;
    let client;
    t.after(async () => {
        if (client) await client.close();
        relay.kill('SIGTERM');
        await Promise.race([new Promise((r) => relay.once('exit', r)), sleep(2000)]);
        await mock.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await waitForRelay(wsUrl);
    client = new WsClient(await openWebSocket(wsUrl));

    try {
        client.send(['REQ', 'r1', { kinds: [1] }]);
        const challenge = (await client.waitFor((m) => m[0] === 'AUTH'))[1];
        assert.match((await client.waitFor((m) => m[0] === 'CLOSED' && m[1] === 'r1'))[2], /auth-required/);

        client.send(['AUTH', signEvent(challenge, 'wss://relay.test', ids[0].sec)]);
        assert.equal((await client.waitFor((m) => m[0] === 'OK', 8000))[2], true);

        // The first write starts the plugin and gets this pubkey its Ark address.
        const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' }, hexToBytes(ids[0].sec));
        client.send(['EVENT', ev]);
        assert.match((await client.waitFor((m) => m[0] === 'OK' && m[1] === ev.id, 8000))[3], /tark1mockaddress0/);

        client.send(['REQ', 'r2', { kinds: [1] }]);
        assert.match((await client.waitFor((m) => m[0] === 'CLOSED' && m[1] === 'r2'))[2], /restricted:/);

        mock.receiveArk('tark1mockaddress0', 10);
        await sleep(1800); // plugin poll + strfry's once-per-second file check

        client.send(['REQ', 'r3', { kinds: [1] }]);
        const msgs = await client.collectUntil((m) => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === 'r3', 4000);
        assert.equal(msgs.at(-1)[0], 'EOSE', 'paid pubkey can read');
    } catch (e) {
        e.message += `\n\nrelay logs:\n${logs}`;
        throw e;
    }
});
