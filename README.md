# HypeHedge on Cloudflare

Fresh-database Discord prediction markets and reaction currency using a Worker,
SQLite-backed Durable Object, and D1. No Workers KV or Postgres is required.
This branch does not import existing balances, migrate production data, or cut over
an existing bot. Deployments and Discord configuration changes are separate operator actions.

## Local setup

Use Node.js 22 or later. `npm ci`, `npm run db:local`, and `npm run dev` run locally.
Copy `.env.example` to `.dev.vars` and replace placeholders only when using a separate
test Discord application. `npm test` runs workerd/Miniflare with real local D1 and
Durable Object bindings and fake Discord endpoints; it needs no credentials.
`npm run typecheck`, `npm run lint`, and `npx wrangler deploy --dry-run` verify the build.

The HTTP endpoint is `POST /interactions`. It checks Ed25519 over the original
request bytes plus timestamp, permits at most five minutes of timestamp skew,
and bounds the body at 64 KiB. Ping, autocomplete and opening modals respond
immediately. Other interactions enter a durable queue before receiving an ephemeral
deferral. Mutations use interaction IDs as operation IDs; completion edits the
original webhook message through a durable outbox. Users, balances and rankings
are global; markets and their controls are scoped to the invoking guild.

## Operator deployment procedure (not performed by this PR)

1. Create a **new** D1 database with `npx wrangler d1 create hypehedge`. Replace the
   all-zero `database_id` in `wrangler.jsonc` with its ID. The SQL in `migrations/`
   is the initial schema for an empty database, not a legacy-data migration.
2. Set `CLIENT_ID` and `DISCORD_PUBLIC_KEY` in Wrangler vars for the intended
   Discord application. Run `npx wrangler secret put BOT_TOKEN` using the bot token.
   Never commit `.dev.vars`, tokens, or actual credentials.
3. Apply the new schema using `npx wrangler d1 migrations apply hypehedge --remote`.
   Run `npm run deploy` only after an explicit deployment/cutover decision.
4. Set that application's Discord Interactions Endpoint URL to the deployed
   `/interactions` URL. Enable the required guild/message/reaction intents in its
   developer portal. The optional explicit `npm run register` command registers
   commands in one test guild; set `BOT_TOKEN`, `CLIENT_ID`, and `GUILD_ID` for it.
5. Gateway startup is deliberately disabled initially. From an authenticated
   temporary operator Worker using the same namespace binding, call
   `env.GATEWAY.get(env.GATEWAY.idFromName("discord")).fetch("https://gateway/start",
   { method: "POST" })`. The public Worker exposes no management route. Fence any
   existing bot before enabling this consumer. Remove temporary operator tooling
   after use. The scheduled recovery handler wakes this one namespace object;
   it does not enable a disabled Gateway.

## Accounting and delivery guarantees

Amounts are integer units (10,000 per coin/contract). Arithmetic uses checked safe
integers and BigInt for products, division and exact allocation. IDs stay strings;
new IDs use random 128-bit values rather than per-isolate counters.

D1 batches are atomic SQL sequences, not interactive Postgres transactions.
Mutation reads precede a global revision compare-and-swap in the batch. An explicit
CHECK assertion follows the guard: a zero-row UPDATE therefore fails the batch.
All effects, escrow/conservation assertions and the operation receipt commit in
that same batch. Stale revisions are retried. Reusing an operation ID with different
arguments fails. Every writer must use this ledger; direct administrative writes
would bypass its snapshot protocol. Markets are bounded to 80 participants and
2–10 outcomes to keep matching and settlement batches finite. The participant cap
rejects new participants; existing holders can still sell or reorder at the cap.
Short sells mint
funded complete baskets; collateral equals every outcome's share supply and is
paid exactly once at resolution. Cancel/fill/settle release their associated escrow.

Reaction records retain inactive history and outstanding unreturned credit. Removal
reclaims only spendable funds; re-add restores only the amount reclaimed, preventing
spent or escrowed awards being credited again. Bot/self reactions are ignored.
Live reaction events and backfill share this history.

Gateway dispatches are captured durably with the resume checkpoint before processing.
D1 operation receipts cover a crash after a remote effect but before local completion.
A deadline response or network failure can have an ambiguous outcome: pending
admission may still commit after an HTTP 503. Replaying the same interaction ID is
safe; creating a new interaction is a new operation.
A Durable Object transaction does **not** cover D1 calls. Captured reactions retain
order across retries. The queue has finite capacity; saturation disconnects without
advancing the checkpoint so Discord resume can replay. Reconnect, session invalidation,
missed heartbeat acknowledgments, REST retries and rate limits are handled explicitly.
Recovery disconnects preserve Discord resume sessions, while terminal shutdown
invalidates them. Gateway upgrade requests use HTTPS URLs, as required by workerd.
Concurrent scheduling retains the earliest alarm deadline, so sustained intake
cannot postpone a queued drain.
Alarm drains use bounded fair progress across commands, replies, ordered live
events and backfills. Terminal Discord close codes disable the Gateway and record
an observable failure; recovery codes reconnect according to session validity.
Backfill uses persisted bounded cursors: at most 500 channels, 1,000 messages
per channel, and 10,000 users per reaction. Reaching an oversized scan boundary
records an observable partial-scan failure; no further page is processed.
Denied or deleted channels are skipped with partial-scan diagnostics. A deleted
message advances its channel cursor; an inaccessible guild terminates the scan and
frees its slot. Rate limits, server errors and network failures retain cursors for
retry. `/backfill reset:true` starts a fresh scan with the requested limit and
cleared cursors. Durable interaction receipts prevent a replay or delayed older
reset from replacing a newer scan, including after object eviction. Reset fences
local cursor saves and stops subsequent pages and users from the old scan; a D1
award already in flight may still finish. Existing reaction history remains intact
and prevents repeated credit across scans.

This is idempotent processing of **captured** events, not an exactly-once guarantee
for Discord delivery. Discord resume history may expire, messages may be deleted or
inaccessible, and backfill is a bounded snapshot, not reconstruction of all reaction
history. Permanent inaccessible-message events and expired webhook delivery must be
observable in object status. Operator inspection uses the internal `/status` binding
route. Receipts and reaction history grow with activity; monitor D1 size and quotas.

## Account-wide free-tier tradeoffs

The application conservatively budgets at most 50 logical D1 SQL statements per
HTTP or alarm invocation, including reads, every batch statement and retries.
Atomic batches are refused before execution when the remaining budget is too small;
durable work resumes in a fresh alarm. Reaction-page cursors retain partial progress.
Matching and settlement use set-based SQL so their cost does not grow with the
80-participant bound; collection reads avoid per-record queries.
At that bound, tested command paths use 17 statements for settlement including
authorization reads, and 37 for order creation plus matching. Contention can yield
between those receipt-backed operations; it does not split an atomic ledger batch.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) list 50 queries
on Free, while the [workerd binding](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts)
sends a SQL batch in one service request. This statement budget is deliberately
conservative, not a claim about hosted subrequest metering. Local workerd tests
exercise the application budget; they do not reproduce hosted quota enforcement.

An outbound Discord WebSocket cannot use Durable Object hibernation. The heartbeat
keeps this object active. At 128 MB, a continuously active object uses about
10,800 GB-s/day (0.125 × 86,400), about 83% of the 13,000 GB-s/day free account
allocation. This allocation is shared by **all** objects in the account. Free-tier
requests, SQL reads/writes and D1 storage are also account-wide budgets; REST retries,
backfill, status inspection and other projects add usage. Free-tier quota exhaustion
causes operations to fail until reset; this is not guaranteed free or uninterrupted
hosting. See [Cloudflare Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [outbound WebSocket restrictions](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
A paid account may be more appropriate for a bot that must stay available.

## Validation and CI

Tests exercise real local SQL constraints/batch rollback, concurrent ledger operations,
exact conservation, operation replay, signature failures, permissions/guild scope,
durable queue/checkpoint behavior, reconnect and rate limits with fake Discord.
The PR workflow runs npm checks and a dry-run bundle only; there is no deploy job.
Private GitHub Actions minutes are exhausted at the time of this rewrite. A blocked
CI run is a billing limitation; local runtime evidence must be reviewed separately.
