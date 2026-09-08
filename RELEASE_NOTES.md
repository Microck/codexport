# Canonfig v3.1.4

Canonfig 3.1.4 requires Node.js 24 or newer.

## Bug Fixes

- Fix macOS Keychain round trips for text credentials, including Unicode and
  values up to the supported 16 KiB limit. Re-sync shared secrets after upgrading
  if an earlier version stored invalid values.
- Keep parent directories needed by desired files when replacing directory and
  skill trees, preventing directory-not-empty failures during synchronization.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.3...v3.1.4
