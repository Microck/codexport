# Canonfig v3.1.2

Canonfig 3.1.2 requires Node.js 24 or newer.

## Bug Fixes

- Detect tools by their declared entry file or command, not by the shared
  runtime used to verify them. Missing Node- or Python-based tools no longer
  appear installed just because their runtime is available.
- Restore captured Windows file and directory owners, groups, and access
  rules during rollback, including inheritance flags. Keep restored children
  unchanged when restoring directory permissions.

## Before upgrading

Finish or recover unfinished runs with the CLI that created them. This
release's rollback journal requires native permission snapshots and rejects
older mode-only journals. Windows audit rules are not captured.

Full changelog: https://github.com/Microck/canonfig/compare/v3.1.1...v3.1.2
