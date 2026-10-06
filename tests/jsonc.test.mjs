import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseJsonc, stripJsonc } from '../packages/workspace-roots/src/jsonc.js'

test('strips line and block comments outside strings', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": 1 /* b */ }'), { a: 1 })
})

test('keeps comment-like text inside strings, including escaped quotes', () => {
  assert.deepEqual(parseJsonc('{ "u": "https://x//y", "q": "a\\"//b", "s": "/* no */" }'), {
    u: 'https://x//y',
    q: 'a"//b',
    s: '/* no */',
  })
})

test('removes trailing commas, also when a comment follows them', () => {
  assert.deepEqual(parseJsonc('{ "a": [1, 2, ], "b": 3, // tail\n }'), { a: [1, 2], b: 3 })
})

test('tolerates a UTF-8 BOM', () => {
  assert.deepEqual(parseJsonc('\uFEFF{ "a": 1 }'), { a: 1 })
})

test('malformed input throws SyntaxError', () => {
  assert.throws(() => parseJsonc('{ "folders": [ '), SyntaxError)
  assert.equal(stripJsonc('[1,]'), '[1]')
})
