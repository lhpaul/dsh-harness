/**
 * Minimal JSONC reader for VS Code `.code-workspace` files: removes `//` and
 * block comments and trailing commas outside string literals, then delegates
 * to `JSON.parse`. Throws `SyntaxError` for anything `JSON.parse` rejects.
 * @module dsh-lh-workspace-roots/jsonc
 */

/** Index of the first character at or after `i` that is neither whitespace nor inside a comment. */
function skipBlank(text, i) {
  const n = text.length
  while (i < n) {
    if (/\s/.test(text[i])) {
      i += 1
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else {
      break
    }
  }
  return i
}

/**
 * Strip JSONC extensions (comments, trailing commas) from `text`.
 * @param {string} text - JSONC source.
 * @returns {string} plain JSON source.
 */
export function stripJsonc(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (ch === ',') {
      const next = text[skipBlank(text, i + 1)]
      if (next !== '}' && next !== ']') out += ch
      i += 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/**
 * Parse JSONC text.
 * @param {string} text - JSONC source.
 * @returns {unknown} the parsed value.
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text))
}
