import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(HERE, '..', '..')

export function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      out += '  '
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < source.length) {
        out += '  '
        index += 2
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        const current = source[index]
        out += current
        index += 1
        if (current === '\\') {
          if (index < source.length) {
            out += source[index]
            index += 1
          }
          continue
        }
        if (current === quote || current === '\n') break
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

export function matchingBracket(text, open) {
  const close = { '{': '}', '(': ')', '[': ']' }[text[open]]
  if (!close) return -1
  const openChar = text[open]
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === openChar) depth += 1
    else if (text[index] === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

export async function walkFiles(dir, options = {}) {
  const extensions = options.extensions ?? /\.js$/
  const skipDirs = options.skipDirs ?? new Set()
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      out.push(...(await walkFiles(full, options)))
      continue
    }
    if (entry.isFile() && extensions.test(entry.name)) out.push(full)
  }
  return out
}
