import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { PROJECT_REF, ROOT } from './cloud-config.mjs';

export const branch = 'main';
export const officialPagesName = 'lingo-notes';
export const validRef = value => /^[a-z]{20}$/.test(value ?? '') && value !== PROJECT_REF;
export const validAccount = value => /^[a-f0-9]{32}$/.test(value ?? '');
export const validPagesName = value => /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(value ?? '') && value !== officialPagesName;
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
export const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
export const fail = code => { throw new Error(code); };

function jsonOutput(stdout) {
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  try { return JSON.parse(text); }
  catch {
    // Machine-readable output may have a one-line CLI banner before the JSON.
    const start = text.split(/\r?\n/).findIndex(line => /^\s*[\[{]/.test(line));
    if (start < 0) fail('CLI_JSON_OUTPUT_INVALID');
    try { return JSON.parse(text.split(/\r?\n/).slice(start).join('\n')); }
    catch { fail('CLI_JSON_OUTPUT_INVALID'); }
  }
}

function list(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['rows', 'projects', 'data', 'result', 'functions', 'secrets', 'keys', 'api_keys']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  fail('CLI_INVENTORY_OUTPUT_INVALID');
}

export function serverKeys(value) {
  const keys = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [field, child] of Object.entries(node)) {
      if (typeof child === 'string' && ['api_key', 'key', 'value'].includes(field)) keys.push(child);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(value);
  function role(key) {
    try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; }
    catch { return null; }
  }
  const publishableKey = keys.find(k => k.startsWith('sb_publishable_')) ?? keys.find(k => role(k) === 'anon');
  const secretKey = keys.find(k => k.startsWith('sb_secret_')) ?? keys.find(k => role(k) === 'service_role');
  if (!publishableKey || !secretKey) fail('TARGET_PROJECT_KEYS_UNAVAILABLE');
  return { publishableKey, secretKey };
}

export function pickAccount(accounts, selected) {
  if (!Array.isArray(accounts)) fail('CLOUDFLARE_ACCOUNTS_UNAVAILABLE');
  const ids = [...new Set(accounts.map(account => account.id).filter(validAccount))];
  if (selected) {
    if (!ids.includes(selected)) fail('CLOUDFLARE_ACCOUNT_NOT_ACCESSIBLE');
    return selected;
  }
  if (ids.length !== 1) fail(ids.length ? 'CLOUDFLARE_ACCOUNT_REQUIRED' : 'CLOUDFLARE_ACCOUNTS_UNAVAILABLE');
  return ids[0];
}

export function pagesIdentity(raw, name) {
  const label = typeof raw?.subdomain === 'string' && /^([a-z0-9-]+)\.pages\.dev$/.exec(raw.subdomain)?.[1];
  if (!raw || raw.name !== name || !/^[a-z0-9_-]{1,100}$/i.test(raw.id ?? '') ||
      raw.source != null || raw.production_branch !== branch || !label ||
      label === officialPagesName || (label !== name && !label.startsWith(name + '-'))) {
    fail('PAGES_PROJECT_IDENTITY_NOT_VERIFIED');
  }
  return {
    id: raw.id, pwaUrl: 'https://' + raw.subdomain, deployed: Boolean(raw.canonical_deployment || raw.latest_deployment),
    installationId: raw.deployment_configs?.production?.env_vars?.LINGO_INSTALLATION_ID?.value ?? null
  };
}

function invoke(executable, args, { cwd, env = {}, timeout = 180_000, code }) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024, windowsHide: true
  });
  // Vendor output can include credentials or SQL, including when a command fails.
  if (result.status !== 0) fail(result.error?.code === 'ETIMEDOUT' ? code + '_TIMEOUT' : code);
  return result.stdout;
}

function checked(response, code) {
  if (response.error || response.data == null) fail(code);
  return response.data;
}

export async function localStage(run) {
  // CLI transfer files only exist in an owned temporary directory, outside the repository.
  const temporary = realpathSync(tmpdir());
  const stage = mkdtempSync(resolve(temporary, 'lingo-self-host-stage-'));
  if (realpathSync(stage) !== stage || !stage.startsWith(temporary + sep + 'lingo-self-host-stage-')) fail('UNSAFE_STAGING_DIRECTORY');
  const cleanup = () => rmSync(stage, { recursive: true, force: true });
  process.once('exit', cleanup);
  try { return await run(stage); }
  finally { process.removeListener('exit', cleanup); cleanup(); }
}

export async function createPlatform(stage, options, root = ROOT) {
  const { ref, pagesName } = options;
  if (!validRef(ref) || !validPagesName(pagesName)) fail('INVALID_SELF_HOST_TARGET');
  const cliPath = resolve(root, 'node_modules/supabase/dist/supabase.js');
  const wranglerPath = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const scoped = `--remote=${ref}`;
  const url = `https://${ref}.supabase.co`;
  const cloudEnv = { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
  const supabase = (args, code, json = true) => {
    const output = invoke(cliPath, [...args, '--agent', 'no', '--output-format', json ? 'json' : 'text',
      ...(json ? ['--output', 'json'] : [])], { cwd: stage, env: { DO_NOT_TRACK: '1', NO_COLOR: '1' }, code });
    return json ? jsonOutput(output) : undefined;
  };
  const wrangler = (args, code, env = {}, timeout = 180_000) =>
    invoke(wranglerPath, args, { cwd: stage, env: { ...cloudEnv, ...env }, code, timeout });
  const projectRows = list(supabase(['projects', 'list'], 'SUPABASE_LOGIN_OR_PROJECT_LIST_FAILED'));
  const targetProject = projectRows.find(project => project.ref === ref || project.id === ref);
  if (!targetProject) fail('SUPABASE_PROJECT_NOT_ACCESSIBLE');
  if (targetProject.status && targetProject.status !== 'ACTIVE_HEALTHY') fail('SUPABASE_PROJECT_NOT_HEALTHY');
  const identity = jsonOutput(wrangler(['whoami', '--json'], 'CLOUDFLARE_LOGIN_REQUIRED'));
  const account = pickAccount(identity.accounts, options.account);
  const auth = jsonOutput(wrangler(['auth', 'token', '--json'], 'CLOUDFLARE_TOKEN_UNAVAILABLE'));
  if (!['oauth', 'api_token'].includes(auth.type) || typeof auth.token !== 'string' || !auth.token.trim()) fail('CLOUDFLARE_SCOPED_TOKEN_REQUIRED');
  const pagesApi = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`;
  const requestPages = async (path, method, body) => {
    const response = await fetch(pagesApi + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    }).catch(() => fail('PAGES_API_UNREACHABLE'));
    if (response.status === 404 && method === 'GET') return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success || !payload.result) fail(method === 'POST' ? 'PAGES_CREATE_FAILED_OR_UNCONFIRMED' : 'PAGES_PROJECT_READ_FAILED');
    return pagesIdentity(payload.result, pagesName);
  };
  let keys;
  const getKeys = () => keys ??= serverKeys(supabase(['projects','api-keys',scoped,'--reveal'], 'TARGET_PROJECT_KEYS_UNAVAILABLE'));
  let db;
  const getAdmin = () => db ??= createClient(url, getKeys().secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const writeStageFile = (name, contents, use) => {
    const path = resolve(stage, name);
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
    try { return use(path); }
    finally { rmSync(path, { force: true }); }
  };
  function query(sql, { write = false, code = 'TARGET_DATABASE_READ_FAILED' } = {}) {
    return writeStageFile('self-host-query.sql', sql, path => {
      const result = supabase(['db', 'query', scoped, '--file', path, write ? '--yes' : '--read-only'], code);
      return write ? result : list(result);
    });
  }
  return {
    account, url,
    getProject: () => requestPages('/' + pagesName, 'GET'),
    createPages: installationId => requestPages('', 'POST', {
      name: pagesName, production_branch: branch,
      deployment_configs: { production: { env_vars: { LINGO_INSTALLATION_ID: { type: 'plain_text', value: installationId } } } }
    }),
    query,
    functions: () => list(supabase(['functions', 'list', scoped], 'TARGET_FUNCTION_LIST_FAILED')),
    secrets: () => list(supabase(['secrets', 'list', scoped], 'TARGET_SECRET_LIST_FAILED')),
    setupAuth(pwaUrl) {
      const path = resolve(stage, 'supabase');
      mkdirSync(path, { recursive: true });
      const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8')
        .replaceAll('https://lingo-notes.pages.dev', pwaUrl);
      writeFileSync(resolve(path, 'config.toml'), config);
      // config push reports a successful no-op as text in the Windows CLI.
      // Use the explicit ref and verify Auth against the target afterward.
      supabase(['config', 'push', scoped, '--yes'], 'AUTH_CONFIG_FAILED', false);
    },
    uploadSecrets(values) {
      const contents = Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n';
      writeStageFile('self-host-secrets.env', contents, path =>
        supabase(['secrets', 'set', scoped, '--env-file', path, '--yes'], 'SERVER_SECRETS_UPLOAD_FAILED', false)
      );
    },
    deployFunctions() {
      const source = resolve(root, 'supabase/functions');
      cpSync(source, resolve(stage, 'supabase/functions'), {
        recursive: true,
        filter: file => !relative(source, file).split(/[\\/]/).some(part => /^\.env(?:\.|$)/.test(part) || ['.temp', 'node_modules'].includes(part))
      });
      supabase(['functions', 'deploy', 'app-api', 'review-tick', scoped, '--use-api', '--yes'], 'FUNCTION_DEPLOY_FAILED', false);
    },
    publishableKey: () => getKeys().publishableKey,
    createOwner: async (email, instance) => {
      const result = checked(await getAdmin().auth.admin.createUser({
        email, email_confirm: true, app_metadata: { lingo_self_host_instance: instance }
      }), 'OWNER_CREATION_FAILED');
      if (!result.user?.id) fail('OWNER_CREATION_NOT_CONFIRMED');
    },
    setupLink: async (email, pwaUrl) => {
      const result = checked(await getAdmin().auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: pwaUrl } }), 'OWNER_SETUP_LINK_FAILED');
      if (!result.properties?.hashed_token || result.properties.redirect_to !== pwaUrl &&
          result.properties.redirect_to !== pwaUrl + '/') fail('OWNER_SETUP_LINK_NOT_CONFIRMED');
      const link = new URL(pwaUrl);
      link.hash = new URLSearchParams({ token_hash: result.properties.hashed_token, token_type: 'recovery' }).toString();
      return link.href;
    },
    build(configPath, keyPath, output) {
      const stdout = invoke(resolve(root, 'scripts/build.mjs'), ['--profile', 'self-host', '--config', configPath, '--extension-key', keyPath, '--out', output], {
        cwd: root, code: 'SELF_HOST_BUILD_FAILED'
      });
      return stdout;
    },
    deployPwa(path) {
      wrangler(['pages', 'deploy', path, '--project-name', pagesName, '--branch', branch, '--commit-dirty=true'], 'PWA_DEPLOY_FAILED_OR_UNCONFIRMED', {
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: auth.token
      }, 600_000);
    }
  };
}
