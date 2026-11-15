# Repository guidance

HypeHedge uses Cloudflare Workers + one SQLite Durable Object Gateway + D1.
Read README.md for setup, delivery guarantees, limits and operator-only deployment.

- Use `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
- Runtime: `src/cloudflare/worker.ts`, interactions router, GatewayDO.
- Persistence: `src/database.ts`; fresh schema: `migrations/0001.sql`.
- Business logic: `src/accounting.ts`, `src/exchange.ts`.
- Tests run in workerd with fake Discord; never require live credentials.
- Every D1 writer must use the revision/atomic batch/receipt protocol. A zero-row
  conditional update is not a failure without the explicit assertion.
- DO local storage transactions do not encompass remote D1 or Discord requests.
- Keep amounts checked integers and IDs strings. Preserve escrow and collateral.
- Do not deploy, enable the Gateway, register Discord commands or modify live
  resources/configuration without explicit user authorization.
