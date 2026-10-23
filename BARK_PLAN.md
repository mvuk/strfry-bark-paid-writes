# Bark × strfry: plan

**Goal:** a strfry operator can charge for relay use with instant, small
payments. Users pay over Ark (arkoor) or Lightning, into a Bark wallet that
the operator runs. This gives the relay spam resistance (every write costs
something) and an income that does not depend on ads or a single patron.

Status: phases 1 and 2a are done and tested. The rest is
proposed work.

## Phase 1: paid writes (done, plugin only)

This repository uses strfry's write-policy interface, so it works on stock
strfry.

- A per-pubkey prepaid ledger, stored in millisats in a JSON file with
  atomic replace and a lock file.
- Prices: a default per event, overrides per kind, free kinds, free pubkeys,
  and fractional sats.
- Payer: the event author, or the NIP-42 authed pubkey (`BARK_CHARGE=authed`).
- Payment instructions in the `OK false` message: a per-pubkey Ark address,
  and optionally a Lightning top-up URL.
- Crediting: the plugin polls barkd `GET /api/v1/history`. A successful
  movement received on a known Ark address or invoice is credited once, keyed
  by movement id.
- Tests: 15 unit tests against a mock barkd, and 2 end-to-end tests against
  a real `strfry relay`.
- A smoke test against a real barkd 0.7.1 on signet (wallet created on
  `ark.signet.2nd.dev`) got a real `tark1…` address in the reject message
  and a real BOLT11 from `/topup`. No payment was made in that test.

## Phase 2: read gating

**2a (done, proposed upstream in https://github.com/hoytech/strfry/pull/279):** `relay.auth.readAllowlistFile`. When it is
set, REQ, COUNT and NEG-OPEN require AUTH as a listed pubkey. It adds about
30 lines in the ingester plus `src/ReadAllowlist.h`, and does nothing when
empty. The plugin writes the file from balances (`BARK_READ_ALLOWLIST`).
This gives "pay to read" as a membership: a positive balance means access.
Upstream has asked for read policy before
([#48](https://github.com/hoytech/strfry/issues/48)). Doug said a read plugin
would add too much latency per REQ but that he would accept a zero-cost-when-off
change. A file with an mtime check costs nothing per request, which is why
it was chosen over a plugin call.

**2b (open):** metered reads, meaning a charge per REQ or per event served.
Options:
- A websocket proxy in front of strfry (similar to nerostr's setup). It can
  count events sent per connection and debit the authed pubkey, with no
  strfry change. Costs: an extra hop, and the proxy has to understand
  NIP-42 itself.
- A "read-policy plugin" in strfry core, asynchronous and batched, to meet
  Doug's latency concern. This is a larger change and needs agreement with
  upstream first.
- Recommendation: stay with the membership model (2a) until operators ask
  for metered reads.

**Gaps in 2a:** subscriptions that are already open are not cut off when a
pubkey loses access, and access is all or nothing (per-kind read lists would
be a natural extension).

## Phase 3: pricing and subscriptions

- Time-based plans (for example 1,000 sat per 30 days), stored as
  `paidUntil` per pubkey next to the balance. Writes and reads are free while
  the plan is active.
- Pricing by size (sats per KB) for large kinds such as 30023 long-form and
  1063 file metadata.
- Publish prices in NIP-11 `fees` (`admission`, `subscription`,
  `publication`) and set `limitation.payment_required`, so clients can show
  prices before posting. This needs the plugin to feed values into strfry's
  NIP-11 config, or a documented manual step.
- A top-up page: a static HTML page in front of `/topup` that shows the Ark
  address, a BOLT11 QR code and the balance. Optionally use barkd's `bip321`
  endpoint to give one unified QR code.
- Swap JSON for sqlite once relays have more than about 10k pubkeys.
- Replace polling with barkd's notification stream (`/api/v1/notifications`,
  websocket), so credits arrive in under a second.

## Phase 4: zaps

- Accept NIP-57 zaps to the relay's own pubkey or to a relay npub as
  credit for the sender. The zap receipt (kind 9735) identifies the payer.
  barkd would need a way to act as an LNURL/zap endpoint, or a small
  LNURL server could sit in front of barkd's invoice API.
- Let users zap other users' posts with relay credit (a ledger-to-ledger
  transfer), then settle externally over Ark. This needs care: it turns the
  relay into a custodian of value moving between users.
- NIP-47 (NWC) top-ups: a client with an NWC wallet could top up without
  leaving the app. Bark has an NWC implementation (`bark-nwc`).

## Risks

- **Custody and legal.** Prepaid balances are customer funds held by the
  operator. Small amounts and no withdrawals keep this close to "service
  credit", but it varies by jurisdiction. The README should say so.
- **Replay with `BARK_CHARGE=author`.** Third parties can re-post your
  signed events from other relays and spend your credit on them. The cost
  is bounded (once per event, and only your real events). `authed` mode
  closes this.
- **Charged but not stored.** strfry checks expiry, deletions and
  replaceable ordering after the plugin accepts an event, so a few accepted
  events are charged and then dropped. The fix would be a core hook such as
  a post-write callback, which is probably not worth the core change.
- **Unbounded growth.** Any signed event from a new key allocates an Ark
  address and a ledger row. Key generation is free, so a spammer can grow
  the ledger. Options: allocate addresses only for authed connections,
  rate-limit per IP, or prune rows with zero balance and no payments after N
  days.
- **barkd availability.** If barkd is down, writes still get an answer
  (`restricted:` without an address), but credits wait until it is back. The
  wallet's VTXOs need regular refreshes, so barkd must run continuously.
- **Polling cost.** Each poll reads the whole wallet history. That is fine
  for thousands of movements but not for millions. Use notifications, or a
  history cursor if bark-rest adds one.
- **Mainnet.** This has only been exercised on signet and with a mock.
  Before mainnet: test with real payments, measure Ark server receive fees
  for small Lightning amounts, and decide on minimum top-ups.

## Open questions

1. Upstream placement (decided): the plugin lives in this repo, with an
   entry proposed for strfry's `docs/community.md`. Only the generic
   `readAllowlistFile` change is proposed for strfry core.
2. Is `readAllowlistFile` the shape Doug would accept for read gating, or
   would he prefer it to be a list of pubkeys per kind, or part of the
   existing `restrictedReadKinds` mechanism?
3. Lightning: should invoices go to the relay's own wallet (as implemented),
   or should `bolt11_invoice_for_address` forward them to a per-pubkey Ark
   address, so Lightning and Ark payments share one crediting path?
4. Should unused balance be refundable, for example by offboarding over Ark
   to a user's address on request? That makes custody cleaner but adds an
   attack surface.
5. Pricing: what do real operators want? Ask relay operators (nerostr,
   nostr.wine and other paid relays) before building phase 3.
