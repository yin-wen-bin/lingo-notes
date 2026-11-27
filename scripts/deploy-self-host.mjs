import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ROOT } from './cloud-config.mjs';
import { extensionIdentity } from './build.mjs';
import { inspectExtension, zipFiles } from './package-extension.mjs';
import { createPlatform, fail, localStage, validAccount, validEmail, validPagesName, validRef } from './self-host-platform.mjs';
import { applyMigrations, ensureCron, ensureOwnerDefaults, initializeDatabase, inspectDatabase, inspectOwner, sha256, verifyInstallation } from './self-host-database.mjs';
import { newState, stateStore, verifyLocalState } from './self-host-state.mjs';

const stages = [
  'preflight', 'claim-database', 'create-pages', 'migrate-database', 'configure-auth', 'deploy-functions',
  'configure-review', 'build-apps', 'deploy-pwa', 'invite-owner'
];
const functionSlugs = ['app-api', 'review-tick'];
const managedSecretNames = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET', 'VAPID_SUBJECT', 'ALLOWED_ORIGINS', 'PWA_URL'];
const errorCode = error => /^[A-Z][A-Z0-9_]{2,119}$/.test(error?.message ?? '') ? error.message : 'SELF_HOST_DEPLOYMENT_FAILED';

export function optionsFrom(args) {
  const options = parseArgs({ args, strict: true, allowPositionals: false, options: {
    'supabase-ref': { type: 'string' }, 'pages-project': { type: 'string' }, 'owner-email': { type: 'string' },
    'cloudflare-account': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'setup-link': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  } }).values;
  if (options.help) return { help: true };
  const ref = options['supabase-ref'];
  const pagesName = options['pages-project'];
  const email = options['owner-email']?.trim().toLowerCase();
  const account = options['cloudflare-account'];
  if (!validRef(ref) || !validPagesName(pagesName) || !validEmail(email) || (account && !validAccount(account)) ||
      (account !== undefined && !account) || (options['dry-run'] && options['setup-link'])) fail('INVALID_OR_PROTECTED_SELF_HOST_TARGET');
  return { ref, pagesName, email, account, dryRun: Boolean(options['dry-run']), setupLink: Boolean(options['setup-link']) };
}

export function checkTargets(state, database, project, functions, secrets) {
  if (database.installation) {
    if (!verifyInstallation(database.installation, state) || !database.ledger) fail('SUPABASE_INSTALLATION_OWNERSHIP_NOT_VERIFIED');
    if (functions.some(row => !functionSlugs.includes(row.slug))) fail('UNEXPECTED_SUPABASE_FUNCTION');
    if (secrets.some(row => !managedSecretNames.includes(row.name) && !row.name?.startsWith('SUPABASE_'))) fail('UNEXPECTED_SUPABASE_SECRET');
  } else if (database.populated || state?.claimed || functions.length ||
      secrets.some(row => !row.name?.startsWith('SUPABASE_'))) fail('DEDICATED_EMPTY_SUPABASE_PROJECT_REQUIRED');
  if (project) {
    if (!state || project.installationId !== state.installationId ||
        state.pagesId && (project.id !== state.pagesId || project.pwaUrl !== state.pwaUrl)) fail('PAGES_PROJECT_OWNERSHIP_NOT_VERIFIED');
  } else if (state?.pagesId) fail('EXISTING_PAGES_PROJECT_MISSING');
}

export function verifySecretValues(values, remote, { allowMissing = false } = {}) {
  const missing = {};
  for (const [name, value] of Object.entries(values)) {
    const matches = remote.filter(row => row.name === name);
    if (matches.length === 0 && allowMissing) { missing[name] = value; continue; }
    const remoteDigest = matches[0]?.digest ?? matches[0]?.value;
    if (matches.length !== 1 || remoteDigest !== sha256(value)) fail('SERVER_SECRET_DRIFT_OR_UNVERIFIED');
  }
  return missing;
}

function functionsSnapshot(remote) {
  const result = {};
  if (remote.length !== functionSlugs.length) return null;
  for (const slug of functionSlugs) {
    const rows = remote.filter(row => row.slug === slug);
    if (rows.length !== 1 || typeof rows[0].id !== 'string' || !Number.isSafeInteger(rows[0].version) ||
        rows[0].status !== 'ACTIVE' || rows[0].verify_jwt !== false) return null;
    result[slug] = { id: rows[0].id, version: rows[0].version };
  }
  return result;
}

function digestTree(directory, accept = () => true) {
  const rows = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = resolve(path, entry.name);
      const rel = relative(directory, full).split(sep).join('/');
      if (!accept(rel)) continue;
      if (entry.isSymbolicLink()) fail('SELF_HOST_INPUT_SYMLINK_NOT_ALLOWED');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) rows.push([rel, sha256(readFileSync(full))]);
    }
  }
  visit(directory);
  return sha256(JSON.stringify(rows));
}

async function vendorGet(url, init = {}) {
  try { return await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12_000), ...init }); }
  catch { return null; }
}

async function verifyBackend(platform, publishableKey, pwaUrl, extensionId, freshSecret) {
  const headers = { apikey: publishableKey };
  const settings = await vendorGet(platform.url + '/auth/v1/settings', { headers });
  const payload = await settings?.json().catch(() => null);
  if (!settings?.ok || payload?.disable_signup !== true || payload?.external?.email !== true) fail('INVITATION_ONLY_AUTH_NOT_VERIFIED');
  const app = platform.url + '/functions/v1/app-api';
  for (const origin of [pwaUrl, 'chrome-extension://' + extensionId]) {
    const result = await vendorGet(app, { method: 'OPTIONS', headers: {
      ...headers, Origin: origin, 'Access-Control-Request-Method': 'POST'
    } });
    if (result?.status !== 204 || result.headers.get('Access-Control-Allow-Origin') !== origin) fail('APP_ORIGIN_NOT_VERIFIED');
  }
  const denied = await vendorGet(app, { method: 'OPTIONS', headers: { ...headers, Origin: 'https://self-host-check.invalid' } });
  if (denied?.status !== 403) fail('APP_ORIGIN_BOUNDARY_NOT_VERIFIED');
  const tick = platform.url + '/functions/v1/review-tick';
  const unauthenticated = await vendorGet(tick, { method: 'POST', headers });
  const denial = await unauthenticated?.json().catch(() => null);
  if (unauthenticated?.status !== 401 || denial?.error !== 'UNAUTHORIZED') fail('REVIEW_TICK_AUTH_NOT_VERIFIED');
  // A credentialed tick on a previously used site could deliver a real review.
  // On a new empty install only, verify its injected Supabase server credential.
  if (freshSecret) {
    const check = await vendorGet(tick, { method: 'POST', headers: { ...headers, 'x-cron-secret': freshSecret } });
    const result = await check?.json().catch(() => null);
    if (!check?.ok || result?.ok !== true || result.result?.accepted !== 0 || result.result?.batches !== 0) fail('REVIEW_TICK_EMPTY_PROJECT_NOT_VERIFIED');
  }
}

function writePublicBuildInputs(stage, pwaUrl, platform, secret, state) {
  const configPath = resolve(stage, 'cloud.public.json');
  const keyPath = resolve(stage, 'extension-public-key.txt');
  const config = { url: platform.url, pwaUrl, publishableKey: platform.publishableKey(), vapidPublicKey: secret.VAPID_PUBLIC_KEY };
  writeFileSync(configPath, JSON.stringify(config) + '\n', { flag: 'wx' });
  writeFileSync(keyPath, state.extensionKey + '\n', { flag: 'wx' });
  return { configPath, keyPath };
}

function buildAndPackage(platform, stage, store, project, state, secret) {
  const { configPath, keyPath } = writePublicBuildInputs(stage, project.pwaUrl, platform, secret, state);
  const build = store.buildDirectory();
  platform.build(configPath, keyPath, build);
  const info = JSON.parse(readFileSync(resolve(build, 'build-info.json'), 'utf8'));
  const extensionId = extensionIdentity(state.extensionKey).id;
  if (info.profile !== 'self-host' || info.extension_id !== extensionId || info.project_ref !== state.ref ||
      info.pwa_url !== project.pwaUrl || !info.configured ||
      resolve(info.extension_path) !== resolve(build, 'extension') || resolve(info.pwa_path) !== resolve(build, 'pwa')) fail('SELF_HOST_BUILD_TARGET_MISMATCH');
  const inspected = inspectExtension(info.extension_path);
  if (inspected.manifest.key !== state.extensionKey || inspected.manifest.host_permissions[0] !== platform.url + '/*' ||
      inspected.manifest.version !== info.version) fail('SELF_HOST_PACKAGE_TARGET_MISMATCH');
  const zip = zipFiles(inspected.files);
  const hash = sha256(zip);
  const directory = store.artifactsDirectory();
  mkdirSync(directory, { recursive: true });
  const zipName = `lingo-notes-${info.version}-self-host-${hash.slice(0,12)}.zip`;
  const zipPath = resolve(directory, zipName);
  if (existsSync(zipPath)) {
    if (lstatSync(zipPath).isSymbolicLink() || sha256(readFileSync(zipPath)) !== hash) fail('SELF_HOST_ARTIFACT_CONFLICT');
  } else writeFileSync(zipPath, zip, { flag: 'wx' });
  const pwaPath = info.pwa_path;
  const marker = { installationId: state.installationId, build: digestTree(pwaPath) };
  writeFileSync(resolve(pwaPath, 'lingo-instance.json'), JSON.stringify(marker) + '\n', { flag: 'wx' });
  return { info, zipPath, hash, marker };
}

async function readPublishedMarker(pwaUrl) {
  const response = await vendorGet(pwaUrl + '/lingo-instance.json', { cache: 'no-store' });
  const marker = response?.ok ? await response.json().catch(() => null) : null;
  return marker && /^[0-9a-f-]{36}$/.test(marker.installationId) && /^[0-9a-f]{64}$/.test(marker.build) ? marker : null;
}

async function verifyPublishedFiles(pwaUrl, pwaPath) {
  const index = readFileSync(resolve(pwaPath, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/(?:src|href)="\/(assets\/[a-z0-9_.-]+\.(?:css|js))"/gi)].map(match => match[1]);
  if (!assets.some(path => path.endsWith('.js'))) return false;
  const routes = [['/', 'index.html'], ['/sw.js', 'sw.js'], ['/manifest.webmanifest', 'manifest.webmanifest'],
    ['/privacy', 'privacy.html'], ['/support', 'support.html'], ...assets.map(path => ['/' + path, path])];
  const confirmed = await Promise.all(routes.map(async ([pathname, file]) => {
    const response = await vendorGet(pwaUrl + pathname, { cache: 'no-store' });
    if (!response?.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    return sha256(bytes) === sha256(readFileSync(resolve(pwaPath, file)));
  }));
  return confirmed.every(Boolean);
}

async function deployWebsite(platform, store, state, project, build) {
  const { pwaUrl } = project;
  let published = await readPublishedMarker(pwaUrl);
  if ((project.deployed || state.publishPending) && !published && state.publishPending) {
    // A timed out upload can still have won the race with the command.
    for (let retry = 0; retry < 5 && !published; retry++) {
      await delay(3000);
      published = await readPublishedMarker(pwaUrl);
    }
  }
  if (project.deployed && published?.installationId !== state.installationId ||
      published && published.installationId !== state.installationId) fail('PWA_CONTENT_OWNERSHIP_NOT_VERIFIED');
  if (published?.build !== build.marker.build || !await verifyPublishedFiles(pwaUrl, build.info.pwa_path)) {
    state.publishPending = true;
    store.save(state);
    await platform.deployPwa(build.info.pwa_path);
  }
  for (let retry = 0; retry < 8; retry++) {
    const marker = await readPublishedMarker(pwaUrl);
    if (marker?.installationId === state.installationId && marker.build === build.marker.build && await verifyPublishedFiles(pwaUrl, build.info.pwa_path)) {
      delete state.publishPending;
      state.pwaBuild = marker.build;
      store.save(state);
      return;
    }
    await delay(3000);
  }
  fail('PWA_PRODUCTION_READBACK_UNVERIFIED');
}

function baseSummary(state, project) {
  return { project: state.ref, cloudflare_account: state.account, pages_project: state.pagesName, pwa_url: project?.pwaUrl };
}

export async function runSelfHost(options, platform, store, stage, { root = ROOT, interactive = false, displaySecret = () => {}, progress = () => {} } = {}) {
  let current = 'preflight';
  const next = label => { current = label; progress(label); };
  let release;
  try {
    next('preflight');
    if (!options.dryRun) release = store.lock();
    let state = store.read();
    if (state) state = verifyLocalState(state, options, platform.account);
    const database = inspectDatabase(platform);
    let functions = platform.functions();
    let remoteSecrets = platform.secrets();
    let project = await platform.getProject();
    checkTargets(state, database, project, functions, remoteSecrets);
    const target = { ref: options.ref, account: platform.account, pagesName: options.pagesName };
    if (options.dryRun) return { status: 'dry-run', ...baseSummary(target, project), steps: stages, existing_installation: Boolean(database.installation) };

    if (options.setupLink) {
      if (!interactive) fail('SETUP_LINK_REQUIRES_INTERACTIVE_TERMINAL');
      if (!state?.ready || !project?.deployed) fail('COMPLETE_DEPLOYMENT_FIRST');
      const published = await readPublishedMarker(project.pwaUrl);
      if (published?.installationId !== state.installationId || published.build !== state.pwaBuild ||
          !await verifyPublishedFiles(project.pwaUrl, resolve(store.buildDirectory(), 'pwa'))) fail('PWA_SETUP_TARGET_NOT_VERIFIED');
      const owner = inspectOwner(platform, options.email, state.installationId);
      if (!owner) fail('DEPLOYED_OWNER_MISSING');
      displaySecret(await platform.setupLink(options.email, project.pwaUrl));
      if (!state.setupLinkIssued) { state.setupLinkIssued = true; store.save(state); }
      return { status: 'setup-link-shown', ...baseSummary(state, project) };
    }

    if (!state) { state = newState(options, platform.account); store.save(state); }
    next('claim-database');
    if (!database.installation) initializeDatabase(platform, state);
    if (!verifyInstallation(inspectDatabase(platform).installation, state)) fail('SUPABASE_INSTALLATION_OWNERSHIP_NOT_VERIFIED');
    state.claimed = true;
    store.save(state);

    next('create-pages');
    if (!project) {
      await platform.createPages(state.installationId);
      project = await platform.getProject();
    }
    if (project?.installationId !== state.installationId) fail('PAGES_PROJECT_OWNERSHIP_NOT_VERIFIED');
    state.pagesId = project.id;
    state.pwaUrl = project.pwaUrl;
    store.save(state);

    next('migrate-database');
    applyMigrations(platform, root);
    const extensionId = extensionIdentity(state.extensionKey).id;
    const secret = store.secureValues(state.installationId, remoteSecrets.map(row => row.name));
    const values = {
      VAPID_PUBLIC_KEY: secret.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: secret.VAPID_PRIVATE_KEY, CRON_SECRET: secret.CRON_SECRET,
      VAPID_SUBJECT: 'mailto:' + options.email, PWA_URL: project.pwaUrl, ALLOWED_ORIGINS: 'chrome-extension://' + extensionId
    };
    const publishableKey = platform.publishableKey();
    next('configure-auth');
    // Stage the target configuration even when already applied. The CLI only pushes actual differences.
    await platform.setupAuth(project.pwaUrl);
    const missing = verifySecretValues(values, remoteSecrets, { allowMissing: true });
    if (Object.keys(missing).length) {
      await platform.uploadSecrets(missing);
      remoteSecrets = platform.secrets();
    }
    verifySecretValues(values, remoteSecrets);

    next('deploy-functions');
    const sourceHash = digestTree(resolve(root, 'supabase/functions'), file => !file.split('/').some(part => /^\.env(?:\.|$)/.test(part) || ['.temp', 'node_modules'].includes(part)));
    let snapshot = functionsSnapshot(functions);
    if (!snapshot || state.functionSource !== sourceHash || JSON.stringify(snapshot) !== JSON.stringify(state.functions)) {
      await platform.deployFunctions();
      functions = platform.functions();
      snapshot = functionsSnapshot(functions);
    }
    if (!snapshot) fail('FUNCTIONS_READBACK_UNVERIFIED');
    const [lastUser] = platform.query('select not exists(select 1 from auth.users) as no_users;');
    await verifyBackend(platform, publishableKey, project.pwaUrl, extensionId, lastUser?.no_users === true ? secret.CRON_SECRET : null);
    state.functionSource = sourceHash;
    state.functions = snapshot;
    store.save(state);

    next('configure-review');
    const cron = ensureCron(platform, secret.CRON_SECRET);
    next('build-apps');
    const build = buildAndPackage(platform, stage, store, project, state, secret);
    next('deploy-pwa');
    await deployWebsite(platform, store, state, project, build);

    next('invite-owner');
    let owner = inspectOwner(platform, options.email, state.installationId);
    let created = false;
    if (!owner) {
      if (state.ready) fail('DEPLOYED_OWNER_MISSING');
      await platform.createOwner(options.email, state.installationId);
      created = true;
      owner = inspectOwner(platform, options.email, state.installationId);
    }
    if (!owner) fail('OWNER_CREATION_NOT_CONFIRMED');
    const settings = ensureOwnerDefaults(platform, owner);
    if (created && (settings.review_enabled || settings.push_enabled)) fail('NEW_OWNER_REVIEW_DEFAULTS_NOT_VERIFIED');
    state.ready = true;
    store.save(state);
    // Supabase may store a generated password hash before the invited owner sets a password.
    if (interactive && !state.setupLinkIssued) {
      displaySecret(await platform.setupLink(options.email, project.pwaUrl));
      state.setupLinkIssued = true;
      store.save(state);
    }
    return {
      status: 'ready', ...baseSummary(state, project), extension_id: extensionId,
      extension_directory: build.info.extension_path, extension_zip: build.zipPath, extension_zip_sha256: build.hash,
      schedule: cron, setup_link_available: !state.setupLinkIssued
    };
  } catch (error) { throw new Error(current + ': ' + errorCode(error)); }
  finally { if (release) release(); }
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = optionsFrom(args); }
  catch { fail('INVALID_OR_PROTECTED_SELF_HOST_TARGET'); }
  if (options.help) {
    console.log('npm run deploy:self-host -- --supabase-ref <ref> --pages-project <name> --owner-email <email> [--cloudflare-account <id>] [--dry-run | --setup-link]');
    return;
  }
  if (process.platform !== 'win32') fail('WINDOWS_SELF_HOST_SUPPORTED');
  if (options.setupLink && !process.stdout.isTTY) fail('SETUP_LINK_REQUIRES_INTERACTIVE_TERMINAL');
  await localStage(async stage => {
    const platform = await createPlatform(stage, options);
    const result = await runSelfHost(options, platform, stateStore(ROOT, options.ref), stage, {
      interactive: Boolean(process.stdout.isTTY),
      displaySecret: link => process.stdout.write('\n请在浏览器打开这条一次性链接并设置密码：\n' + link + '\n\n'),
      progress: stage => process.stderr.write('Lingo Notes 自部署 · ' + stage + '\n')
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'ready') {
      console.log('解压 ZIP 后，在 Chrome 或 Edge 的扩展管理页加载已解压目录。登录后可填写自己的 DeepSeek Key 和开启复习。');
      if (result.setup_link_available) console.log('首次设密链接过期或尚未显示时，在交互终端用相同参数追加 --setup-link。');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  main().catch(error => {
    const code = /^(?:[a-z-]+: )?[A-Z][A-Z0-9_]{2,119}$/.test(error?.message ?? '') ? error.message : 'SELF_HOST_DEPLOYMENT_FAILED';
    console.error('Lingo Notes 自部署失败 · ' + code);
    process.exitCode = 1;
  });
}
