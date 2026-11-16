import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isIgnoredLocalName, localPathKey, safeLocalSegment, uniqueLocalPath } from '../../src/remote-path.js'

test('safeLocalSegment keeps a remote name inside one local segment', () => {
  assert.equal(safeLocalSegment('report.md'), 'report.md')
  assert.equal(safeLocalSegment('a/b\\c'), 'a_b_c')
  assert.equal(safeLocalSegment('..'), '_')
  assert.equal(safeLocalSegment('trailing. '), 'trailing')
  assert.equal(safeLocalSegment('CON'), '_CON')
  assert.equal(safeLocalSegment('lpt1.txt'), '_lpt1.txt')
})

test('Windows metadata and shell shortcut names are never written into a download', () => {
  for (const name of ['desktop.ini', 'Desktop.INI', 'thumbs.db', 'Thumbs.db', 'ehthumbs.db', '.DS_Store']) {
    assert.equal(isIgnoredLocalName(name), true, name)
  }
  for (const name of ['setup.lnk', 'Photo.JPG.lnk', 'docs.url', 'URL.URL']) {
    assert.equal(isIgnoredLocalName(name), true, name)
  }
  for (const name of ['readme.txt', 'notes', 'picture.png', '.gitignore']) {
    assert.equal(isIgnoredLocalName(name), false, name)
  }
})

test('uniqueLocalPath renames a case-only collision instead of merging the two files', () => {
  const dir = path.join('/tmp', 'd')
  const taken = new Set()
  const first = uniqueLocalPath(path.join(dir, 'Report.md'), taken, { caseInsensitive: true })
  taken.add(localPathKey(first, { caseInsensitive: true }))
  assert.equal(path.basename(first), 'Report.md')
  const second = uniqueLocalPath(path.join(dir, 'report.md'), taken, { caseInsensitive: true })
  assert.equal(path.basename(second), 'report (2).md')
  taken.add(localPathKey(second, { caseInsensitive: true }))
  assert.equal(
    path.basename(uniqueLocalPath(path.join(dir, 'REPORT.md'), taken, { caseInsensitive: true })),
    'REPORT (3).md',
  )
  // On a case-sensitive filesystem the same names are simply two files.
  const caseSensitive = new Set([localPathKey(path.join(dir, 'Report.md'))])
  assert.equal(
    uniqueLocalPath(path.join(dir, 'report.md'), caseSensitive, { caseInsensitive: false }),
    path.join(dir, 'report.md'),
  )
})

test('localPathKey normalizes separators and case only when asked', () => {
  const mixed = ['C:', 'Work', 'A.txt'].join(path.sep)
  assert.equal(localPathKey(mixed, { caseInsensitive: true }), 'c:/work/a.txt')
  assert.equal(localPathKey(mixed), 'C:/Work/A.txt')
})
