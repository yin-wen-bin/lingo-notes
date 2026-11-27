import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, quote } from './self-host-platform.mjs';

const markerName = 'lingo_self_host_installation';
const ledgerName = 'lingo_deployments';
const jobName = 'lingo-review-five-minutes';
const jobSchedule = '*/5 * * * *';
const cronCommand = `select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='lingo-cron-url'),
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='lingo-cron-secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
);`;

export const sha256 = value => createHash('sha256').update(value).digest('hex');

const applicationSchema = `n.nspname !~ '^pg_' and n.nspname not in (
  'information_schema', 'auth', 'storage', 'extensions', 'vault', 'realtime', '_realtime',
  'graphql', 'graphql_public', 'cron', 'net', 'supabase_functions', 'supabase_migrations',
  'supabase_realtime', 'pgsodium', 'pgsodium_masks', 'pgtle'
)`;
const applicationObjects = `exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where ${applicationSchema} and c.relkind in ('r','p','v','m','S','f')
    and not exists (
      select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e'
    )
) or exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where ${applicationSchema} and not (n.nspname='pgbouncer' and p.proname='get_auth') and not exists (
    select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
  )
)`;
const existingApplication = `(${applicationObjects})
  or exists (select 1 from auth.users)
  or exists (select 1 from storage.buckets)`;

export function inspectDatabase(platform) {
  const [row] = platform.query(`select
    to_regclass('public.${markerName}') is not null as managed,
    (${existingApplication}) as populated,
    to_regclass('public.${ledgerName}') is not null as ledger;`);
  if (typeof row?.managed !== 'boolean' || typeof row.populated !== 'boolean' || typeof row.ledger !== 'boolean') fail('DATABASE_INVENTORY_UNVERIFIED');
  let installation = null;
  if (row.managed) {
    const markers = platform.query(`select installation_id, project_ref, cloudflare_account, pages_project, owner_fingerprint from public.${markerName};`);
    if (markers.length !== 1) fail('DATABASE_OWNERSHIP_MARKER_UNVERIFIED');
    [installation] = markers;
  }
  return { installation, populated: row.populated, ledger: row.ledger };
}

export function markerFor(state) {
  return {
    installation_id: state.installationId,
    project_ref: state.ref,
    cloudflare_account: state.account,
    pages_project: state.pagesName,
    owner_fingerprint: state.ownerFingerprint
  };
}

export function verifyInstallation(actual, state) {
  return Boolean(actual && state && Object.entries(markerFor(state)).every(([key, value]) => actual[key] === value));
}

export function initializeDatabase(platform, state) {
  const columns = markerFor(state);
  platform.query(`begin;
  select pg_advisory_xact_lock(hashtext('lingo-notes-self-host-initialize'));
  do $installer$ begin
    if ${existingApplication} then raise exception 'SUPABASE_PROJECT_NOT_EMPTY'; end if;
  end $installer$;
  create table public.${markerName} (
    installation_id uuid primary key,
    project_ref text not null,
    cloudflare_account text not null,
    pages_project text not null,
    owner_fingerprint text not null
  );
  alter table public.${markerName} enable row level security;
  revoke all on public.${markerName} from public, anon, authenticated;
  insert into public.${markerName} (${Object.keys(columns).join(',')}) values (${Object.values(columns).map(quote).join(',')});
  create table public.${ledgerName} (name text primary key, sha256 text not null, applied_at timestamptz not null default now());
  alter table public.${ledgerName} enable row level security;
  revoke all on public.${ledgerName} from public, anon, authenticated;
  commit;`, { write: true, code: 'INSTALLATION_DATABASE_CLAIM_FAILED' });
}

export function applyMigrations(platform, root) {
  const directory = resolve(root, 'supabase/migrations');
  const files = readdirSync(directory).filter(name => /^\d{12}_[a-z0-9_]+\.sql$/.test(name)).sort()
    .map(name => {
      const sql = readFileSync(resolve(directory, name), 'utf8').replace(/\r\n/g, '\n');
      return { name, sql, digest: sha256(sql) };
    });
  if (!files.length) fail('MIGRATIONS_REQUIRED');
  const read = () => platform.query(`select name, sha256 from public.${ledgerName} order by name;`);
  const applied = read();
  // A complete verified prefix is the only state our ordered, transactional runner writes.
  if (applied.length > files.length || applied.some((row, index) => row.name !== files[index].name || row.sha256 !== files[index].digest)) fail('DATABASE_MIGRATION_LEDGER_CHANGED');
  for (const file of files.slice(applied.length)) {
    platform.query(`begin;
      ${file.sql}
      insert into public.${ledgerName}(name,sha256) values (${quote(file.name)},${quote(file.digest)});
      commit;`, { write: true, code: 'DATABASE_MIGRATION_FAILED' });
  }
  const migrated = read();
  if (migrated.length !== files.length || migrated.some((row, index) => row.name !== files[index].name || row.sha256 !== files[index].digest)) fail('DATABASE_MIGRATION_READBACK_FAILED');
  const [storage] = platform.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='lingo-images';`);
  if (storage?.public !== false || Number(storage.file_size_limit) !== 4194304 || !storage.allowed_mime_types?.includes('image/png')) fail('PRIVATE_SCREENSHOT_STORAGE_NOT_VERIFIED');
}

export function inspectOwner(platform, email, installationId) {
  const rows = platform.query(`select id,
    (raw_app_meta_data->>'lingo_self_host_instance'=${quote(installationId)}) as owned,
    (nullif(encrypted_password,'') is not null) as has_password
    from auth.users where lower(email)=${quote(email)};`);
  if (rows.length > 1 || rows.length === 1 && (rows[0].owned !== true || typeof rows[0].has_password !== 'boolean')) fail('OWNER_ACCOUNT_NOT_VERIFIED');
  return rows[0] ?? null;
}

export function ensureOwnerDefaults(platform, owner) {
  platform.query(`insert into public.lingo_settings(user_id) values (${quote(owner.id)}) on conflict (user_id) do nothing;`,
    { write: true, code: 'OWNER_SETTINGS_INIT_FAILED' });
  const [settings] = platform.query(`select review_enabled, push_enabled from public.lingo_settings where user_id=${quote(owner.id)};`);
  if (typeof settings?.review_enabled !== 'boolean' || typeof settings.push_enabled !== 'boolean') fail('OWNER_SETTINGS_READBACK_FAILED');
  return settings;
}

export function ensureCron(platform, secret) {
  const expectedUrl = `${platform.url}/functions/v1/review-tick`;
  platform.query(`begin;
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
  do $installer$
  declare
    found_secret text;
    existing_job cron.job%rowtype;
  begin
    select decrypted_secret into found_secret from vault.decrypted_secrets where name='lingo-cron-url';
    if not found then
      perform vault.create_secret(${quote(expectedUrl)}, 'lingo-cron-url');
    elsif found_secret is distinct from ${quote(expectedUrl)} then
      raise exception 'CRON_URL_CHANGED';
    end if;
    select decrypted_secret into found_secret from vault.decrypted_secrets where name='lingo-cron-secret';
    if not found then
      perform vault.create_secret(${quote(secret)}, 'lingo-cron-secret');
    elsif found_secret is distinct from ${quote(secret)} then
      raise exception 'CRON_SECRET_CHANGED';
    end if;
    select * into existing_job from cron.job where jobname=${quote(jobName)};
    if not found then
      perform cron.schedule(${quote(jobName)},${quote(jobSchedule)},${quote(cronCommand)});
    elsif existing_job.schedule is distinct from ${quote(jobSchedule)} or existing_job.command is distinct from ${quote(cronCommand)} then
      raise exception 'CRON_JOB_CHANGED';
    end if;
  end $installer$;
  commit;`, { write: true, code: 'CRON_SETUP_FAILED_OR_DRIFTED' });
  const jobs = platform.query(`select active, schedule, command=${quote(cronCommand)} as command_confirmed
    from cron.job where jobname=${quote(jobName)};`);
  if (jobs.length !== 1 || jobs[0].schedule !== jobSchedule || jobs[0].command_confirmed !== true || typeof jobs[0].active !== 'boolean') fail('CRON_READBACK_FAILED');
  return jobs[0].active ? 'active' : 'paused';
}
