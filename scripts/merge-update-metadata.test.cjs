const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mergeMetadata, verifyArtifacts } = require('./merge-update-metadata.cjs')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const metadata = arch => ({ version: '1.0.0', files: [{ url: `app-${arch}.zip`, sha512: 'digest', size: 100 }] })
test('retains downloads for both macOS architectures', () => {
  assert.deepEqual(mergeMetadata([metadata('arm64'), metadata('x64')]).files.map(f => f.url), ['app-arm64.zip', 'app-x64.zip'])
})
test('rejects inconsistent or overlapping release artifacts', () => {
  assert.throws(() => mergeMetadata([metadata('arm64'), { ...metadata('x64'), version: '2.0.0' }]))
  assert.throws(() => mergeMetadata([metadata('arm64'), metadata('arm64')]))
})
test('checks archive bytes against update metadata before publishing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridgeclip-update-'))
  try {
    const archive = Buffer.from('test archive')
    writeFileSync(join(dir, 'app.zip'), archive)
    const file = { url: 'app.zip', size: archive.length, sha512: createHash('sha512').update(archive).digest('base64') }
    assert.doesNotThrow(() => verifyArtifacts({ files: [file] }, dir))
    assert.throws(() => verifyArtifacts({ files: [{ ...file, size: 1 }] }, dir))
    assert.throws(() => verifyArtifacts({ files: [{ ...file, sha512: 'wrong' }] }, dir))
    assert.throws(() => verifyArtifacts({ files: [{ ...file, url: '../app.zip' }] }, dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
