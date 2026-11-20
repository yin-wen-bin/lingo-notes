-- One SQL statement gives one MVCC snapshot across all included application
-- tables. This does not contain Vault, Auth records or push subscriptions.
-- Prefer scripts/cloud-backup.mjs so the result is encrypted without printing.
select public.lingo_backup_snapshot();
