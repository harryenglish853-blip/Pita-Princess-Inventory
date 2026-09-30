# Stockline — restaurant inventory & food-cost operating system

Built for **Pita Princess**. Stockline runs the whole inventory loop for one restaurant or a thousand:

**forecast → plan → order → receive → store → transfer → prep → sell → waste/adjust → count → compare actual vs theoretical → find the variance → forecast again.**

Every number on every screen is calculated from database transactions. Nothing is mocked.

| Question | Where it is answered |
|---|---|
| What do we have? | Inventory (perpetual book inventory from the ledger), stock cards |
| What should we have? | Count review (book vs physical), pars / dynamic pars |
| What did we use / waste? | Food Cost (AvT), Waste, Reports → usage & turns |
| What do we need / what should we order? | Purchasing → suggested order with a "Why N cases?" breakdown |
| What did we receive and pay? | Receiving → invoice reconciliation, price history |
| Where did the inventory go / where are we losing money? | Stock card, AvT by product/category/menu item/day, largest variances |

## Stack

Next.js 16 (App Router, server actions) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (Postgres 16, Auth, Row Level Security, PostgREST) · PWA with an IndexedDB offline queue and service worker.

## Architecture in one page

```
src/app/(app)/...        pages (server components) + server actions per module
src/components/          design system (ui.tsx), client primitives, data table, shell
src/lib/offline/         IndexedDB store + count sync engine (idempotent, conflict-safe)
src/lib/voice/           voice-count parser (pure, unit tested)
src/lib/pos/             POS adapter layer (generic CSV, Toast, Square; API adapters declared)
src/lib/ai/              invoice extraction (Claude, structured output, human-confirmed)
supabase/migrations/     schema, RLS, and every business workflow as a SQL function
supabase/seed.sql        demo restaurant built by calling the real functions
supabase/tests/          SQL workflow tests executed as real users under RLS
e2e/                     Playwright tests (desktop + phone, offline)
scripts/local-stack/     Docker-free Supabase-compatible stack for dev/CI
```

**Data integrity rules**

- **Immutable ledger.** `inventory_transactions` is append-only (a trigger rejects updates/deletes). Book inventory at any moment = the sum of the ledger up to that moment. `inventory_balances` is a derived cache maintained by trigger.
- **Atomic workflows.** Posting a count, reconciling an invoice, receiving a transfer, recording production, importing POS sales and logging waste are each one Postgres function: all rows (ledger, costs, price history, statuses, alerts, audit) commit together or not at all.
- **Central unit engine.** `product_unit_options` defines every unit a product can be expressed in (package conversions like `1 CASE = 40 LB`, plus automatic LB↔OZ, GAL↔FL OZ…). SQL and the UI both use it; the server recomputes all totals.
- **No floats for money.** `numeric` in SQL, `decimal.js` in the browser.
- **Security.** RLS on every table; location access expands through company → region → district → store. Corporate master data (products, vendors, recipes, units, categories) requires an organization-wide role. Ledger, audit, count, purchasing and history tables are written only by SECURITY DEFINER functions (`app.write_protected_tables`). Role grants are ranked (you can only grant roles below your own).
- **Audit log.** Who, what, when, where, old/new values, device id, user agent and IP for every critical change.
- **Duplicate protection.** Idempotency keys on counts, orders, receipts, waste and production; one open receipt per PO; unique invoice numbers per vendor; one POS import per day; posting functions lock rows and refuse double posts.

## Modules

| # | Module | Highlights |
|---|---|---|
| 1 | Dashboard | Inventory value, actual/theoretical food cost %, AvT variance, waste, sales, forecast, turns, stock alerts, deliveries, reconciliation, tasks, largest variances, price increases; corporate scorecard with region/district/market filters and best/worst stores |
| 2–4 | Inventory, storage, shelf-to-sheet | Full item master, multiple storage areas per item, drag-and-drop walking order |
| 5 | Physical counts | Daily/weekly/month-end/cycle/location/category/full; case + weight entry, calculator input, +/−, barcode (camera or scanner), voice with confidence and confirmation; **offline** with sync states; multiple counters assigned by storage area, with conflict detection and revision history |
| 6–7 | Book inventory & review | Begin + received ± transfers + produced − used − waste ± adjustments = book; variance qty/$/%; tolerance flags → recount; posting creates variance transactions and locks the count |
| 8–9 | Vendors & order guides | Delivery days, cutoffs, minimums, contract prices, multi-vendor price comparison; per-store delivery days, lead time, cutoff and account number |
| 10–12 | Forecasting, dynamic pars, suggested ordering | Same-weekday sales forecast × trend; day-of-week demand; NEED − HAVE with transparent explanations |
| 13–19 | Receiving, reconciliation, lots, temperatures (purchase orders optional) | Status workflow, short/over/substitution/rejected/damaged/catch weight/back order, storage put-away, invoice over/short with tolerance and override reason, recall search |
| 16 | Invoice scanner | Photo/PDF → Claude structured extraction → side-by-side review → apply; never posts on its own |
| 20–22 | Transfers & waste | Storage and store-to-store transfers (in-transit), fast waste logging incl. prepared/menu items |
| 23–26 | Recipes & production | Nested recipes with cost roll-up, prep items produced into inventory, yield variance, suggested prep |
| 27–31 | POS & food cost | Adapter-neutral POS import, theoretical usage, actual vs theoretical with drill-downs |
| 40–41 | Reports & export | Valuation, efficiency/turns/aging, count summaries, ledger, adjustments, purchases, price variance, price changes, vendor performance, order accuracy, lot recall; CSV, Excel, print/PDF, saved views |
| 45–46 | Users, permissions, audit | 11 roles, 30 granular permissions, scoped assignments, audit log viewer |

## Ordering is optional

By default the app does **not** place orders: you order in each vendor's own app and log the delivery here (Receiving → **Log a delivery** → pick the vendor → scan the invoice or tick the items that arrived → enter quantities and prices → post). Stock, average cost and price history update when the delivery is posted. Suggested orders and purchase orders can be switched on in **Administration → How you order** (organization setting `ordering_enabled`).

## Running locally

### Option A — Supabase CLI (Docker)

```bash
supabase start            # applies supabase/migrations and supabase/seed.sql
cp .env.example .env.local  # fill in the URL/keys printed by `supabase status`
npm install && npm run dev
```

### Option B — Docker-free stack (what CI uses)

Requires PostgreSQL 16 binaries (`apt install postgresql-16`). Downloads Supabase Auth and PostgREST release binaries into `.local-stack/`.

```bash
npm install
npm run stack:start      # Postgres :54322, Auth :9999, PostgREST :3001, gateway :54321, writes .env.local
npm run db:reset         # drop, migrate, seed the demo restaurant
npm run dev              # http://localhost:3000
```

### Demo logins (password `Demo1234!`)

| Email | Role | Sees |
|---|---|---|
| owner@example.com | System Owner (all locations) | everything, corporate scorecard |
| gm@example.com | General Manager, #101 | store operations, costs, posting, overrides |
| kitchen@example.com | Kitchen Manager, #101 | ordering, counts, production |
| maria@example.com, john@example.com, carlos@example.com | Employees, #101 | count, receive, log waste |
| accounting@example.com | Accounting (company) | reconciliation, cost reports, audit |
| regional@example.com | Regional Manager (Midwest) | both stores, corporate view |

The seed builds four weeks of history for **Demo Restaurant #101** (plus #105) by calling the same functions the app uses: weekly orders with a chicken price path of $2.74 → $2.81 → $2.96 → $3.20/LB, receiving with temperatures and lots, daily POS imports, salsa production, waste, and weekly counts by three counters. Current week: a confirmed Sysco order due tomorrow and a produce delivery waiting for reconciliation.

**Never run `supabase/seed.sql` against production.**

## The sample restaurant week

`supabase/tests/02_sample_week.sql` replays the operating week from the spec and asserts every number:

- Monday: suggested order, manager overrides chicken to 5 cases.
- Tuesday: 4 cases arrive, invoice says 5 → flagged short + invoice mismatch → back order → invoice reconciled.
- Wednesday: POS import depletes 280 sandwiches × 8 oz = 140 LB chicken (and nested House Sauce, buns…).
- Thursday: 3 LB chicken waste; 1 cheeseburger recipe waste depletes beef, bun, cheese and sauce.
- Sunday: count → **book 31 LB, physical 26 LB, variance −5 LB = −$16.00** → posted → AvT: begin 14 + received 160 − theoretical 140 − waste 3 = expected 31.

You can do the same week through the UI with the demo logins (Purchasing → Receiving → Sales/POS import → Waste → Counts → Food Cost).

## Tests

```bash
npm run typecheck
npm test            # unit: voice parser, calculator, unit engine, POS adapters, CSV
npm run test:db     # SQL workflows as real users under RLS (Phases 1–6 + sample week)
npm run build && npm start
npm run test:e2e    # Playwright: permissions, offline counting + reload with no network,
                    # order → short delivery → back order → reconcile, waste, all pages, phone layouts
```

## Production notes

- Deploy the database with `supabase db push` (migrations only — not the seed). Create the first user by signing up; onboarding creates the organization and makes them System Owner.
- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only) and optionally `ANTHROPIC_API_KEY` for invoice scanning.
- Stock and operational alerts (late delivery, order not submitted, expiring lots, high waste, high count variance, unusual usage) refresh when the dashboard loads, after counts and POS imports, and every 30 minutes through `app.refresh_all_alerts()`. The migration schedules that with `pg_cron` when the extension is available (hosted Supabase); elsewhere, run `select app.refresh_all_alerts();` from any scheduler as the database owner.
- POS: Toast and Square file exports work today; API adapters (Clover, MICROS, Aloha, Lightspeed) plug into `src/lib/pos/adapters.ts` and still import through the same `import_sales` function.
- Offline: counts are stored in IndexedDB and synced in batches with idempotency keys; entries never leave the device queue until the server confirms them. Sign-out warns if anything is unsynced.

## What is next

See `ROADMAP.md`.
