# Canonfig v3.1.3

Canonfig 3.1.3 requires Node.js 24 or newer.

## Bug Fixes

- Fix npm installs failing before startup because user and global configuration
  pointed to the same file. Installs now use distinct empty configuration files
  while keeping inherited npm settings disabled.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.2...v3.1.3
