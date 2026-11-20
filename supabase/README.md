# Lingo Notes cloud backend

This is a new dataset. It has no SQLite, Native Messaging, Pages or WorkBuddy runtime dependency.

## Deployment order

1. Apply the numbered `migrations/*.sql` in order to the designated project.
2. Disable public signups, provision the explicitly invited Auth account and provide its one-time password-setup link. Email/password login does not use SMTP or send a code.
3. Deploy `app-api` and `review-tick` using `config.toml`. `verify_jwt=false` does **not** mean anonymous access: app-api validates the user's bearer token with Auth; review-tick requires the server-only random `x-cron-secret`.
4. Set the origins, PWA and notification configuration from `functions/.env.example`. Supabase supplies the privileged database connection key. Never ship it to clients. No global DeepSeek key is used.
5. Import a user's own Key with privileged RPC `lingo_key_set(p_user, p_key)` after confirming their Auth user ID. Browser calls use authenticated `key.save`; both routes save in Vault. Key status means stored, not model-authentication verified.
6. Verify text, image, owner isolation, and manual phone push. Only then configure Vault entries `lingo-cron-url` and `lingo-cron-secret` and run `enable-review-cron.sql`.

Vault permission boundary: the migration revokes browser/PUBLIC usage of the Vault schema and reads of its tables/views. It does not blanket-revoke functions inside Vault, because hosted crypto helpers may be owned by Supabase and the project role cannot alter them. Every application wrapper is explicitly service-role-only. This boundary needs hosted role checks in addition to emulated database tests.

The cron URL is the deployed `review-tick` URL; the secret must match its Edge secret. The enabling script intentionally is not a migration, so schema deployment cannot silently enable reminders.

## Public contract

POST `/functions/v1/app-api` with a user's bearer JWT and `{action,params,request_id}`. Ordinary responses are `{ok:true,result}` or `{ok:false,error}`. Generating actions stream SSE `accepted`, `progress`, `complete`, `error`. Accepted image events are emitted only after Storage persistence and record association. A disconnected stream is not a cancellation: clients query `records.get` and never resubmit automatically.

Records expose `record_id`, `revision`, `local_date`, `status`, `input_type`, `original_text`, `recognized_text`, `corrected_text`, `context`, `source:{title,url}`, `result:{language,summary_zh,vocabulary,grammar}`, and `image:{path,mime_type,byte_size,width,height,sha256}`. History lists are `{items,has_more}` with each item's `text` summary. `images.url` accepts `{record_id}`, returning a 60-second private URL. Preview fields are not durable complete results.

`review.today`, `review.get({batch_id})`, and `review.opened({batch_id})` return `{batch}`. Batch cards have `id`, `record_id`, `term`, `reading`, `language`, `meaning`, `example:{text,translation}`, `local_date`. IDs identify stable positions inside a note: a regenerated note updates the existing card contents in old batches; newly added positions get new IDs and removed positions disappear. This is not semantic deduplication. Deleting the note removes all its batch references. Push notifications deep-link to `/?batch=<id>`. Email reminders are retired; historical delivery audit remains, unfinished email deliveries are disabled, and no new email delivery can be claimed.

The public settings contract `cloud/2` exposes `review_enabled`, `push_enabled`, `explanation_mode` and account-scoped `font_theme`. Its allowed values are `handwritten`, `bookish` and `clean`, defaulting to `clean`. A partial settings update preserves the other preferences. Invalid themes and attempts to submit `email_enabled` fail with `INVALID_SETTINGS`. `settings.get` also returns `vapid_public_key` and `pwa_url`; it has no email reminder fields.

## Encrypted maintenance backup

Use `node scripts/cloud-backup.mjs --out <new-directory>` weekly and before upgrades. Supply a strong passphrase of at least 16 characters through `LINGO_BACKUP_PASSPHRASE` in the process environment, never through an argument or a logged command. The command uses the existing privileged CLI login through `cloud-admin.mjs`. Keep the encrypted directory and its passphrase separately. No recurring backup job is installed by these scripts.

`lingo_backup_snapshot()` reads seven application tables in one SQL statement and one consistent PostgreSQL snapshot. Screenshot paths are immutable and each referenced image is downloaded separately and checked against its recorded byte size and SHA-256. The snapshot, manifest and each image are independently encrypted with AES-256-GCM using a scrypt-derived key. A backup becomes complete only after every file is written and verified. Vault/API keys, Auth users/tokens and push subscriptions are excluded; deleted records retain only their minimal markers, with no image. The current snapshot limit is 64 MiB and each image limit is 4 MiB.

Database and Storage do not share a transaction. If a screenshot is deleted while being backed up, the entire run fails instead of claiming a complete backup. This is an application backup, not point-in-time recovery or a backup of Supabase Auth and project configuration. An interrupted run remains `writing` and cannot be restored. Backups made before a deletion may still contain the deleted material.

For a controlled restore, stop application writes and the review Cron first, preserve the backup, and run `node scripts/cloud-restore.mjs --from <backup-directory>` with the same environment passphrase. The target must have the matching schema, an empty application dataset and image bucket, and the same Auth user IDs already present. The tool rejects nonempty targets and does not create/delete users or alter Vault. It authenticates all local files before uploading, uploads and reads back images, then restores database tables in one transaction. If any step fails it reports incomplete; a partial upload can leave objects requiring operator inspection, and an ambiguous commit must be checked before any retry. It never automatically deletes those objects or overwrites an existing dataset.

Successful restore preserves record IDs, dates and explicit font preferences, disables all review/notification settings, and marks unfinished requests interrupted. Existing cloud backups without `font_theme` use `clean`; their former email setting is forced off before insertion. It does not replay model calls or notification deliveries. Users must re-enter their API keys and re-register their notification devices before re-enabling reminders. `node --test test/cloud-backup.test.mjs` verifies actual encryption and the SQL against emulated Auth/Storage; no hosted backup or restore has been run by this test suite.

## Validation boundaries

`node --test test/cloud-backend.test.mjs` exercises the actual application SQL in an in-memory PostgreSQL engine and tests provider stream parsing and validation. Auth, Storage metadata and Vault are explicitly emulated there; these tests do not demonstrate hosted Vault encryption, real RLS over HTTP, real provider calls, iPhone delivery, or scheduled execution. Type-check functions with Deno before deploying. No successful configuration is a substitute for those live acceptance checks.

Free runtimes are bounded. Requests expire after 120 seconds; unfinished results become unknown/interrupted and require explicit retry. Cancellation and completion race through conditional database writes. Upstream processing may already be billable. Notification acceptance is distinct from display/opening; a lost provider response can cause duplicate push attempts, which reuse the same batch/tag.

Explanation mode is an account preference (`fast` by default, or `thinking`). A new request snapshots it in the same transaction that saves the record, after checking replay; it is excluded from the material idempotency hash. OCR always uses fast mode. Both modes issue one provider call, with 5,000/12,000 maximum output tokens respectively and the same 120-second request deadline. Reasoning content is never persisted or shown. `record.explanation_mode` describes the latest attempt; `result_mode` describes the last successfully saved full explanation. A failed retry leaves the preceding result and its mode intact. Backups retain this preference; restoring it never automatically resumes a model request, and notification/review settings remain disabled after restore.
