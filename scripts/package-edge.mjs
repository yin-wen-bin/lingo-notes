import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as build } from './build.mjs';
import { PROJECT_REF, ROOT } from './cloud-config.mjs';
import { inspectExtension, zipFiles } from './package-extension.mjs';

const officialHost = `${PROJECT_REF}.supabase.co`;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const shortDescription = 'Learn English and Japanese from web pages, save notes, and review later. Requires an invited account and your own DeepSeek API key.';

export function edgeManifest(manifest) {
  if (Object.hasOwn(manifest, 'key') || Object.hasOwn(manifest, 'default_locale')) {
    throw Error('EDGE_REQUIRES_UNKEYED_STORE_MANIFEST');
  }
  if (manifest.name !== 'Lingo Notes' ||
      !manifest.action ||
      !hasOfficialHost(manifest.host_permissions) ||
      !manifest.content_security_policy?.extension_pages?.includes(`connect-src https://${officialHost};`)) {
    throw Error('EDGE_REQUIRES_OFFICIAL_EXTENSION');
  }
  return {
    ...manifest,
    description: shortDescription,
    action: { ...manifest.action, default_title: 'Open Lingo Notes' }
  };
}

function hasOfficialHost(permissions) {
  return Array.isArray(permissions) && permissions.length === 1 && permissions[0] === `https://${officialHost}/*`;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error('EDGE_GIT_READ_FAILED');
  return result.stdout.trim();
}

function cleanCommit() {
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('EDGE_REQUIRES_CLEAN_RELEASE_COMMIT');
  return commit;
}

// .NET verifies decompressed entries independently of the JavaScript writer.
export function readEdgeZip(path) {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:LINGO_EDGE_VERIFY_ARCHIVE)
try {
  $files = foreach ($entry in $archive.Entries) {
    $stream = $entry.Open()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
      [pscustomobject]@{ path = $entry.FullName; bytes = $entry.Length; sha256 = $hash }
    } finally { $algorithm.Dispose(); $stream.Dispose() }
  }
  ConvertTo-Json -InputObject @($files) -Depth 4 -Compress
} finally { $archive.Dispose() }
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')
  ], {
    env: { ...process.env, LINGO_EDGE_VERIFY_ARCHIVE: path },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  if (result.status !== 0) throw Error('EDGE_INDEPENDENT_ZIP_READ_FAILED');
  const entries = JSON.parse(result.stdout.trim());
  if (!Array.isArray(entries) || new Set(entries.map(entry => entry.path)).size !== entries.length ||
      !entries.some(entry => entry.path === 'manifest.json')) throw Error('EDGE_ZIP_STRUCTURE_INVALID');
  return entries;
}

function outputPath(args) {
  const artifacts = resolve(ROOT, 'artifacts');
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--'))) {
    throw Error('USAGE: package-edge.mjs [--out artifacts/<directory>]');
  }
  const output = resolve(ROOT, args[1] ?? 'artifacts/edge');
  if (dirname(output) !== artifacts) throw Error('EDGE_OUTPUT_MUST_BE_CHILD_OF_ARTIFACTS');
  for (const directory of [artifacts, output]) {
    if (!existsSync(directory)) mkdirSync(directory);
    else if (!lstatSync(directory).isDirectory()) throw Error('EDGE_OUTPUT_MUST_BE_REGULAR_DIRECTORY');
  }
  return output;
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw Error('EDGE_PACKAGE_VALIDATION_REQUIRES_WINDOWS');
  const commit = cleanCommit();
  const output = outputPath(args);
  const info = await build(['--profile', 'store']);
  if (info?.profile !== 'store' || !info.configured || info.extension_id !== null) {
    throw Error('EDGE_REQUIRES_CONFIGURED_UNKEYED_STORE_BUILD');
  }
  const inspected = inspectExtension(resolve(ROOT, 'dist', 'extension'));
  const source = json(resolve(ROOT, 'extension', 'manifest.json'));
  if (info.version !== source.version || inspected.manifest.version !== source.version) throw Error('EDGE_BUILD_VERSION_MISMATCH');
  const manifest = edgeManifest(inspected.manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const files = inspected.files.map(file => {
    if (file.path === 'manifest.json') return { ...file, bytes: manifestBytes, sha256: digest(manifestBytes) };
    if (/^(?:panel|background)\.js$/.test(file.path)) {
      const hosts = [...file.bytes.toString('utf8').matchAll(/https:\/\/([a-z0-9-]+\.supabase\.co)/g)].map(match => match[1]);
      if (!hosts.length || hosts.some(host => host !== officialHost)) throw Error('EDGE_BUNDLE_TARGET_MISMATCH');
    }
    return file;
  });
  const zip = zipFiles(files);
  const sha256 = digest(zip);
  const candidate = resolve(output, `lingo-notes-${source.version}-edge.zip`);
  if (existsSync(candidate) && (!lstatSync(candidate).isFile() || digest(readFileSync(candidate)) !== sha256)) {
    throw Error('EDGE_ARTIFACT_EXISTS_USE_NEW_OUTPUT');
  }
  const staged = resolve(output, `edge-verify-${randomUUID()}.zip`);
  const expected = files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: file.sha256 }));
  writeFileSync(staged, zip, { flag: 'wx' });
  try {
    assert.deepEqual(readEdgeZip(staged), expected, 'EDGE_ZIP_FILE_HASH_MISMATCH');
    if (cleanCommit() !== commit) throw Error('EDGE_BUILD_COMMIT_CHANGED');
    if (!existsSync(candidate)) writeFileSync(candidate, zip, { flag: 'wx' });
    if (digest(readFileSync(candidate)) !== sha256) throw Error('EDGE_FINAL_ZIP_HASH_MISMATCH');
  } finally {
    unlinkSync(staged);
  }
  const report = {
    version: manifest.version,
    source_commit: commit,
    hosted_origin: `https://${officialHost}`,
    zip: basename(candidate),
    sha256,
    bytes: zip.length,
    file_count: files.length,
    zip_reader: 'System.IO.Compression.ZipFile',
    font_files: inspected.font_files,
    font_licenses: inspected.font_licenses,
    files: expected
  };
  writeFileSync(candidate + '.sha256', `${sha256}  ${basename(candidate)}\n`);
  writeFileSync(candidate + '.report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, files: undefined, zip: candidate }));
  return { ...report, zip: candidate };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
