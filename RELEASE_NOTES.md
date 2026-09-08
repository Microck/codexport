# Canonfig v3.1.5

Canonfig 3.1.5 requires Node.js 24 or newer.

## Bug Fixes

- Recreate missing skill directories during synchronization, including nested
  files. Previously, restoring a deleted skill could fail with a missing-artifact
  error instead of restoring its directory tree.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.4...v3.1.5
