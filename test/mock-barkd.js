// A fake barkd that serves the three REST calls the plugin uses, with
// response shapes copied from bark-rest (bark-json). Tests drive it directly:
// `mock.receiveArk(address, sats)`, `mock.settleInvoice(invoice)`, etc.
//
// Run standalone for manual testing:  node test/mock-barkd.js [port]
// then add a payment:                 curl -X POST 'localhost:PORT/_mock/pay?address=tark1...&sats=5'

'use strict';

const http = require('http');

function createMockBarkd({ token = '' } = {}) {
    const state = {
        nextAddress: 0,
        nextMovement: 1,
        movements: [],       // newest first, like barkd
        invoices: {},        // invoice -> { amount_sat, description }
        calls: [],           // "METHOD /path" log for assertions
        down: false,
    };

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const reply = (code, obj) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(obj));
            };

            // test-only control endpoint (for manual runs)
            if (u.pathname === '/_mock/pay' && req.method === 'POST') {
                return reply(200, mock.receiveArk(u.searchParams.get('address'), parseInt(u.searchParams.get('sats'), 10)));
            }

            state.calls.push(`${req.method} ${u.pathname}`);
            if (state.down) return reply(503, { message: 'wallet not loaded' });
            if (token && req.headers['authorization'] !== `Bearer ${token}`) return reply(401, { message: 'unauthorized' });

            if (req.method === 'POST' && u.pathname === '/api/v1/wallet/addresses/next') {
                return reply(200, { address: `tark1mockaddress${state.nextAddress++}` });
            }
            if (req.method === 'POST' && u.pathname === '/api/v1/lightning/receives/invoice') {
                const b = JSON.parse(body);
                const invoice = `lntbs${b.amount_sat}mock${Object.keys(state.invoices).length}`;
                state.invoices[invoice] = { amount_sat: b.amount_sat, description: b.description };
                return reply(200, { invoice });
            }
            if (req.method === 'GET' && u.pathname === '/api/v1/history') {
                return reply(200, state.movements);
            }
            reply(404, { message: 'not found' });
        });
    });

    const movement = (status, type, value, sats, subsystem) => {
        const m = {
            id: state.nextMovement++,
            status,
            subsystem: { name: subsystem, kind: 'receive' },
            intended_balance_sat: sats,
            effective_balance_sat: sats,
            offchain_fee_sat: 0,
            sent_to: [],
            received_on: [{ destination: { type, value }, amount_sat: sats }],
            input_vtxos: [],
            output_vtxos: ['00'.repeat(32) + ':0'],
            exited_vtxos: [],
            time: { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null },
        };
        state.movements.unshift(m);
        return m;
    };

    const mock = {
        state,
        server,
        listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise((r) => server.close(r)),
        receiveArk: (address, sats, status = 'successful') => movement(status, 'ark', address, sats, 'bark.arkoor'),
        settleInvoice: (invoice, feeSats = 0) => {
            const inv = state.invoices[invoice];
            if (!inv) throw new Error(`unknown invoice ${invoice}`);
            return movement('successful', 'invoice', invoice, inv.amount_sat - feeSats, 'bark.lightning_receive');
        },
    };
    return mock;
}

module.exports = { createMockBarkd };

if (require.main === module) {
    const mock = createMockBarkd();
    mock.server.listen(parseInt(process.argv[2] || '3000', 10), '127.0.0.1', () => {
        console.log(`mock barkd on http://127.0.0.1:${mock.server.address().port}`);
    });
}
