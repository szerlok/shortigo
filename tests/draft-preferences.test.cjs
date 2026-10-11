const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')
const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/renderer/store/use-draft-store.ts')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text
function load(localStorage) {
  const module = { exports: {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, require, localStorage })
  return module.exports.useDraftStore
}
test('hesitation choice survives restarts, including an explicit opt-out', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  let store = load(storage)
  assert.equal(store.getState().removeHesitations, true)
  store.getState().update({ removeHesitations: true })
  store.getState().update({ source: '/movie.mp4' })
  store = load(storage)
  assert.equal(store.getState().removeHesitations, true)
  assert.equal(store.getState().source, '')
  store.getState().startAnother()
  assert.equal(store.getState().removeHesitations, true)
  store.getState().update({ removeHesitations: false })
  assert.equal(load(storage).getState().removeHesitations, false)
})
test('unavailable storage does not stop clipping or the current choice', () => {
  const storage = { getItem() { throw Error('unavailable') }, setItem() { throw Error('unavailable') } }
  const store = load(storage)
  assert.equal(store.getState().removeHesitations, true)
  store.getState().update({ removeHesitations: false })
  assert.equal(store.getState().removeHesitations, false)
})
