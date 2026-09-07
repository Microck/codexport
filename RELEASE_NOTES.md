# Canonfig v3.1.0

Canonfig 3.1.0 requires Node.js 24 or newer.

## Features

- Add the opt-in `append-local` file policy for shared instructions such as
  `AGENTS.md`. Canonfig updates a marked Source section and preserves the
  follower's local text below it. Removing the resource removes only the Source
  section. Existing file policies keep their behavior.
- Add Simple and Advanced setup guidance, numbered configuration choices, and
  opt-in Tailscale device discovery.
- Add a harness-to-harness skill for importing supported agent configuration
  into one canonical harness and projecting it to other supported targets.

`append-local` supports regular, non-executable UTF-8 text files. Edits to the
managed Source section are reported as drift. Recovery preserves local edits
made after a failed apply and retains the snapshots needed for manual recovery.

Full changelog: https://github.com/Microck/canonfig/compare/v3.0.1...v3.1.0
