-- Own migration: a new enum value cannot be used in the transaction that adds it.
alter type public.alert_type add value if not exists 'sync_failure';
