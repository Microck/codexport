# Remote harness projection and existing followers

## What exists

The harness CLI operates on a local project root. It has no built-in remote
harness command, automatic native import, or follower-triggered projection.
Remote support in this skill means approved canonical-source delivery followed
by local harness commands on each chosen machine, using an already authorized
remote session or an operator-run handoff. Do not advertise native fleet sync.

A machine can already be a Canonfig follower and also have project harness
configuration. These are independent states. Ordinary follower sync does not run
harness projection, and follower `Converged` does not establish harness readiness.

## Choose machines and access

Reuse explicit hosts or previously approved device selections. Optional discovery
uses [the existing Tailscale flow](../../setup-canonfig/references/tailscale-discovery.md)
and its local inventory helper, only after consent. Never read a live tailnet
just to test this skill. No new subnet scans, port scans, SSH enablement, ACL
changes, or inferred remote permissions.

```text
Question: DISCOVERY — Should we list devices already visible to local Tailscale?
Why it matters: This reads peer metadata, not remote files or service readiness.
Recommended: Manual entry unless device discovery would resolve an unknown host.
Options:
1. List visible peers once — permit only the bounded local inventory read.
2. Enter known machines manually — do not read peer metadata.
3. This machine only — leave remote deployment out of this run.
4. Other (type your own) — specify a narrower discovery scope.
```

Offer detected device IDs/names and offline/unknown status as numbered choices.
Freeze the number-to-ID mapping. A visible peer is not necessarily owned,
authorized, reachable for SSH, enrolled, or running Canonfig. Do not select all
visible machines. Never use device labels or typed paths as shell fragments.

For each selected host establish the authorized account/session, OS/architecture,
shell, absolute checkout, Canonfig/target versions, canonical digest, and required
local environment references. Selecting a host is not permission to log in.
Approve read access separately from delivery and apply; group known per-machine
plans to reduce prompts, without granting future machines blanket permission.

Use an existing trusted remote execution facility only if actually available and
authorized. Do not disable host-key verification, change trust pins, enable
Tailscale SSH, or request passwords/private keys in chat. Missing access produces
a precise handoff, not a successful deployment claim.

## Choose a delivery route

```text
Question: DELIVERY — How should canonical inputs reach these projects?
Why it matters: Delivery and projection are separate; machine credentials stay local.
Recommended: An existing approved repository workflow, when one is available.
Options:
1. Existing repository workflow — deliver a reviewed commit to selected checkouts.
2. Existing Canonfig followers — publish only reviewed canonical input resources.
3. Operator-run transfer/handoff — provide a manifest and local projection steps.
4. Other (type your own) — describe an already authorized delivery mechanism.
```

Repository delivery needs explicit approval to commit/push/pull. Verify the
remote checkout and dirty state; do not hard-reset, overwrite untracked files,
execute hooks from an unreviewed repository, or copy an entire private checkout.
A protected archive/file transfer also requires a path allowlist and digest check.
The skill must not assume an arbitrary transfer is supplied by Canonfig itself.

Manifest: one harness config file and every referenced canonical instruction,
rule, skill, hook asset, agent, command, and required non-secret dependency file.
Resolve includes/symlinks against approved roots and preserve relative layout and
needed modes. Exclude `.canonfig/.harness-state.json`, `.canonfig/.runtime`,
`~/.canonfig/state.sqlite`, pins, identities, secrets, caches, backups, and session
history. Generate ownership and runtime artifacts locally on each destination.
Do not distribute generated native outputs as if they were canonical inputs.

### Existing follower delivery

This is an optional composition, not an integrated harness-sync option. Delegate
profile publication/enrollment to the existing setup/operate skills only when
requested. Never create a Source/Follower identity for a harness-only task.

Use explicit file/directory resources for canonical inputs at the approved remote
project paths. Avoid a broad mirror of `.canonfig`; it also holds destination-local
ownership/runtime files. Do not let Machine Profiles own the same generated
native paths/keys as the harness renderer. Stop for dual ownership instead of
allowing the two systems to overwrite one another.

Publish and apply a reviewed profile stage independently. Verify transferred
canonical bytes at the destination, then run the harness sequence below. Keep
Source TLS/signing pins and follower credentials intact. Tailscale discovery does
not make its IP a supported direct Source endpoint; use only the installed
transport contract and an already approved operator-managed connection.

### Per-machine projection

After verified delivery, run the local.md validation/plan/diff sequence on each
machine in its own approved checkout. Replace target selections and paths using
that machine's facts. Do not reuse the initiating machine's HOME, PATH, platform
commands, global settings, or credentials. Check private MCP URLs and stdio
executables/cwd separately; inventory visibility proves none of these work.

Approve each material plan (or one explicitly enumerated batch of unchanged
plans), then apply and inspect status/diff/doctor locally on each destination.
A supplied `--root` always refers to a path on the machine executing the command.
Source/follower transport and harness-renderer results must be reported separately.

## Ongoing automation and handoff

Default to on-demand projection. `canonfig schedule set` schedules Machine Profile
apply, not harness rendering. Do not claim it schedules both or silently replace
its job. An ordered delivery-then-projection task requires separately approved
external automation with correct account, checkout, executable environment,
timeouts, failure visibility, and no overlapping writers. Never create a scheduler
or remote shell wrapper merely because a machine was selected.

When remote access is absent, produce per-machine instructions containing the
approved target list, canonical manifest/digest, absolute root, local prerequisites,
validation/plan/diff, approval boundary, apply, and expected checks. Mark it
`handoff prepared — not executed`. Resume only from newly observed evidence.
No raw peer map, credential value, or private config dump belongs in the report.
