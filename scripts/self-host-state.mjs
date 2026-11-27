import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import webpush from 'web-push';
import { fail } from './self-host-platform.mjs';
import { sha256 } from './self-host-database.mjs';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('SELF_HOST_STATE_INVALID'); }
}

function noLinks(root, path) {
  const absolute = resolve(path);
  if (!absolute.startsWith(root + sep)) fail('UNSAFE_SELF_HOST_PATH');
  let current = root;
  for (const part of absolute.slice(root.length + 1).split(sep)) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('SELF_HOST_SYMLINK_NOT_ALLOWED');
  }
  return absolute;
}

function dpapi(bytes, encrypt) {
  if (process.platform !== 'win32') fail('WINDOWS_DPAPI_REQUIRED');
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$encoded = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($encoded)',
    `$result = [Security.Cryptography.ProtectedData]::${encrypt ? 'Protect' : 'Unprotect'}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))'
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 20_000
  });
  if (result.status !== 0 || !result.stdout?.trim()) fail(encrypt ? 'SECURE_STORAGE_WRITE_FAILED' : 'RECOVER_THIS_WINDOWS_USERS_SELF_HOST_SECRETS');
  return Buffer.from(result.stdout.trim(), 'base64');
}

export const fingerprintOwner = (instance, email) => sha256(instance + '\n' + email);

export function newState({ ref, pagesName, email }, account) {
  const installationId = randomUUID();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    schema: 1, ref, pagesName, account, installationId,
    ownerFingerprint: fingerprintOwner(installationId, email),
    extensionKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  };
}

export function verifyLocalState(state, { ref, pagesName, email }, account) {
  if (state?.schema !== 1 || state.ref !== ref || state.pagesName !== pagesName || state.account !== account ||
      !/^[0-9a-f-]{36}$/.test(state.installationId ?? '') || state.ownerFingerprint !== fingerprintOwner(state.installationId, email) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(state.extensionKey ?? '')) fail('LOCAL_SELF_HOST_TARGET_MISMATCH');
  return state;
}

export function stateStore(root, ref) {
  root = resolve(root);
  const base = noLinks(root, resolve(root, 'data/self-host', ref));
  const checked = name => noLinks(root, resolve(base, name));
  const state = () => checked('instance.json');
  const locked = () => checked('deploy.lock');
  const secrets = () => checked('secrets.dpapi');
  function atomicWrite(path, value) {
    const temp = checked('.' + randomUUID() + '.tmp');
    writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
    try { renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  return {
    read: () => existsSync(state()) ? readJson(state()) : null,
    save(value) {
      mkdirSync(base, { recursive: true });
      atomicWrite(state(), JSON.stringify(value, null, 2) + '\n');
    },
    lock() {
      mkdirSync(base, { recursive: true });
      const path = locked();
      const stamp = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
      try { writeFileSync(path, stamp, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') fail('SELF_HOST_DEPLOYMENT_LOCKED'); throw error; }
      function unlock() {
        if (existsSync(path) && readFileSync(path, 'utf8') === stamp) unlinkSync(path);
      }
      process.once('exit', unlock);
      return () => { process.removeListener('exit', unlock); unlock(); };
    },
    secureValues(instance, names) {
      const path = secrets();
      let values;
      if (existsSync(path)) {
        try { values = JSON.parse(dpapi(readFileSync(path), false).toString('utf8')); }
        catch { fail('RECOVER_THIS_WINDOWS_USERS_SELF_HOST_SECRETS'); }
      } else {
        if (names.some(name => ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET'].includes(name))) fail('RECOVER_THIS_WINDOWS_USERS_SELF_HOST_SECRETS');
        const keys = webpush.generateVAPIDKeys();
        values = {
          instance, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, CRON_SECRET: randomBytes(32).toString('hex')
        };
        writeFileSync(path, dpapi(Buffer.from(JSON.stringify(values)), true), { flag: 'wx', mode: 0o600 });
      }
      if (values.instance !== instance || !/^[A-Za-z0-9_-]{87}$/.test(values.VAPID_PUBLIC_KEY ?? '') ||
          !/^[A-Za-z0-9_-]{43}$/.test(values.VAPID_PRIVATE_KEY ?? '') || !/^[0-9a-f]{64}$/.test(values.CRON_SECRET ?? '')) fail('SELF_HOST_SECRET_IDENTITY_MISMATCH');
      return values;
    },
    buildDirectory: () => noLinks(root, resolve(root, '.cache/self-host', ref, 'dist')),
    artifactsDirectory: () => noLinks(root, resolve(root, 'artifacts/self-host', ref))
  };
}
