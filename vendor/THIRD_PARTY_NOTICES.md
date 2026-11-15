# Third-party notices

## ssh2

- Package: `ssh2` (MIT)
- Source: https://github.com/mscdex/ssh2
- Bundled file: `vendor/ssh2.bundle.cjs` (329 KiB, minified)
- License text: see https://github.com/mscdex/ssh2/blob/master/LICENSE

The bundle excludes the optional native accelerator `cpu-features`; ssh2 uses its pure-JavaScript fallback then.

## js-yaml

- Package: `js-yaml` (MIT)
- Source: https://github.com/nodeca/js-yaml
- Bundled file: `vendor/yaml.bundle.mjs` (56 KiB, minified)
- License text: see https://github.com/nodeca/js-yaml/blob/master/LICENSE

The bundle exposes only `load` and `dump`; it parses and serializes the remote profile patch and
the remote credential document during a sync.
