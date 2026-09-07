# Verification and repeat runs

Track configuration state separately from actual harness runtime readiness.
The harness CLI does not emit Machine Profile Convergence as its proof of success.

## Required evidence

For every selected machine, project, and target record:

- Observed machine/account/root, Canonfig version, target ID/version or a missing
  executable result. Label local, remote-observed, or operator-reported evidence.
- Reviewed input scope and canonical digest/commit, including referenced assets.
- Every selected migration field mapped, retained-native, excluded by operator,
  or blocked. No silent omissions, leaked secrets, or unapproved scope widening.
- Validation and actual feature/field diagnostics inspected, not merely exit 0.
- Approved plan applied with unchanged scope; no unapproved force or collision.
- Fresh status/diff has no pending creates, updates, deletes, or conflicts.
  The status command's exit code alone does not mean no pending changes.
- Ownership recorded locally; originals and unselected target state preserved.
  Shared artifacts reviewed for effects on the input harness.
- Required local credential/environment references and executable dependencies
  accounted for without disclosing values.

`harness doctor` probes executables and can exit 0 with missing results. It does
not prove login, loading of project settings, MCP connectivity, hook semantics,
or subagent behavior. Inspect the returned records. With approval, use the
installed harness's documented config/MCP inspection or a bounded smoke test;
do not trigger arbitrary agent work, hooks, or network calls just to get a check.
Target differences, trust prompts, and restarts remain explicit human actions.

## Per-machine result

Use `configuration verified`, `runtime verified`, `plan only`,
`handoff prepared — not executed`, `blocked`, or `failed`, with exact reasons.
A configured artifact can be verified while a target binary is not installed;
report both dimensions instead of claiming a usable harness. Required runtime
checks that were not performed remain pending. An unavailable optional discovery
step need not block an otherwise complete local configuration.

Summarize one row per machine/root/target, canonical digest, projection result,
runtime result, and blockers. For existing followers, include their separate
transfer result only when used. Never infer fleet completion from local evidence.
Do not mark remote setup complete because files were sent, a peer is online,
follower sync converged, or an operator handoff was generated.

## Resume

Reuse the selected mode and settled configuration decisions; recheck current
machine state and hashes. Completed unchanged projections should be no-ops.
An offline machine remains pending while verified machines keep their result.
On native edits, explicitly choose re-import/review or retain-native. Do not turn
a sync retry into a fresh migration, overwrite canonical work, copy ownership
state between checkouts, or reset Source/follower trust.

Tests under `tests/integration/harness-sync-skill.test.ts` check the question
contract and project a prepared Codex-derived fixture through the real compiler.
They cover idempotence, existing-key collisions, external managed edits, and
independent checkout ownership. They are not live remote, tailnet, MCP, native
importer, or installed-harness runtime tests.
