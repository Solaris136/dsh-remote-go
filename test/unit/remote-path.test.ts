import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isIgnoredLocalName, localPathKey, safeLocalSegment, uniqueLocalPath } from '../../dist/src/remote-path.js'

test('safeLocalSegment keeps a remote name inside one local segment and never writes reserved names', () => {
  assert.equal(safeLocalSegment('report.md'), 'report.md')
  assert.equal(safeLocalSegment('a/b\\c'), 'a_b_c')
  assert.equal(safeLocalSegment('..'), '_')
  assert.equal(safeLocalSegment('trailing. '), 'trailing')
  assert.equal(safeLocalSegment('CON'), '_CON')
  assert.equal(safeLocalSegment('lpt1.txt'), '_lpt1.txt')
  const metadata = ['desktop.ini', 'Desktop.INI', 'thumbs.db', 'Thumbs.db', 'ehthumbs.db', '.DS_Store']
  const shortcuts = ['setup.lnk', 'Photo.JPG.lnk', 'docs.url', 'URL.URL']
  for (const name of [...metadata, ...shortcuts]) assert.equal(isIgnoredLocalName(name), true, name)
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
  taken.add(localPathKey(second, { caseInsensitive: true }))
  const third = uniqueLocalPath(path.join(dir, 'REPORT.md'), taken, { caseInsensitive: true })
  assert.equal(path.basename(second), 'report (2).md')
  assert.equal(path.basename(third), 'REPORT (3).md')
  // On a case-sensitive filesystem the same names are simply two files.
  const caseSensitive = new Set([localPathKey(path.join(dir, 'Report.md'))])
  const sameName = uniqueLocalPath(path.join(dir, 'report.md'), caseSensitive, { caseInsensitive: false })
  assert.equal(sameName, path.join(dir, 'report.md'))
  // The key folds separators and, with `caseInsensitive`, the case.
  const mixed = ['C:', 'Work', 'A.txt'].join(path.sep)
  assert.equal(localPathKey(mixed, { caseInsensitive: true }), 'c:/work/a.txt')
  assert.equal(localPathKey(mixed), 'C:/Work/A.txt')
})
