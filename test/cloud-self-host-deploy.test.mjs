import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { optionsFrom, checkTargets, runSelfHost, verifySecretValues } from '../scripts/deploy-self-host.mjs';
import { PROJECT_REF, ROOT } from '../scripts/cloud-config.mjs';
import { markerFor, applyMigrations, ensureCron, inspectDatabase, sha256 } from '../scripts/self-host-database.mjs';
import { pagesIdentity, pickAccount, serverKeys } from '../scripts/self-host-platform.mjs';
import { newState, stateStore, verifyLocalState } from '../scripts/self-host-state.mjs';

const REF = 'abcdefghijklmnopqrst';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const email = 'owner@example.invalid';
const pagesName = 'new-lingo-deployment';
const pwaUrl = 'https://' + pagesName + '.pages.dev';
const params = args => ['--supabase-ref', REF, '--pages-project', pagesName, '--owner-email', email, ...args];
const blank = { installation: null, populated: false, ledger: false };
const platformOptions = optionsFrom(params([]));

test('self-host invocation protects official targets, requires explicit identity and does not accept write flags in a dry run', () => {
  assert.deepEqual(optionsFrom(params(['--dry-run'])), { ...platformOptions, dryRun: true });
  assert.throws(() => optionsFrom(['--supabase-ref', PROJECT_REF, '--pages-project', pagesName, '--owner-email', email]), /PROTECTED/);
  assert.throws(() => optionsFrom(['--supabase-ref', REF, '--pages-project', 'lingo-notes', '--owner-email', email]), /PROTECTED/);
  assert.throws(() => optionsFrom(params(['--cloudflare-account', 'not-an-account'])), /PROTECTED/);
  assert.throws(() => optionsFrom(params(['--dry-run', '--setup-link'])), /PROTECTED/);
  assert.throws(() => optionsFrom(params(['--token', 'synthetic-value'])), /Unknown option/);
});

test('provider account, project metadata and API keys are checked and separated', () => {
  const other = 'a'.repeat(32);
  assert.equal(pickAccount([{ id: ACCOUNT }]), ACCOUNT);
  assert.equal(pickAccount([{ id: ACCOUNT }, { id: other }], other), other);
  assert.throws(() => pickAccount([{ id: ACCOUNT }, { id: other }]), /CLOUDFLARE_ACCOUNT_REQUIRED/);
  assert.throws(() => pickAccount([{ id: ACCOUNT }], other), /NOT_ACCESSIBLE/);
  const row = { id: 'fixture-project', name: pagesName, production_branch: 'main', subdomain: pwaUrl.slice(8), source: null };
  assert.deepEqual(pagesIdentity(row, pagesName), { id: row.id, pwaUrl, deployed: false, installationId: null });
  assert.throws(() => pagesIdentity({ ...row, source: { type: 'github' } }, pagesName), /IDENTITY_NOT_VERIFIED/);
  assert.throws(() => pagesIdentity({ ...row, subdomain: 'lingo-notes.pages.dev' }, pagesName), /IDENTITY_NOT_VERIFIED/);
  assert.throws(() => pagesIdentity({ ...row, subdomain: 'different-project.pages.dev' }, pagesName), /IDENTITY_NOT_VERIFIED/);
  const keys = serverKeys({ result: { keys: [{ key: 'sb_secret_fixture_private_value' }, { api_key: 'sb_publishable_fixture_public_value' }] } });
  assert.equal(keys.publishableKey, 'sb_publishable_fixture_public_value');
  assert.equal(keys.secretKey, 'sb_secret_fixture_private_value');
  assert.throws(() => serverKeys([{ api_key: keys.secretKey }]), /PROJECT_KEYS_UNAVAILABLE/);
});

test('new instances refuse non-empty or mismatched remote targets before a deployment can write', () => {
  assert.doesNotThrow(() => checkTargets(null, blank, null, [], [{ name: 'SUPABASE_URL' }]));
  assert.throws(() => checkTargets(null, { ...blank, populated: true }, null, [], []), /EMPTY_SUPABASE/);
  assert.throws(() => checkTargets(null, blank, null, [{ slug: 'unrelated' }], []), /EMPTY_SUPABASE/);
  assert.throws(() => checkTargets(null, blank, null, [], [{ name: 'DIFFERENT_APP_API_KEY' }]), /EMPTY_SUPABASE/);
  const state = newState(platformOptions, ACCOUNT);
  const project = { id: 'pages-fixture', pwaUrl, installationId: state.installationId, deployed: false };
  const managed = { installation: markerFor(state), populated: true, ledger: true };
  assert.doesNotThrow(() => checkTargets(state, managed, project, [], []));
  assert.throws(() => checkTargets(null, managed, project, [], []), /SUPABASE_INSTALLATION_OWNERSHIP/);
  assert.throws(() => checkTargets(state, managed, { ...project, installationId: null }, [], []), /PAGES_PROJECT_OWNERSHIP/);
  assert.throws(() => checkTargets({ ...state, pagesId: 'different' }, managed, project, [], []), /PAGES_PROJECT_OWNERSHIP/);
  assert.throws(() => checkTargets(state, managed, project, [{ slug: 'unrelated' }], []), /UNEXPECTED_SUPABASE_FUNCTION/);
  assert.throws(() => verifyLocalState(state, { ...platformOptions, email: 'other@example.invalid' }, ACCOUNT), /LOCAL_SELF_HOST_TARGET_MISMATCH/);
  assert.doesNotMatch(JSON.stringify(state), /owner@example\.invalid/);
});

test('an existing publication or Cron secret is only reused after digest readback', () => {
  const privateDummyValue = 'masked fixture string';
  const values = { VAPID_PRIVATE_KEY: privateDummyValue, OTHER: 'other fixture string' };
  const existing = [{ name: 'VAPID_PRIVATE_KEY', value: sha256(privateDummyValue) }];
  assert.deepEqual(verifySecretValues(values, existing, { allowMissing: true }), { OTHER: values.OTHER });
  assert.throws(() => verifySecretValues(values, existing), /SERVER_SECRET_DRIFT_OR_UNVERIFIED/);
  assert.throws(() => verifySecretValues(values, [{ name: 'VAPID_PRIVATE_KEY', digest: 'wrong' }], { allowMissing: true }), /SERVER_SECRET_DRIFT_OR_UNVERIFIED/);
});

test('the default managed pgbouncer function does not hide foreign workloads', async () => {
  let inventory;
  inspectDatabase({ query(sql) {
    inventory = sql;
    return [{ managed: false, populated: false, ledger: false }];
  } });
  const db = new PGlite();
  try {
    await db.exec(`create schema auth; create table auth.users(id int);
      create schema storage; create table storage.buckets(id int);
      create schema pgbouncer;
      create function pgbouncer.get_auth(text) returns text language sql as 'select $1';`);
    assert.equal((await db.query(inventory)).rows[0].populated, false);
    await db.exec("create function pgbouncer.foreign_function() returns int language sql as 'select 1';");
    assert.equal((await db.query(inventory)).rows[0].populated, true);
    await db.exec('drop function pgbouncer.foreign_function(); create table pgbouncer.foreign_table(id int);');
    assert.equal((await db.query(inventory)).rows[0].populated, true);
  } finally { await db.close(); }
});

test('migration interruption resumes from the verified prefix and refuses changed checksums', () => {
  const directory = resolve(ROOT, 'supabase/migrations');
  const expected = readdirSync(directory).filter(name => /^\d{12}_.+\.sql$/.test(name)).sort()
    .map(name => ({ name, sha256: sha256(readFileSync(resolve(directory, name), 'utf8').replace(/\r\n/g, '\n')) }));
  const managed = [];
  const writes = [];
  let interrupt = true;
  const platform = { query(sql, { write = false } = {}) {
    if (!write && sql.includes('lingo_deployments')) return managed.map(row => ({ ...row }));
    if (!write && sql.includes('storage.buckets')) return [{ public: false, file_size_limit: 4194304, allowed_mime_types: ['image/png'] }];
    const [match, name, digest] = sql.match(/insert into public\.lingo_deployments\(name,sha256\) values \('([^']+)','([^']+)'\)/i);
    assert.ok(match && sql.startsWith('begin;') && sql.trim().endsWith('commit;'));
    if (managed.length === 2 && interrupt) throw Error('SIMULATED_NETWORK_INTERRUPTION');
    writes.push(name);
    managed.push({ name, sha256: digest });
  } };
  assert.throws(() => applyMigrations(platform, ROOT), /SIMULATED_NETWORK_INTERRUPTION/);
  assert.deepEqual(managed, expected.slice(0, 2));
  interrupt = false;
  applyMigrations(platform, ROOT);
  assert.deepEqual(managed, expected);
  applyMigrations(platform, ROOT);
  assert.deepEqual(writes, expected.map(row => row.name));
  managed[0].sha256 = 'altered';
  assert.throws(() => applyMigrations(platform, ROOT), /MIGRATION_LEDGER_CHANGED/);
});

test('Cron verifies its existing function command and preserves a manually paused schedule', () => {
  const captures = [];
  const platform = { url: 'https://' + REF + '.supabase.co', query(sql, opts) {
    captures.push({ sql, opts });
    return opts?.write ? {} : [{ active: false, schedule: '*/5 * * * *', command_confirmed: true }];
  } };
  assert.equal(ensureCron(platform, 'f'.repeat(64)), 'paused');
  assert.match(captures[0].sql, /if not found then\s+perform cron\.schedule/);
  assert.match(captures[0].sql, /CRON_SECRET_CHANGED/);
  assert.doesNotMatch(captures[0].sql, /cron\.unschedule|vault\.update_secret/);
  assert.equal(captures[0].opts.write, true);
  assert.equal(captures[1].opts, undefined);
});

test('dry run consults both providers without locking, allocating keys, or provisioning anything', async () => {
  const options = { ...platformOptions, dryRun: true };
  const recorded = [];
  const platform = {
    account: ACCOUNT,
    query(sql) {
      assert.match(sql, /to_regclass/);
      recorded.push('database');
      return [{ managed: false, populated: false, ledger: false }];
    },
    functions: () => [],
    secrets: () => [],
    getProject: async () => { recorded.push('pages'); return null; },
    createPages: async () => assert.fail('dry-run must not create a site')
  };
  const store = {
    read: () => null, save: () => assert.fail('dry-run must not persist state'),
    lock: () => assert.fail('dry-run must not obtain write lock'),
    secureValues: () => assert.fail('dry-run must not generate secrets')
  };
  const result = await runSelfHost(options, platform, store, 'unused');
  assert.deepEqual(recorded, ['database', 'pages']);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.project, REF);
  assert.equal(result.existing_installation, false);
});

test('a lost Pages creation response resumes matching ownership without creating another project', async () => {
  let local = null;
  let marker = null;
  let remotePages = null;
  let claims = 0, creates = 0, unlocked = 0;
  const fixture = {
    account: ACCOUNT,
    query(sql, opts) {
      if (!opts?.write && /to_regclass/.test(sql)) return [{ managed: Boolean(marker), populated: Boolean(marker), ledger: Boolean(marker) }];
      if (!opts?.write && /select installation_id/.test(sql)) return [marker];
      if (opts?.write && /lingo-notes-self-host-initialize/.test(sql)) {
        claims++;
        marker = markerFor(local);
        return {};
      }
      if (/select name, sha256/.test(sql)) throw Error('SYNTHETIC_STOP_BEFORE_MIGRATIONS');
      assert.fail('unexpected query');
    },
    functions: () => [],
    secrets: () => [],
    getProject: async () => remotePages,
    createPages: async installationId => {
      creates++;
      remotePages = { id: 'created-project', installationId, pwaUrl, deployed: false };
      throw Error('SYNTHETIC_PAGES_REPLY_LOST');
    }
  };
  const store = {
    read: () => local && structuredClone(local),
    save: next => { local = structuredClone(next); },
    lock: () => () => { unlocked++; }
  };
  await assert.rejects(runSelfHost(platformOptions, fixture, store, 'unused'), /create-pages: SYNTHETIC_PAGES_REPLY_LOST/);
  assert.equal(local.pagesId, undefined);
  const extKey = local.extensionKey;
  await assert.rejects(runSelfHost(platformOptions, fixture, store, 'unused'), /migrate-database: SYNTHETIC_STOP_BEFORE_MIGRATIONS/);
  assert.equal(local.extensionKey, extKey);
  assert.equal(local.pagesId, 'created-project');
  assert.deepEqual([claims, creates, unlocked], [1, 1, 2]);
});

test('the local checkpoint is atomic and a second process cannot start over an active lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'lingo-self-host-test-'));
  const safeTemp = resolve(tmpdir());
  assert.equal(dirname(resolve(root)), safeTemp);
  try {
    const store = stateStore(root, REF);
    assert.equal(store.read(), null);
    const unlock = store.lock();
    try {
      assert.throws(() => store.lock(), /DEPLOYMENT_LOCKED/);
      const state = newState(platformOptions, ACCOUNT);
      store.save(state);
      store.save({ ...state, claimed: true });
      assert.equal(store.read().claimed, true);
      assert.equal(store.read().extensionKey, state.extensionKey);
    } finally { unlock(); }
    const relock = store.lock();
    relock();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
