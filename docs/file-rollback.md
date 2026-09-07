# File rollback

Canonfig must save the original bytes before it changes an owned file. File
size must not determine whether replacement, removal, or recovery can succeed.
The 16 MiB execution limit still applies to text parsing and composition, not
to binary rollback.

## Storage and ordering

- Every regular-file preimage is a private raw file beside its action journal.
  Its name is derived from the immutable action ID and normalized target path.
- The journal records object kinds, target paths, modes, and SHA-256 digests.
  It contains no encoded file bodies or caller-chosen backup paths.
- Capture copies each file with bounded memory, checks its digest, and flushes
  it before publishing the journal. The executor records the journal reference
  before starting the target mutation.
- Recovery derives the allowed targets and backup names from the recorded
  action. It copies a regular preimage into a temporary sibling, checks its
  digest before replacement, and preserves the captured permission intent.
- The same atomic-write path handles byte buffers and file sources. Native
  permission handling and managed-directory confinement apply to both.
  If an adapter isolates a directory by moving it, file sources inside that
  directory remain readable at their isolated location.
- Completed actions remove their journal and raw backups. Failed restoration
  retains both. Cleanup must not remove another action's or run's files.
- Append-local still checks for later local edits and parses text within its
  existing limit. Its saved original bytes use the same raw backup format.

Recovery covers process interruption. Flush guarantees remain those of the
platform adapter and filesystem; this does not promise identical power-loss
durability on every operating system.

## Upgrade boundary

This is the only current file-rollback format. Before upgrading, finish or
recover any unfinished run with the CLI that created it. An old inline-body
journal is rejected with a recovery diagnostic and is not rewritten or deleted
by a failed recovery attempt.

## Acceptance

The machine-state contract owns bounded file-source writes, digest checking
before replacement, and native permissions. Synchronization integration tests
own large-file update/removal, rollback after failure, persisted recovery, and
retention or cleanup of the complete snapshot. Existing append-local tests own
the protection of later local edits.

## Basis

[Node.js filesystem documentation](https://nodejs.org/api/fs.html) states that
`copyFile` alone offers no atomicity guarantee. Copy into the existing private
temporary sibling and rename only after validation instead of copying over the
target. Use bounded reads and complete writes rather than whole-file buffers.

[SQLite's atomic commit design](https://www.sqlite.org/atomiccommit.html)
explains why original content must be recorded and flushed before mutation,
and why rollback material must remain until restoration or commit finishes.
Canonfig retains its existing action journal rather than adding a second
transaction engine.

Increasing the memory cap retains whole-file allocations and base64 expansion.
Hard links are not backups of mutable files. Mandatory reflinks would restrict
filesystem support. None is the storage contract for this fix.
