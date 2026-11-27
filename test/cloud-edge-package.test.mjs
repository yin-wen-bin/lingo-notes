import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeManifest, readEdgeZip } from '../scripts/package-edge.mjs';
import { zipFiles } from '../scripts/package-extension.mjs';

const source = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('Edge listing metadata changes only the ZIP manifest description and title', () => {
  const original = structuredClone(source);
  const edge = edgeManifest(source);
  const readme = readFileSync(new URL('../store/edge/listing.en-US.md', import.meta.url), 'utf8');
  const description = readme.split(/\r?\n/)[4];
  assert.deepEqual(edge, {
    ...original,
    description,
    action: { ...original.action, default_title: 'Open Lingo Notes' }
  });
  assert.equal(edge.description.length, 131);
  assert.deepEqual(source, original);
});

test('Edge packaging rejects a pinned identity, localized manifest or self-host target', () => {
  assert.throws(() => edgeManifest({ ...source, key: 'public-key' }), /EDGE_REQUIRES_UNKEYED_STORE_MANIFEST/);
  assert.throws(() => edgeManifest({ ...source, default_locale: 'en' }), /EDGE_REQUIRES_UNKEYED_STORE_MANIFEST/);
  assert.throws(() => edgeManifest({
    ...source,
    host_permissions: ['https://synthetic.supabase.co/*']
  }), /EDGE_REQUIRES_OFFICIAL_EXTENSION/);
  assert.throws(() => edgeManifest({
    ...source,
    content_security_policy: { extension_pages: "script-src 'self'; connect-src https://synthetic.supabase.co;" }
  }), /EDGE_REQUIRES_OFFICIAL_EXTENSION/);
});

test('Windows archive readback requires a unique root manifest and verifies decompressed bytes', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingo-edge-package-test-'));
  const path = join(directory, 'synthetic-edge.zip');
  const files = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(edgeManifest(source))) },
    { path: 'panel.js', bytes: Buffer.from('synthetic') }
  ];
  writeFileSync(path, zipFiles(files));
  try {
    assert.deepEqual(readEdgeZip(path), files.map(file => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex')
    })));
    writeFileSync(path, zipFiles([...files, files[0]]));
    assert.throws(() => readEdgeZip(path), /EDGE_ZIP_STRUCTURE_INVALID/);
    writeFileSync(path, zipFiles([{ ...files[0], path: 'extension/manifest.json' }]));
    assert.throws(() => readEdgeZip(path), /EDGE_ZIP_STRUCTURE_INVALID/);
  } finally {
    unlinkSync(path);
    rmdirSync(directory);
  }
});
