# Optional Tailscale device choices

Use only when machine selection matters. This is passive inventory from the
current user's local Tailscale client, not subnet scanning or service discovery.
Do not run it for CLI-only or project-harness-only setup.

## Consent and fallback

Offer the same discovery choice in either mode. If the operator explicitly asked
to list Tailscale peers, that is sufficient consent for this read-only step; do
not ask again. A missing Tailscale binary is not permission to install or log in.

```text
Question: DEVICE_SOURCE — Where should the machine choices come from?
Why it matters: Local Tailscale status can list visible devices without contacting each one.
Detected: <local Tailscale executable available, or unavailable; no peer listing yet>
Recommended: List visible peers only for a requested multi-machine setup with Tailscale already available.
Options:
1. This machine only — continue without network inventory.
2. List Tailscale devices — read the current client's visible peer metadata once.
3. Enter machines manually — provide names without discovery.
4. Other (type your own) — describe a different inventory source for review.
```

If discovery is unavailable, show This machine / Manual entry / Retry after the
operator fixes Tailscale / Other, using the same question format. Never change
Tailscale login, network policy, ACLs, routes, SSH, Serve, or Funnel automatically.

## Read one bounded local snapshot

After consent, resolve the helper path relative to this installed skill, not to
the working repository. Run it with the existing Node executable:

```text
node <installed-skill-directory>/scripts/discover-tailscale.mjs
```

The dependency-free helper invokes only `tailscale status --json` (or
`tailscale.exe status --json` on Windows), without a shell, with a five-second
timeout and 1 MiB output limit. It projects only stable device ID, name, DNS name,
OS, Tailscale addresses, and online/offline/unknown status. It writes no files.
It returns `ready`, `empty`, or `unavailable`; optional discovery failure is not
a failed Canonfig installation. Importing the helper performs no discovery.

If helper execution is unavailable, use manual entry; do not request a raw status
JSON dump in chat. Keep raw peer maps, user records, public endpoints, keys,
tags, and routes out of reports, repositories, and persistent setup notes.

The JSON format can change. Treat missing/malformed data as unknown and offer a
manual fallback. Only peers visible to this client are known; this is not a full
tailnet inventory. Do not scan subnets, probe ports, ping every peer, SSH into
candidates, or run remote commands to identify them.

## Present choices without implying authority

Show self separately as `This machine`. Display a small paginated list of
candidate computers; use the reported OS only, not assumptions from hostnames.
An unknown OS remains eligible for manual review. Keep offline peers visible and
label them offline; they may be selected for later setup, not declared reachable.
Devices known to be unsuitable for the requested Node runtime should be labelled
and deferred, not automatically configured.

Example only, not observed devices:

```text
Question: SOURCE_DEVICE — Which computer owns the canonical configuration? (choose one)
Why it matters: Selecting a candidate does not initialize it or grant remote access.
Recommended: Keep the previously verified Source; otherwise No automatic recommendation.
Options:
1. This machine — local setup, subject to existing role checks.
2. studio-desktop · linux · 100.64.0.10 · reported online — unverified candidate.
3. travel-laptop · macOS · 100.64.0.11 · reported offline — defer connectivity checks.
4. Other (type your own) — provide another machine or request more results.
```

For follower selection, mark multi-select and accept `1,3` or an explicit manual
name. Selecting a source does not enroll followers. Do not automatically assign
any peer the Source role, a Follower Group, or `canonfig:secrets` membership.

Use stable device IDs internally, never array position or hostname alone. Sort
consistently; distinguish duplicate names with observed address/ID. Freeze the
number-to-ID mapping for a displayed question. After refresh, preserve selections
by ID, show changed/lost identities, and ask only about those affected. Do not
reinterpret a stale number against a reordered list. For many peers, show a page
and offer More/filter plus Other rather than printing the entire tailnet.

Treat names and custom entries as untrusted display data. Escape Markdown/control
characters in menus; never interpolate a displayed hostname into a shell command.
Do not persist the whole peer inventory. A non-secret resume record may retain
only explicitly selected device IDs and the minimum labels needed to resume.

## Discovery is not connectivity or enrollment

Tailscale reports network peers; it does not establish that Canonfig, an SSH
server, port forwarding, or usable credentials exist on a peer. Report these
separately: discovered → selected → connection verified → enrolled → converged.
Reported `online` status proves none of the later stages.

Canonfig's source server and invitation endpoints remain loopback HTTPS origins.
Do not use a 100.x Tailscale address or MagicDNS name directly as the Canonfig
bind host or invitation endpoint. A separately approved, operator-managed,
TLS-transparent tunnel may connect a follower loopback port to the source's
loopback server. It must preserve the source TLS certificate and signing pins.

Offer Existing verified tunnel / Operator configures a tunnel / Manual handoff
or defer / Other. Discovery creates no tunnel. Do not assume Tailscale SSH is
enabled, is supported on a destination OS, or allows forwarding. Do not enable
it, change ACLs, use public exposure, or disable TLS/SSH host verification.
Only after explicit device, account, and connection approval may the setup agent
perform a narrowly scoped connection check using an available authorized tool.

Record source host separately from the follower-local Canonfig endpoint; local
ports may differ. Check source process and tunnel availability before enabling a
schedule. Without authorized remote access, give per-machine handoff instructions
and mark remote work pending. Never claim fleet completion from local status.

## References

Verified against the Tailscale CLI and connection documentation on 2026-09-06:

- [CLI status and JSON format](https://tailscale.com/kb/1080/cli)
- [Device connectivity requires a service and access](https://tailscale.com/docs/how-to/connect-to-devices)
- [Tailscale SSH prerequisites and platform limitations](https://tailscale.com/docs/features/tailscale-ssh)

Fixtures in `scripts/discover-tailscale.test.mjs` cover privacy projection,
missing fields, signed-out state, empty lists, duplicate names/IDs, offline
peers, stable ordering, malformed output, missing CLI, access denial, timeout,
output bounds, and the exact read-only command. They do not test a real tailnet.
