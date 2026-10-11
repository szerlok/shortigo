const { readFileSync, writeFileSync, statSync } = require('node:fs')
const { join, basename } = require('node:path')
const { createHash } = require('node:crypto')
const yaml = require('js-yaml')

function mergeMetadata(documents) {
  const [first] = documents
  if (!first || !first.version || !Array.isArray(first.files)) throw new Error('Invalid update metadata')
  const files = new Map()
  for (const document of documents) {
    if (document.version !== first.version || !Array.isArray(document.files)) throw new Error('Mismatched update versions')
    for (const file of document.files) {
      if (!file.url || !file.sha512 || !(file.size > 0)) throw new Error('Invalid update artifact')
      if (files.has(file.url)) throw new Error('Duplicate update artifact')
      files.set(file.url, file)
    }
  }
  return { ...first, files: [...files.values()] }
}

function verifyArtifacts(document, directory) {
  for (const file of document.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url || !file.url.endsWith('.zip')) throw new Error('Invalid update artifact name')
    const artifact = join(directory, file.url)
    if (statSync(artifact).size !== file.size) throw new Error(`Update artifact size mismatch: ${file.url}`)
    const digest = createHash('sha512').update(readFileSync(artifact)).digest('base64')
    if (digest !== file.sha512) throw new Error(`Update artifact digest mismatch: ${file.url}`)
  }
}

if (require.main === module) {
  const root = process.argv[2]
  if (!root) throw new Error('Artifact directory required')
  const documents = ['arm64', 'x64'].map(arch => {
    const directory = join(root, `mac-${arch}`)
    const document = yaml.load(readFileSync(join(directory, 'latest-mac.yml'), 'utf8'))
    verifyArtifacts(document, directory)
    return document
  })
  writeFileSync(join(root, 'latest-mac.yml'), yaml.dump(mergeMetadata(documents)))
}
module.exports = { mergeMetadata, verifyArtifacts }
