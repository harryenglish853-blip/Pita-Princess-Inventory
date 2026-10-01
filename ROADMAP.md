# Roadmap

What is built is listed in `README.md`; launch status is in `LAUNCH_READINESS.md`. This file is the honest list of what is **not** built yet, or is built in a simpler form than the specification describes.

## Simplified today

| Area | Today | Planned |
|---|---|---|
| Toast | Webhook + JSON upload + daily export import; webhook format and refund-quantity mapping NOT YET VERIFIED against live Toast | Scheduled API pull (Orders API `ordersBulk`) for missed webhooks; menu import from Toast |
| Vendor ordering | Ordering center with copy list + open vendor website; orders placed on the vendor's site | Sysco/Greco API or EDI ordering and electronic invoices |
| Live updates | Pages re-fetch on navigation; the count screen polls for other counters' entries | Supabase Realtime for counts, alerts and receiving |
| Forecasting inputs | Same-weekday sales history × trend, day-of-week demand, manual overrides | Weather, holidays, events, promotions, seasonality |
| Photos | Waste photos stored as compressed data URLs on the row | Supabase Storage with signed URLs |
| Costing | Weighted average cost (last and contract price shown) | FIFO / standard costing options |
| Employee item costs | Reports, food cost, sales and vendor spending are blocked for employees in the database; per-item unit costs on ledger/price rows remain readable to store staff (they key invoice prices) | Column-level cost masking for employee roles |
| Offline counts on a shared login | Entries sync under the person identified when the device reconnects; switching person warns while entries are unsynced | Store the employee token with each queued entry |
| Voice counting | Parser and confirmation built; uses the browser's speech recognition where available | Server-side speech model for noisy kitchens |

## Not built yet

- Toast API pull job and Toast menu import.
- Accounting exports (QuickBooks, R365 GL mapping).
- Catering / event orders feeding the forecast.
- Native app wrappers (the PWA installs on iPhone/Android today; native apps are out of scope by design).
