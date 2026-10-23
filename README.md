# bark-paid-writes: metered writes paid over Ark or Lightning

A strfry write-policy plugin. Each pubkey has a prepaid balance, and each event
it writes costs a small fee. Users top up by sending sats to their own
per-pubkey Ark address, or by paying a Lightning invoice. Payments arrive in a
[bark](https://gitlab.com/ark-bitcoin/bark) wallet run by the relay operator
(`barkd`), and the plugin polls its REST API to credit them.

**Paid writes work on stock strfry.** The plugin uses the standard
[plugin interface](https://github.com/hoytech/strfry/blob/master/docs/plugins.md). It is Node.js (18 or newer) with no npm
dependencies.

## How it works

```
client ──EVENT──▶ strfry ──JSON line──▶ bark-paid-writes ──REST──▶ barkd ──▶ Ark server
       ◀──OK─────        ◀─accept/reject─        │
                                                 └── ledger.json (balances, addresses, invoices)
```

* **Charging.** Each event from a client connection (`sourceType` `IP4`/`IP6`)
  is debited from the payer's balance. Events from `strfry import`, `sync`,
  `stream` and `router` are free.
* **Who pays.** With `BARK_CHARGE=author` (the default), the event's `pubkey`
  pays. With `BARK_CHARGE=authed`, the NIP-42 authenticated pubkey pays, so
  one account can pay for events signed by other keys, and unauthenticated
  clients get `auth-required:`.
* **Out of credit.** The event is rejected with an `OK false` message such as:

  ```
  restricted: payment required (1 sat per event, balance 0 sat). Send any amount over Ark to
  tark1pem36…n8 or top up with Lightning at https://relay.example/topup; credit goes to pubkey aaaaaaaa…
  ```

  The Ark address is created for that pubkey the first time it is needed, and
  it is reused after that.
* **Crediting.** Every `BARK_POLL_SECONDS`, the plugin reads `GET /api/v1/history`
  from barkd. Any successful movement received on a pubkey's Ark address or on
  one of its invoices is credited once, keyed by the movement id. Lightning
  receives are credited with the amount that actually arrived (net of the Ark
  server's receive fee).
* **Lightning.** The optional top-up endpoint (`BARK_TOPUP_PORT`) creates
  invoices:

  ```
  GET /topup?pubkey=<64-hex>            -> { pubkey, balance_sat, fee_sat_per_event, fee_sat_by_kind, free_kinds, ark_address }
  GET /topup?pubkey=<64-hex>&sats=1000  -> same, plus "invoice": "lntbs10u1…"
  ```

  It binds to `127.0.0.1` by default. Put a small web page or a reverse proxy
  in front of it, and set `BARK_TOPUP_URL` to the public URL so that it shows
  up in reject messages.
* **Persistence.** Balances, address and invoice ownership, and the list of
  credited movements are kept in one JSON file (`BARK_LEDGER`), which is
  replaced atomically. Payments are written to disk immediately. Debits are
  written at most once per second. A lock file stops a second copy of the
  plugin, such as one started by `strfry stream` with the same config, from
  crediting the same payment twice. That copy lets non-client events through
  and rejects client writes.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `BARKD_URL` | `http://127.0.0.1:3000` | barkd REST base URL |
| `BARKD_TOKEN` | *(empty)* | barkd bearer token (`barkd secret show`) |
| `BARKD_TIMEOUT_MS` | `3000` | timeout per barkd call (keep it below strfry's `writePolicy.timeoutSeconds`) |
| `BARK_LEDGER` | `./bark-paid-writes-ledger.json` | ledger file (relative to strfry's working directory) |
| `BARK_FEE_SATS` | `1` | price per event; decimals allowed (`0.1`) |
| `BARK_KIND_FEES` | *(empty)* | per-kind prices, `kind:sats` comma list, e.g. `7:0.1, 30023:21` |
| `BARK_FREE_KINDS` | *(empty)* | kinds that are always free, e.g. `0, 3, 10002` |
| `BARK_FREE_PUBKEYS` | *(empty)* | hex pubkeys that never pay (operators, bots) |
| `BARK_CHARGE` | `author` | `author` or `authed` (see above) |
| `BARK_CHARGE_SOURCES` | `IP4,IP6` | strfry `sourceType`s that are charged |
| `BARK_POLL_SECONDS` | `10` | how often to look for new payments |
| `BARK_TOPUP_PORT` | *(unset: off)* | port for the top-up endpoint (`0` = any free port) |
| `BARK_TOPUP_HOST` | `127.0.0.1` | bind address for the top-up endpoint |
| `BARK_TOPUP_URL` | *(empty)* | public top-up URL to show in reject messages |
| `BARK_TOPUP_MAX_SATS` | `100000` | largest invoice the endpoint will create |
| `BARK_READ_ALLOWLIST` | *(empty: off)* | file to write for strfry's `relay.auth.readAllowlistFile` (see below) |
| `BARK_READ_MIN_SATS` | `1` | balance a pubkey needs to be listed as a reader |

strfry only reloads a plugin automatically when the command has no spaces. To
keep that behaviour, use a small wrapper script that sets the variables:

```sh
#!/bin/sh
export BARKD_URL=http://127.0.0.1:3000 BARKD_TOKEN=... BARK_FEE_SATS=1 BARK_FREE_KINDS=0,3,10002
exec node /path/to/strfry-bark-paid-writes/bark-paid-writes.js
```

## Paid reads (optional, needs `relay.auth.readAllowlistFile`)

**Paid reads need a strfry build with `relay.auth.readAllowlistFile`**, which
has been proposed upstream in STRFRY_PR_URL and is not in a strfry release
yet. Paid writes do not need it.

strfry's plugin interface only covers writes. `readAllowlistFile` adds read
gating to strfry: when it is set, every REQ, COUNT and
NEG-OPEN requires NIP-42 AUTH as a pubkey listed in that file. If you set
`BARK_READ_ALLOWLIST` to the same path, the plugin keeps the file up to date.
Pubkeys with at least `BARK_READ_MIN_SATS` of credit, plus `BARK_FREE_PUBKEYS`,
can read. strfry notices changes to the file within a second.

```
relay { auth { readAllowlistFile = "/var/lib/strfry/readers.txt" } }   # strfry.conf
BARK_READ_ALLOWLIST=/var/lib/strfry/readers.txt                        # plugin wrapper
```

Reading is not charged per query. Holding a balance is what grants access.
strfry starts the plugin on the first write, and until then the file does not
exist and all reads are refused. To avoid that, create the file with the
operator's pubkey beforehand.

## Try it on signet

1. **Run barkd** (from the [bark releases](https://gitlab.com/ark-bitcoin/bark/-/releases),
   or `cargo build --release --bin barkd` in a bark checkout):

   ```sh
   barkd --datadir ~/.barkd-relay &
   TOKEN=$(barkd --datadir ~/.barkd-relay secret show)
   curl -X POST localhost:3000/api/v1/wallet/create \
     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"network":"signet","ark_server":"https://ark.signet.2nd.dev",
          "chain_source":{"esplora":{"url":"https://esplora.signet.2nd.dev"}}}'
   ```

   (Recent barkd versions fill in the signet Ark server and esplora themselves,
   so `{"network":"signet"}` is enough there.)

2. **Point strfry at the plugin.** Use the wrapper script above, then in `strfry.conf` set:

   ```
   relay { writePolicy { plugin = "/path/to/bark-paid-writes-wrapper.sh" } }
   ```

3. **Post an event** with any client. It is rejected, and the message includes
   your Ark address.
4. **Pay.** Get signet sats from the [faucet](https://signet.2nd.dev). Then
   either send them to that address from any bark wallet
   (`bark send <tark1…> 100sat`), or fetch an invoice with
   `curl 'localhost:PORT/topup?pubkey=<hex>&sats=100'` and pay it over Lightning.
5. Within `BARK_POLL_SECONDS`, the strfry log shows
   `credited 100 sat to <pubkey>`. Your next 100 events are accepted.

## Tests

From this repository:

```sh
npm test
```

The tests start the plugin exactly as strfry does (one JSON line per event on
stdin), against a mock barkd (`test/mock-barkd.js`) whose responses copy the
bark-rest JSON shapes. They cover charging, per-kind and fractional prices,
free kinds and pubkeys, Ark and Lightning crediting (each payment credited
exactly once, pending payments ignored), `authed` mode, restarts, the lock,
barkd being down, bearer-token auth, and the read-allowlist file. No real
bitcoin is involved.

`test/relay-e2e.test.mjs` runs a real `strfry relay` with the plugin as
its write policy, then publishes signed events over a websocket: it checks
the reject message, a free kind, a payment, accepted writes, and a REQ that
returns exactly the paid events. A second case covers paid reads through
`readAllowlistFile`. Point `STRFRY_DIR` at a strfry checkout that has been
built (`make`) and has its test dependencies installed (`cd test && npm ci`).
The tests skip themselves without it:

```sh
STRFRY_DIR=/path/to/strfry npm run test:e2e
```

You can also feed events by hand:

```sh
node test/mock-barkd.js 3000 &
BARKD_URL=http://127.0.0.1:3000 ./bark-paid-writes.js < test/sample-events.jsonl
```

## Limitations

* The ledger is a JSON file, which suits a small relay. A busy relay would
  want sqlite.
* strfry still runs its own checks (expiry, deletions, replaceable-event
  ordering) after the plugin says `accept`, so in rare cases an event is
  charged but not stored.
* With `BARK_CHARGE=author`, anyone can re-post your already-signed events
  from other relays and spend your credit on them. Each event can only be
  charged once, and only on your own real events. Use `authed` if this
  matters.
* Polling reads the whole wallet history each time. barkd's notification
  stream (`/api/v1/notifications`) would avoid that.
* Read gating needs a strfry build with `relay.auth.readAllowlistFile`
  (STRFRY_PR_URL).
  Subscriptions that are already open keep running when a pubkey drops off
  the list. Only new REQs are checked.
