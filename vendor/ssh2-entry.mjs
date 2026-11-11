// Vendored-ssh2 entry point. `scripts/build-vendor.mjs` bundles this file into
// `vendor/ssh2.bundle.cjs`, so the published plugin ships with **zero runtime
// dependencies and no install/build scripts** (design: keep install light, never
// run arbitrary npm lifecycle scripts on the user's machine).
//
// Rebuild with: node scripts/build-vendor.mjs
import ssh2 from 'ssh2'

export const Client = ssh2.Client
export const utils = ssh2.utils
export const Server = ssh2.Server
export default ssh2
