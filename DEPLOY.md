# Going live

Two free accounts hold the app and your data: **Supabase** (the database and logins) and **Vercel** (the website). Both should be in your name. Setup takes about 30 minutes at a computer.

Keep the keys from step 3 private. Don't email them, text them, or paste them into a chat.

## 1. Create the database (Supabase)

1. Go to supabase.com and sign up (or sign in with GitHub).
2. **New project**. Name: `pita-princess`. Set a database password and save it somewhere safe. Region: the one closest to the restaurant. Click **Create new project** and wait about two minutes.
3. Open this file on GitHub: `supabase/production/setup.sql` on branch `claude/restaurant-inventory-system-evn63l`. Click **Raw**, select all, copy.
4. In Supabase: **SQL Editor** → **New query** → paste → **Run**. You should see *Success. No rows returned*. (It contains no demo data.)

## 2. Copy three values from Supabase

In your project, click **Connect** (top of the page) or open **Project Settings → API Keys** and **Data API**:

| Name in Vercel | Where it is in Supabase |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL, like `https://abcd1234.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The **publishable** key (older projects: **anon public**) |
| `SUPABASE_SERVICE_ROLE_KEY` | The **secret** key (older projects: **service_role**). Server only. |

## 3. Put the website online (Vercel)

1. Go to vercel.com and sign up **with GitHub** (the account that owns `Pita-Princess-Inventory`).
2. **Add New… → Project** → find `Pita-Princess-Inventory` → **Import**. If it isn't listed, click *Adjust GitHub App Permissions* and allow that repository.
3. Open **Environment Variables** and add the three values from step 2. Optional: `ANTHROPIC_API_KEY` turns on invoice photo scanning; everything else works without it.
4. Click **Deploy** and wait about three minutes. Vercel shows your address, like `https://pita-princess-inventory.vercel.app`.

## 4. Connect logins to your address (Supabase)

**Authentication → URL Configuration**:

- **Site URL**: your Vercel address.
- **Redirect URLs**: add your address followed by `/**`, for example `https://pita-princess-inventory.vercel.app/**`.

## 5. Create your owner account

1. Open your address → **Create an account** with your name, email and a password.
2. Confirm the email Supabase sends. If it doesn't arrive within a few minutes, turn off **Authentication → Sign In / Providers → Email → Confirm email** and sign up again.
3. **Set up your restaurant**: company name, store number, restaurant name and time zone. You become the System Owner.
4. Back in Supabase: **Authentication → Sign In / Providers** → turn off **Allow new users to sign up**. Everyone else is added from inside the app, so nobody else can create an account.

## 6. Put it on your phone

Open your address on the phone, then add it to the home screen: in Safari use **Share → Add to Home Screen**; in Chrome use **⋮ → Add to Home screen**. It opens like an app, and counts keep working without signal.

## 7. In the app

Open **Getting started** (it's on the Home screen until everything is done). It shows each step and what's left:

1. **Restaurant details**: address, count tolerances (Administration → Locations).
2. **Products**: Inventory → **Import from spreadsheet**. Download the template, fill it in (or paste from your own sheet), preview, import. Vendors, categories and storage areas are created for you. You can re-import any time; matching items are updated, never duplicated.
3. **Shelf order**: drag items into the order you walk past them. Count sheets follow it.
4. **Team**: Administration → Users → **Add person**, with a temporary password you tell them in person. They change it under **My account**. Roles: General Manager, Kitchen Manager, Employee (counts, receives, logs waste).
5. **First full count**: Counts → Start count → **Full inventory** → count → post. This is your starting inventory.
6. **From then on**: log every delivery (Receive → **Log a delivery**) and all waste.

Within the next two weeks, for food cost: add recipes and menu items with your POS item numbers, then import each day's sales export from the POS (Sales / POS).

## Plans and costs

Check current pricing on each site.

- **Vercel**'s free Hobby plan is for non-commercial use, and a restaurant is commercial, so plan on **Pro** (about $20/month).
- **Supabase**'s free plan pauses a project after about a week with no use and has no daily backups. Once you rely on it, move to **Pro** (about $25/month) for backups.

## Updating the app

Changes pushed to the GitHub branch deploy automatically. Database changes come as new files in `supabase/migrations/`. Run each new file once in the SQL Editor, in order. `scripts/build-production-sql.sh` rebuilds `setup.sql`, but that file is only for a brand-new project.
