# Launch readiness report

Date: October 1, 2026 · Branch: `claude/restaurant-inventory-system-ghk30b`

## Final recommendation: **NOT READY FOR PRODUCTION**

The software passes every automated check below with **0 known critical and 0 known high-severity bugs**. It is still not ready for real restaurant use. Launch needs things only the restaurant can supply (accounts, keys, real data), plus the staging acceptance and restore test in this file. **Do not put real operations on it until every item under "Must be done before launch" is checked off on staging.**

### Must be done before launch

| # | Item | Status |
|---|---|---|
| 1 | Staging and production Supabase projects created; `setup.sql` applied; signups turned off | BLOCKED — REQUIRES EXTERNAL CONFIGURATION |
| 2 | Vercel staging + production deployments with all environment variables (DEPLOY.md §4) | BLOCKED — REQUIRES EXTERNAL CONFIGURATION |
| 3 | Resend account with the restaurant's sending domain verified; one real email of each type received and read on a phone | BLOCKED — REQUIRES EXTERNAL CONFIGURATION |
| 4 | Supabase Pro backups on; a restore into a scratch project performed and timed (DEPLOY.md §9) | BLOCKED — REQUIRES EXTERNAL CONFIGURATION |
| 5 | Real restaurant data entered on production. The 58 products from the Sysco/Greco/Commissary order sheets are ready in `supabase/production/princess-pita-products.csv` (imports with 0 errors); still needed: case sizes, case prices, vendor item #s, pars, shelf order, recipes, employees + PINs, email recipients | BLOCKED — REQUIRES RESTAURANT INFORMATION |
| 6 | Greco's real ordering website URL and Sysco account URL entered | BLOCKED — REQUIRES RESTAURANT INFORMATION |
| 7 | Toast: either partner API access + webhook secret, or the daily export routine agreed with the managers | BLOCKED — REQUIRES EXTERNAL CONFIGURATION |
| 8 | Owner acceptance checklist below signed on **staging** | NOT YET VERIFIED |
| 9 | One full operating week run on staging with real deliveries, waste, Toast sales and a Sunday count, with the numbers reconciled by a manager (PASS 10) | NOT YET VERIFIED |
| 10 | Real-device check: an iPhone, an Android phone and an iPad in the walk-in (offline count, PIN pad, camera barcode, Add to Home Screen) | NOT YET VERIFIED |

## Features

### Completed and tested in this release

| Area | What | How it was verified |
|---|---|---|
| Shared employee login | "Who are you?" + 4-digit PIN; PINs bcrypt-hashed outside the API schema; 5-try lockout, device throttle; sessions bound to the login; Switch person; every ledger row, audit entry, waste log, count and receipt records the employee; a shared login cannot change anything unidentified and cannot hold manager roles | SQL suite 07 (36 assertions), e2e `shared-login`, demo flow |
| Database-level financial permissions | Report functions private; `get_*` wrappers require `reports.view_cost` / `reports.view`; dashboard strips dollars for non-cost roles; sales hidden from employees; recipe costs hidden | SQL suite 08 (17 assertions), e2e permission tests |
| Ordering center | Per-vendor next delivery and cutoff (store time zone, lead time), suggested items + estimate, WHY?, copy order list, open vendor website (http/https only), mark as ordered → incoming + checked on delivery | Hand-checked cutoff math; unit tests for the list text; e2e (clipboard and popup URL verified) |
| Commissary | Internal supplier with DRAFT→RECEIVED statuses, email to the commissary, tasks, ship/receive ledger moves (commissary-out = restaurant-in), discrepancy value + alert + email, production costing | SQL suite 09 (33 assertions), hand-reconciled seed example, e2e |
| Email | Recipients per report type (owner-managed), outbox with dedupe keys, daily/weekly/monthly reports from stored data, immediate alerts (rate limited 10/h/store), daily stock digests, vendor-cutoff reminders, sandboxed preview, retry, Resend sender with idempotency keys, permanent-failure handling, cron route protected by a secret | SQL suite 10 (34 assertions: report figures checked against source tables), template unit tests, cron route tested over HTTP |
| Toast | Order-level sync keyed by GUID + version; repeats/stale events ignored; updates, refunds, removed items and voids post only the difference; unmapped items deplete nothing until mapped, then reprocess once; day rollup feeds dashboards and food cost; file import and sync can never both count a day; HMAC webhook; sync log; failure alerts | SQL suite 11 (29 assertions, ledger nets to the exact pound), adapter unit tests, webhook tested over HTTP (unsigned, forged, valid, replay, unknown restaurant) |
| Navigation | Desktop sidebar in the specification's order; phone tabs Home/Inventory/Count/Orders/More for management and Home/Receive/Waste/Tasks for employees; simple four-button employee home | e2e on phone, iPad and desktop |

Everything built before this release (ledger, counts with offline sync, receiving and reconciliation, waste, transfers, recipes, food cost, reports, alerts, tasks, product import) still passes its original tests.

### Intentionally deferred (see ROADMAP.md)

Toast scheduled API pull and menu import; vendor API/EDI ordering; Realtime updates; weather/holiday forecasting; FIFO costing; column-level masking of per-item costs for employees; accounting exports.

## Tests performed

| Suite | Result |
|---|---|
| TypeScript (`npm run typecheck`) | pass |
| Unit tests (`npm test`) | 46 / 46 pass (unit engine, calculator, voice parser, POS + Toast adapters, product import, order list, email templates) |
| SQL workflow tests under RLS (`npm run test:db`) | 11 suites, 318 assertions, all pass; runner now fails on any skipped suite |
| End-to-end (`npm run test:e2e`, production build) | 50 tests pass: desktop 1440×900, Pixel 7 phone, iPad (gen 7) |
| Production build (`npm run build`) | pass, no warnings |
| `setup.sql` applied to a blank database in a single transaction | pass (66 tables, 110 API functions) |
| HTTP checks of `/api/cron/email` and `/api/toast/webhook` | pass (auth rejections, idempotency) |

### Pass-by-pass status

| Pass | Status |
|---|---|
| 1 Functionality | Automated coverage passes for every listed workflow. Login/logout, sessions, roles, PIN, counts incl. pause/resume/offline, recount, posting, receiving, waste, transfers, ordering, commissary, recipes, food cost, reports, email generation, Toast. **Sending real email and live Toast: BLOCKED — REQUIRES EXTERNAL CONFIGURATION.** |
| 2 Data accuracy | Hand-verified: chicken AvT sample week (book 31, physical 26, −5 LB = −$16.00); 2 × 8 oz burgers = 1 LB beef through every Toast update; meatballs 100 ordered / 95 received, −$2.79; commissary flour 150 − 132 − 1.6 = 16.4 LB; vendor cutoff times; weekly report sales/purchases/waste equal their source tables; vendor spending sums to purchases. **Fixed:** food cost could print $0.01 off (begin + purchases − end ≠ actual). **NOT YET VERIFIED:** the restaurant's own numbers (needs real data, item 9). |
| 3 Security | Verified for employee, manager, commissary and owner logins: pages (URL), RPCs and table reads under RLS. Secrets are server-only (`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `CRON_SECRET`, `TOAST_WEBHOOK_SECRET` are never in client code); vendor website passwords are never stored. **Fixed:** report RPCs were callable by employees through the API; the Ordering center was open to employees; the audit log page showed nothing. Residual (MEDIUM, documented): employees can read per-item unit costs on ledger/price rows through the API. |
| 4 Mobile | Phone viewport: no horizontal scroll on 12 main screens, PIN pad, employee home, bottom navigation. Real phones: NOT YET VERIFIED (item 10). |
| 5 Tablet | iPad viewport: same checks plus the count screen (numeric keyboard, 44 px+ inputs, no sideways scroll). Real iPad: NOT YET VERIFIED. |
| 6 Desktop | Every page renders for owner, manager, employee and commissary at 1440×900 with no visible database errors. Large monitors: spot-checked by screenshot only. |
| 7 Offline | Count offline → reload with no network → sync on reconnect, no duplicates (existing e2e, production build). Shared-login offline attribution: see known issues. |
| 8 Failure testing | Covered: invalid quantities, duplicate invoice, duplicate submissions (client keys), double submit/ship/receive, wrong/old Toast events, forged webhooks, unauthorized actions, past dates, missing received quantities, malformed Toast data, provider rejections. Network failure mid-receiving relies on atomic RPCs (a failed call changes nothing); not separately simulated in the browser. |
| 9 Email | Content and data verified by tests and preview; recipients, dedupe and rate limits verified. Delivery to real inboxes and rendering in Gmail/Outlook/iOS Mail: BLOCKED — REQUIRES EXTERNAL CONFIGURATION. |
| 10 Full simulation | Automated demo flow (spec steps 1–21) passes on the demo restaurant. A real operating week on staging: NOT YET VERIFIED (item 9). |

## Known issues

| Severity | Issue | Plan |
|---|---|---|
| MEDIUM | Employees can read per-item unit costs from ledger/price tables through the API (not shown on employee screens). Reports, sales, food cost and vendor spending are blocked. | Accept for launch (employees key invoice prices) or add column masking (ROADMAP). |
| MEDIUM | Toast webhook headers, signature format and refund-quantity mapping follow Toast's documentation but are NOT YET VERIFIED against live Toast. | Verify on staging when API access is granted; until then use the daily export. |
| LOW | Offline count entries made on a shared login sync under whoever is identified when the device reconnects; Switch person warns while entries are unsynced. | ROADMAP. |
| LOW | Owners subscribed to "all locations" get one daily report per location (including the commissary). | Untick per location if unwanted. |
| LOW | The employee identity cookie is readable by the page (needed for offline sync). It is useless without that login's session and expires in 12 hours. | By design. |

Critical bugs: **0** · High bugs: **0** (all found during this work were fixed and are covered by tests).

## Status summary

| | |
|---|---|
| Security | Verified by automated tests; residual MEDIUM item above |
| Database | 28 migrations; setup.sql applies atomically to a blank database |
| Backups | BLOCKED — needs Supabase Pro and a restore drill |
| Mobile / tablet / desktop | Emulated viewports pass; real devices NOT YET VERIFIED |
| Email | Built and verified up to sending; delivery BLOCKED |
| Toast | Order sync verified with simulated events; live Toast BLOCKED |
| Vendor workflow | Sysco and Greco ordering center verified; real URLs needed |
| Inventory calculations | Verified (tests + hand checks) |
| Food-cost calculations | Verified (tests + hand checks; rounding defect fixed) |

## Owner acceptance checklist (sign on staging)

Tick each item yourself in the app; do not assume it is right because the software works.

- [ ] Both owners can sign in; sign-out works; a wrong password is refused
- [ ] The management login sees management screens and no Administration → Email or user setup it should not
- [ ] The shared employee login lists exactly our employees; each person's PIN works; a wrong PIN is refused; an employee sees only Receive / Waste / Transfer / Tasks
- [ ] Correct managers listed under Users, with the right roles and stores
- [ ] Correct products, categories, case sizes and units (1 case = ? LB for each counted-by-case item); every *Please confirm* note in `princess-pita-products.csv` answered
- [ ] Restaurant name spelled as you want it everywhere (the order sheets say **Princess Pita**)
- [ ] Correct product costs and par levels for the top 20 items
- [ ] Storage areas and the weekly count walking order match the walk-in, freezer and dry storage shelves
- [ ] Vendors: Sysco and Greco delivery days, cutoff times, lead times, minimums and account numbers
- [ ] **OPEN SYSCO** opens our Sysco ordering site; **OPEN GRECO** opens our Greco ordering site
- [ ] Copy order list pastes correctly into a text message / the vendor site
- [ ] Commissary location, commissary items and commissary email recipients are correct; a test commissary order emails the kitchen
- [ ] Recipes and selling prices for the top 15 menu items; recipe costs look right
- [ ] Every Toast menu item is mapped (Sales / Toast → no UNMAPPED TOAST ITEMS)
- [ ] Email recipients and what each receives (daily, weekly, monthly, alerts); a real daily and weekly email received and readable on a phone
- [ ] Alert thresholds (count variance %, $; price increase %; invoice tolerance) under Administration → Locations
- [ ] Restaurant name and branding as we want them
- [ ] A full test week reconciled by the general manager (deliveries, waste, Toast sales, Sunday count, food cost)
- [ ] Backup restore performed once and timed

Signed (owner): ______________________ Date: __________

Signed (owner): ______________________ Date: __________
