# Canonfig v3.1.1

Canonfig 3.1.1 requires Node.js 24 or newer.

## Bug Fixes

- Preserve existing parent and sibling permissions when writing files on
  Windows. Protect new directories, staged content, and local credential
  storage without changing unrelated files' access rules.
- Support large files in rollback snapshots so synchronization can replace
  them and restore their original contents if an apply fails.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.0...v3.1.1
