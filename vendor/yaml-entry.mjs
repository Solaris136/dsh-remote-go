// Vendored-YAML entry point. `scripts/build-vendor.mjs` bundles this file into
// `vendor/yaml.bundle.mjs`, so the published plugin can merge the remote profile
// patch and the credential document without a runtime dependency.
//
// Rebuild with: node scripts/build-vendor.mjs
import { load, dump } from 'js-yaml'

export { load, dump }
export default { load, dump }
