<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project rules (Stockline / Pita Princess Inventory)

- Inventory quantities come only from `inventory_transactions` (immutable ledger). Never add an editable quantity field; post a transaction through a SECURITY DEFINER function (`app.post_inventory_txn`).
- Every workflow that touches stock or money is one database function (atomic). Server actions call RPCs; they never chain multiple writes.
- Unit conversions come only from the `product_unit_options` view (`app.unit_factor` in SQL, `src/lib/units.ts` on the client using factors from that view).
- Money and quantities are `numeric` in SQL and `decimal.js` in client math. Never use float math for money.
- Master data (products, vendors, recipes) is editable only with organization-scope permissions; RLS enforces this.
- Tables listed in `app.write_protected_tables` cannot be written by `authenticated`; end every migration with `select app.apply_grants();`.
- Server components cannot pass functions to client components; use redirect templates like `"/receiving/{id}"`.
- Tests: `npm test` (unit), `npm run test:db` (SQL workflows under RLS), `npm run test:e2e` (Playwright, needs the app running on a seeded DB).
