'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('./support/load-main.cjs')

test('broken transfers switch endpoints and subsequent uploads reuse a healthy current DNS address', () => {
  const { selectUploadAddress, recordUploadRoute } = loadMain("export * from './src/main/zernio/posts-upload-route'")
  const host = 'storage.example'
  const addresses = ['8.8.8.8', '1.1.1.1']
  assert.equal(selectUploadAddress(host, addresses), addresses[0])
  recordUploadRoute(host, addresses[0], false)
  assert.equal(selectUploadAddress(host, addresses), addresses[1])
  recordUploadRoute(host, addresses[1], true)
  assert.equal(selectUploadAddress(host, addresses), addresses[1])
  assert.equal(selectUploadAddress(host, ['9.9.9.9']), '9.9.9.9', 'never use a cached IP outside fresh DNS results')
  assert.equal(selectUploadAddress('other.example', addresses), addresses[0], 'routes are scoped to their hostname')
})
