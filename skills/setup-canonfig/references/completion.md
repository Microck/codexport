# Completion and reporting

A command completing is not proof that the requested setup is complete. Use
observed state and Canonfig's independent verification.

## Completion states

Report exactly one:

- `complete`: every requested outcome is verified;
- `incomplete — approval required`: the next bounded mutation needs explicit
  operator approval;
- `incomplete — Human Action Required`: a human-only step is recorded;
- `incomplete — conflict or Follower Drift`: local ownership blocks apply;
- `incomplete — unsupported`: the requested outcome is outside the shipped
  contract;
- `failed`: authentication, transport, apply, or independent verification
  failed;
- `interrupted`: persisted work exists and may be recoverable.

Do not call a degraded, partially applied, or merely downloaded follower
`Converged`.

## Evidence checklist

### CLI installation

- Node.js 24 or newer and npm observed;
- exact installed Canonfig version observed;
- intended user can resolve the `canonfig` executable;
- bounded diagnostics reported.

### Source Machine

- intended user owns one Source identity;
- profile authoring and discovery inputs are identified;
- requested publication has revision ID, profile ID, sequence, digest, and
  publication time;
- `profile show` matches the reviewed candidate;
- unresolved evidence or recipes are reported rather than silently accepted.

### Follower Machine

- follower identity and human-readable name reported;
- source TLS and signing fingerprints reported as pinned, without exposing key
  material;
- selected profile, revision, and groups reported;
- final status independently reports `Converged`;
- credential references resolve through Secret Service, Keychain, or Credential
  Manager as appropriate;
- requested schedule matches the systemd user timer, launchd user agent, or
  per-user Task Scheduler task.

### Project harness

- one canonical source format;
- validation passes;
- targets and support levels reported;
- no unapproved collision, force ownership, or external edit;
- status has no pending owned changes;
- requested target probes reported.

## Failure interpretation

Canonfig CLI exit categories are:

| Code | Meaning |
| ---: | --- |
| 0 | success |
| 1 | internal defect |
| 2 | usage or configuration |
| 3 | Human Action Required |
| 4 | conflict or Follower Drift |
| 5 | authentication or revocation |
| 6 | transport |
| 7 | verification or apply failure |

Preserve the reported details, state database, pins, cache, and action journal.
Do not repair an expected failure by deleting evidence.

## Final report

Keep the report compact and omit secret values and invitation payloads:

```text
Setup result: complete

Machine
- role: Follower Machine
- name: laptop
- Canonfig: 3.1.4

Trust
- Source endpoint: https://127.0.0.1:17342
- TLS fingerprint: pinned
- signing fingerprint: pinned
- credential: stored in native secure storage

Profile
- ID: workstation
- revision: <id>
- groups: developers
- result: Converged

Schedule
- daily@09:00 Europe/Madrid
- mechanism: native user scheduler
- state: current

Unresolved
- none
```

For incomplete work, state what succeeded, the exact blocker, what was not
changed, and the next non-secret action. Do not repeat the entire setup history.
