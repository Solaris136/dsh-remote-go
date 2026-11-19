// The Cordis loader resolves a linked plugin by its directory entry (`<dir>/index.js`), not
// through package exports, so a `link:` install needs this file to exist. It is a one-line shim:
// the implementation is the build output in `dist/`, and `exports["."]` names the same file for
// consumers that resolve by exports.
export { apply, inject, name, optional } from './dist/index.js'
