// Validate a pull request title as a Conventional Commit.
// Squash merges use the PR title as the commit subject on main, so the title is
// gated here: type/scope prefix, subject present, sane length, no placeholder
// text. Reads the title from PR_TITLE (CI) or the first CLI argument.
import process from 'node:process'

const EXAMPLE = 'feat(panel): add SSH tunnel keepalive backoff'

const TYPES = 'build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([a-z0-9][a-z0-9-]*\\))?!?: .+$`)
const MAX_LENGTH = 72
const WIP_PREFIX = /^wip\b/i

const title = process.env.PR_TITLE ?? process.argv[2] ?? ''

/** Report a validation failure and stop the run. @param {string} reason */
function fail(reason) {
  console.error(`[check-pr-title] FAIL: ${reason}`)
  console.error(`[check-pr-title] example: ${EXAMPLE}`)
  process.exit(1)
}

if (title.trim() === '') fail('title is empty; set PR_TITLE or pass the title as an argument')
if (WIP_PREFIX.test(title)) fail('title still starts with WIP; rename it once the change is ready to merge')
if (/\s$/.test(title)) fail('title ends with whitespace')
if (title.length > MAX_LENGTH) fail(`title is ${title.length} characters long; the limit is ${MAX_LENGTH}`)
if (title.endsWith('.')) fail('title must not end with a period')
if (!CONVENTIONAL.test(title)) fail('title is not a Conventional Commit; expected "<type>(<scope>): <subject>"')

console.log(`[check-pr-title] OK: ${title}`)
