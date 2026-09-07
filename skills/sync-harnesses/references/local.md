# Project-local projection

Use the intended project checkout, never `~/.canonfig` (machine state), as the
working root. Canonical harness sources are `<project>/.canonfig`; native outputs
are constrained to the project. This is not a global dotfile synchronizer.

## Prepare

Inspect existing canonical formats and `.canonfig/.harness-state.json` before
writing. One of harness.yaml, harness.yml, or harness.json is allowed, not several.
Validate native migration in a scratch checkout first when practical. Stage only
approved files; do not include private backups, credentials, or unrelated edits.
Do not copy ownership state from another checkout to fake prior ownership.

For a new canonical source, scaffold only after approving the write. Select the
actual destinations, rather than taking a scaffold's example targets/features:

```bash
canonfig harness init --targets claude-code,antigravity
```

For strict JSON use this alternative, not both:

```bash
canonfig harness init --format json --targets claude-code,antigravity
```

Populate the reviewed candidate and its referenced inputs. Do not leave scaffold
example hooks, agents, rules, or commands enabled unless explicitly selected.
The canonical schema version is 1; Machine Profile schema version 2 is unrelated.

## Validate the same selection throughout

These commands run inside the approved project root. Replace the example target
list with the actual selection. When running elsewhere, add the same local
`--root` to every command. `--root` is not a remote host or a home-sync switch.

```bash
canonfig harness validate --strict --targets claude-code,antigravity --json
canonfig harness plan --strict --targets claude-code,antigravity --json
canonfig harness diff --strict --targets claude-code,antigravity
```

Inspect diagnostics as well as exit codes and plan entries. `--strict` rejects
shim, lossy, and unsupported capability mappings; unsupported features remain
errors even without strictness. Per-field warnings may still need a blocking
operator decision, especially omitted filters, permissions, or timeouts.
Do not silently rerun without strictness to get a green result.

Show expected paths from the actual plan, not a generic path recipe. In the
inspected adapters, Claude Code uses a `CLAUDE.md` bridge and common `.mcp.json`;
Antigravity's CLI adapter uses `.agents/mcp_config.json`. Other app variants or
user-global settings may differ. Do not assume IDE/global configuration is
covered by these project/CLI mappings.

Common artifacts may be generated even for a subset of targets: `AGENTS.md`,
`.gitignore`, `.mcp.json`, `.agents/skills`, and hook runtime files when needed.
Inspect the whole plan, including shared changes and removals. Removing a target
from configuration alone does not prove its previously generated files were
removed. Verify the ownership plan; do not use cleanup to guess the desired scope.

## Ownership and approval

Keep original files, source hashes, canonical hashes, and destination hashes for
review. Apply recomputes a plan; there is no saved-plan token here. Recheck the
reviewed files immediately before applying, and require renewed approval if the
material plan changes. Avoid simultaneous manual edits or scheduled writers.

For each conflict offer preserve, revise the candidate, or explicitly transfer
ownership. `--force` applies to the invocation, not to one row. Never run it while
any affected conflict/edit is unapproved. Narrow the target set only when the
entire resulting plan, including common artifacts, stays inside approved scope.

Use the APPLY menu in choices.md. Configuration recommendations do not authorize
native writes. Canonical adoption and output mutation may be approved as one
clearly scoped stage only when both diffs are already known and unchanged.

## Apply and inspect again

After approval, preserve the reviewed root/targets/strictness:

```bash
canonfig harness apply --strict --targets claude-code,antigravity --json
canonfig harness status --strict --targets claude-code,antigravity --json
canonfig harness diff --strict --targets claude-code,antigravity
canonfig harness doctor --targets claude-code,antigravity --json
```

`harness sync` is just the apply alias. A status command can succeed while
changes are pending, and doctor can succeed while target executables are missing.
Inspect payloads. Expect no pending creates/updates/deletes/conflicts after apply.
Do not install missing harnesses or run MCP/hook code without relevant approval.

## Cleanup and recovery

`harness clean` removes owned artifacts across targets in the current
implementation; target selection is not a promise of targeted cleanup. Never
use it as an automatic rollback. Preview cleanup explicitly, review all paths,
and restore only reviewed local backups/changes with approval. Preserve the
ownership file and external edits. Harness projection is separate from the
Machine Profile recovery journal; do not invoke follower recovery for a harness
failure. Atomic file operations do not imply a whole-run rollback guarantee.

For repeated runs, update canonical sources, preview, approve, apply, and verify
again. An external scheduler/project task is a separate setup decision; the
Canonfig follower scheduler is not a harness scheduler.
