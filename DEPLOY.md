# Going live

Read **[LAUNCH_READINESS.md](LAUNCH_READINESS.md)** first. Real restaurant operations go on the system only after the owner acceptance checklist in that file is signed off on **staging**.

Three accounts hold the app and your data: **Supabase** (database and logins), **Vercel** (the website) and **Resend** (email). All should be in the owner's name. Keep every key private: never email, text or paste them into a chat.

You will create the whole setup **twice**: first **staging** (a copy for testing, may hold demo data), then **production** (real data only, never demo data). Use separate Supabase projects and separate Vercel projects or environments.

## 1. Database (Supabase)

1. supabase.com → **New project**. Name it `pita-princess-staging` (later `pita-princess-production`). Save the database password. Region: closest to the restaurant.
2. Open `supabase/production/setup.sql` from this repository (branch `claude/restaurant-inventory-system-ghk30b`) → **Raw** → select all → copy.
3. Supabase → **SQL Editor** → **New query** → paste → **Run**. Expect *Success. No rows returned*. It contains no demo data.
4. **Staging only, optional:** to try the app with the demo restaurant, also run `supabase/seed.sql` the same way. **Never run `seed.sql` on production.**

## 2. Values to copy from Supabase

**Project Settings → API Keys / Data API**:

| Vercel variable | Where it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL (`https://abcd1234.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The **publishable** key (older projects: **anon public**) |
| `SUPABASE_SERVICE_ROLE_KEY` | The **secret** key (older projects: **service_role**). Server only. |

## 3. Email (Resend)

1. resend.com → sign up → **Domains → Add domain** (e.g. `pitaprincess.com`) → add the DNS records it shows at your domain registrar → wait until **Verified**.
2. **API Keys → Create** (sending access). Copy it.
3. Choose the sender, e.g. `Princess Pita Inventory <reports@yourdomain.com>` (must use the verified domain).

## 4. Website (Vercel)

1. vercel.com → sign up **with GitHub** → **Add New → Project** → import `Pita-Princess-Inventory`.
2. **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from step 2 |
| `APP_URL` | the site's address, e.g. `https://inventory.pitaprincess.com` (links in emails) |
| `CRON_SECRET` | a long random string (e.g. from a password manager). Vercel sends it to the scheduled job. |
| `RESEND_API_KEY`, `EMAIL_FROM` | from step 3 |
| `TOAST_WEBHOOK_SECRET` | only when Toast API access is set up (step 8) |
| `ANTHROPIC_API_KEY` | optional: invoice photo scanning |

3. **Deploy.** `vercel.json` schedules `/api/cron/email` every 15 minutes (reports, alert digests, vendor-cutoff reminders, sending). Schedules more often than daily need **Vercel Pro**; a restaurant is commercial use, so plan on Pro anyway.
4. Optional custom address: **Settings → Domains** → add `inventory.pitaprincess.com` and follow the DNS instructions. Update `APP_URL` to match.

## 5. Connect logins to the address (Supabase)

**Authentication → URL Configuration**: **Site URL** = your address; **Redirect URLs** = your address followed by `/**`.

## 6. Owner accounts

1. Open the site → **Create an account** → confirm the email → **Set up your restaurant** (company, store number, name, time zone). You are now a System Owner.
2. Supabase → **Authentication → Sign In / Providers** → turn **off** *Allow new users to sign up*. Everyone else is added inside the app.
3. Administration → Users → **Add person** for the second owner, then **Grant role → System Owner → All locations**.

## 7. In the app

Open **Getting started** and follow it (products, shelf order, team, first count).

**Products:** start from `supabase/production/princess-pita-products.csv`. It lists the 58 items on the Sysco, Greco and Commissary order sheets (plus the handwritten additions), with vendor, category, storage area and a suggested count unit. Before importing, open it in Excel or Google Sheets and fill in what only you know: **Case unit, Per case, Case price, Vendor item # and Par**, and check the *Please confirm* column (e.g. is lettuce counted by the head or by the pound?). Create the commissary location first (Administration → Locations → Type: Commissary); the *Commissary* vendor then links to it automatically. Inventory → **Import from spreadsheet** → upload → check the preview → Import. You can re-import the same file later with more columns filled in: matching items are updated, never duplicated.

Then:

- **Vendors**: Sysco, Greco (Kind: Distributor) with delivery days, cutoff, lead time, minimum and **Ordering website** (Sysco: `https://shop.sysco.com` or your account's URL; Greco: the address Greco gave you). Passwords for vendor sites are never stored here.
- **Commissary**: Administration → Locations → add the central kitchen (kind: Commissary). Add a vendor named *Commissary*, kind *Commissary*, linked to that location, with the items it supplies on its order guide.
- **Shared employee login**: Users → Add person (role Employee) → **Make shared**. Administration → **Employees & PINs**: add each person with a private 4-digit PIN.
- **Email**: Administration → **Email reports & alerts**: add recipients and tick what each receives. Use **Generate weekly report** and **Preview** to check it, then **Send pending now** to receive a real one.

## 8. Toast (when API access is granted)

Live order sync needs Toast partner API access (request it from Toast). Then:

1. In Toast's developer portal, register the webhook URL `https://<your address>/api/toast/webhook` for order events and copy the signing secret into `TOAST_WEBHOOK_SECRET` (redeploy).
2. In the app: **Sales / Toast → Toast sync** → enter the store's Toast restaurant GUID.
3. Map every item listed under **UNMAPPED TOAST ITEMS** to a recipe.

Until then, import the daily Toast *Item Selection Details* export on **Sales / Toast → Daily sales**. A given day is either imported from a file or synced from Toast, never both (the app refuses the second to prevent double counting).

## 9. Backups and restore

- **Supabase Pro** (about $25/month) is required for production: daily backups with 7-day retention. Enable **Point-in-Time Recovery** if the budget allows.
- In addition, take a weekly logical backup you control: `supabase db dump --db-url "<connection string>" -f backup-YYYY-MM-DD.sql` (or Database → Backups → Download), stored outside Supabase.
- **Test a restore before go-live**: create a scratch Supabase project, restore the latest backup into it (Database → Backups → Restore, or `psql "<scratch connection string>" -f backup.sql`), sign in against it from a staging deployment and check that counts, receipts and the ledger are present. Write down how long it took.
- The ledger and audit log are append-only; mistakes are corrected with new transactions, never by editing data. Never run ad-hoc `update`/`delete` statements on production.

## 10. Updating the app

- Code: changes merged to the deployed branch deploy automatically. Deploy to **staging first**, re-run the acceptance checks that the change touches, then promote to production.
- Database: new files appear in `supabase/migrations/`. Apply each new file **once, in filename order**, on staging, test, then on production (SQL Editor, or `supabase db push`). `supabase/production/setup.sql` is only for a brand-new project.
- Upgrading a database created before this release: run, in order, `20260930002200_employee_identity.sql`, `…2300_report_permissions.sql`, `…2400_ordering_center.sql`, `…2500_commissary.sql`, `…2600_email.sql`, `…2700_food_cost_rounding.sql`, `…2750_alert_sync_failure.sql` (on its own), `…2800_toast_orders.sql`.

## Plans and costs (check current pricing)

Vercel Pro (~$20/month), Supabase Pro (~$25/month), Resend (free tier covers a few thousand emails/month), a domain (~$15/year).
