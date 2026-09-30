# Roadmap

What is built is listed in `README.md`. This file is the honest list of what is **not** built yet, or is built in a simpler form than the spec describes.

## Simplified today

| Area | Today | Planned |
|---|---|---|
| Live updates | Pages re-fetch on navigation; the count screen polls for other counters' entries | Supabase Realtime subscriptions for counts, alerts and receiving |
| Forecasting inputs | Same-weekday sales history × trend, day-of-week demand, manual forecast overrides | Weather, holidays, local events, catering orders, promotions |
| POS | CSV adapters (generic, Toast, Square exports) through `import_sales` | API adapters (Toast, Square, Clover, MICROS, Aloha, Lightspeed) with scheduled pulls |
| Sending orders | Order PDF/print and `mailto:` to the vendor | Direct email send, EDI / vendor portal integrations |
| Photos | Waste photos stored as compressed data URLs on the row | Supabase Storage buckets with signed URLs |
| Costing | Weighted average cost (with last cost and contract price shown) | FIFO and standard costing as per-organization options |
| Alerts refresh | On dashboard load, after counts and POS imports | `pg_cron` job with a service-level refresh function |
| Large lists | Server-side pagination and filtering | Virtualized lists for 10k+ item catalogs |
| Invoice scanning | Claude extraction with mandatory human review (needs `ANTHROPIC_API_KEY`) | Vendor-specific templates, learning item mappings |

## Not built yet

- UI for per-location vendor overrides (`location_vendors` exists in the schema; managed via SQL today).
- UI for assigning counters to specific storage areas (`count_assignments` exists; counters currently pick any area).
- Central → local push of order guides and recipe changes with approval workflow.
- Catering / event orders feeding the forecast.
- Accounting exports (QuickBooks, Sage, R365 GL mapping).
- Native wrappers (the PWA installs on iOS/Android today).
