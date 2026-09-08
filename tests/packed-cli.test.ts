import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  delimiter,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  directoryVerificationDigest,
  type JsonValue,
} from "../src/profile/profile-codec.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const packedRoot = mkdtempSync(resolve(tmpdir(), "canonfig-packed-"));
const installRoot = resolve(packedRoot, "install");
const fixtureBin = resolve(packedRoot, "bin");
const sourceHome = resolve(packedRoot, "source-home");
const followerHome = resolve(packedRoot, "follower-home");
const authoredFollowerHome = resolve(packedRoot, "authored-follower-home");
const tamperedFollowerHome = resolve(packedRoot, "tampered-follower-home");
const workstationHome = resolve(packedRoot, "workstation-home");
const restrictedHome = resolve(packedRoot, "restricted-home");
const rotatedHome = resolve(packedRoot, "rotated-home");
let executable = "";
let packedEntry = "";
let sourceProcess: ChildProcessWithoutNullStreams | undefined;
let sourceEndpoint = "";
let packedRevision = "";
let authoredRevision = "";
let packedSchedulerEnvironment: NodeJS.ProcessEnv = {};
const PackResult = Schema.Array(Schema.Struct({ filename: Schema.String }));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const directoryDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean;
  }>,
): string => directoryVerificationDigest(files.map((file) => ({
  path: file.path,
  digest: sha256(file.content),
  executable: file.executable,
})));

const runNpm = (
  cwd: string,
  arguments_: ReadonlyArray<string>,
) => {
  const npmCli = process.env.npm_execpath;
  if (process.platform === "win32" && npmCli === undefined) {
    throw new Error("npm_execpath is required for shell-free npm execution on Windows");
  }
  if (npmCli !== undefined && process.platform === "win32") {
    return spawnSync(process.execPath, [npmCli, ...arguments_], {
      cwd,
      encoding: "utf8",
      timeout: 240_000,
    });
  }
  return spawnSync("npm", [...arguments_], {
    cwd,
    encoding: "utf8",
    timeout: 240_000,
  });
};

interface PackedInvocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const environmentFor = (
  home: string,
  environment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...packedSchedulerEnvironment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: resolve(home, "AppData", "Roaming"),
    LOCALAPPDATA: resolve(home, "AppData", "Local"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: resolve(home, ".canonfig-credentials"),
    PATH: [
      fixtureBin,
      resolve(installRoot, "node_modules", ".bin"),
      process.env.PATH ?? "",
    ].filter((entry) => entry.length > 0).join(delimiter),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/canonfig-packed-test-bus",
  };
  // The caller's overrides win, including removing a variable by passing
  // undefined. These defaults used to be applied last, so a test could not
  // turn off the local-file credential policy or the Secret Service session,
  // which is exactly what credential-policy coverage needs to do.
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  return merged;
};

const invoke = (
  home: string,
  arguments_: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
): PackedInvocation => {
  const result = spawnSync(executable, [packedEntry, ...arguments_], {
    cwd: installRoot,
    encoding: "utf8",
    env: environmentFor(home, environment),
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const unusedPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const decodedAddress = Schema.decodeUnknownOption(
        Schema.Struct({ port: Schema.Int }),
      )(server.address());
      if (decodedAddress._tag === "None") {
        server.close();
        rejectPort(new Error("could not reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(decodedAddress.value.port);
        else rejectPort(error);
      });
    });
  });

const startPackedSource = (
  port: number,
): Promise<{ readonly endpoint: string }> =>
  new Promise((resolveSource, rejectSource) => {
    const child = spawn(
      executable,
      [
        packedEntry,
        "source",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        `${port}`,
        "--json",
      ],
      {
        cwd: installRoot,
        env: environmentFor(sourceHome),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    sourceProcess = child;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectSource(new Error(`packed source did not start: ${stderr}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const envelope = JSON.parse(stdout.slice(0, newline));
        resolveSource({ endpoint: envelope.data.endpoint });
      } catch (error) {
        rejectSource(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (status) => {
      clearTimeout(timeout);
      if (stdout.length === 0) {
        rejectSource(new Error(
          `packed source exited before startup (${String(status)}): ${stderr}`,
        ));
      }
    });
  });

const parseEnvelope = (result: PackedInvocation): {
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly command?: string;
  readonly status?: string;
  readonly message?: string;
} => JSON.parse(result.stdout.length > 0 ? result.stdout : result.stderr);

const requireSuccess = (
  result: PackedInvocation,
  label: string,
): ReturnType<typeof parseEnvelope> => {
  expect(result.status, `${label}: ${result.stderr}`).toBe(0);
  expect(result.stderr, label).toBe("");
  return parseEnvelope(result);
};

beforeAll(async () => {
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(fixtureBin, { recursive: true });
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(followerHome, { recursive: true });
  mkdirSync(authoredFollowerHome, { recursive: true });
  mkdirSync(tamperedFollowerHome, { recursive: true });
  mkdirSync(workstationHome, { recursive: true });
  mkdirSync(restrictedHome, { recursive: true });
  mkdirSync(rotatedHome, { recursive: true });
  const secretTool = resolve(fixtureBin, "secret-tool");
  writeFileSync(secretTool, `#!/bin/sh
set -eu
operation="$1"
key=""
for argument in "$@"; do key="$argument"; done
directory="$HOME/.canonfig-packed-secrets"
path="$directory/$key"
case "$operation" in
  store)
    mkdir -p "$directory"
    cat > "$path"
    ;;
  lookup)
    cat "$path"
    ;;
  clear)
    rm -f "$path"
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(secretTool, 0o700);
  const packed = runNpm(
    projectRoot,
    [
      "pack",
      "--ignore-scripts=false",
      "--json",
      "--pack-destination",
      packedRoot,
    ],
  );
  expect(packed.status, packed.stderr).toBe(0);
  const packedResult = Schema.decodeUnknownSync(PackResult)(
    JSON.parse(packed.stdout),
  );
  const tarball = resolve(packedRoot, packedResult[0]!.filename);
  writeFileSync(
    resolve(installRoot, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  const installed = runNpm(
    installRoot,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
  );
  expect(installed.status, installed.stderr).toBe(0);
  executable = process.execPath;
  packedEntry = resolve(
    installRoot,
    "node_modules",
    "@microck",
    "canonfig",
    "dist",
    "runtime",
    "main.js",
  );
  expect(readFileSync(
    resolve(installRoot, "node_modules/@microck/canonfig/package.json"),
    "utf8",
  )).toContain('"canonfig": "dist/runtime/main.js"');

  const initialized = invoke(sourceHome, ["source", "init", "--json"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  const proposal = resolve(sourceHome, "package.json");
  writeFileSync(proposal, JSON.stringify({
    canonfig: {
      tools: [{
        ecosystem: "npm",
        name: "node",
        executable: "node",
        version: process.versions.node,
        source: `lock:node:${process.versions.node}`,
        upstream: "https://nodejs.org",
      }],
    },
  }));
  const published = invoke(sourceHome, [
    "source",
    "publish",
    "--proposal",
    proposal,
    "--profile",
    "packed-profile",
    "--name",
    "Packed profile",
    "--reviewer",
    "packed-test",
    "--json",
  ]);
  expect(published.status, published.stderr).toBe(0);
  packedRevision = JSON.parse(published.stdout).data.id;
  const authoredProfilePath = resolve(sourceHome, "profile.jsonc");
  writeFileSync(authoredProfilePath, `{
    // Every resource kind is represented in this signed profile.
    "id": "packed-authored",
    "version": 2,
    "name": "Packed authored profile",
    "groups": [{ "name": "base" }],
    "scheduleDefault": { "type": "daily", "at": "04:30", "timezone": "local" },
    "resources": [
      {
        "id": "authored-file",
        "kind": "file",
        "target": "~/.canonfig-packed/authored.txt",
        "groups": ["base"],
        "spec": { "kind": "file", "content": "authored\\n" },
        "verify": { "method": "digest", "digest": "482f22bb838d45d8f795b20277cc427d029d867ed166e7909cdcec7d9f73adbd" }
      },
      {
        "id": "authored-directory",
        "kind": "directory",
        "target": "~/.canonfig-packed/authored-directory",
        "dependsOn": ["authored-file"],
        "spec": {
          "kind": "directory",
          "files": [{ "path": "nested.txt", "content": "nested\\n" }]
        },
        "verify": { "method": "digest", "digest": "${"b".repeat(64)}" }
      },
      {
        "id": "authored-config",
        "kind": "config",
        "target": "~/.canonfig-packed/authored.json",
        "spec": {
          "kind": "config",
          "format": "json",
          "keys": [{ "path": "authored.value", "value": true }]
        },
        "verify": { "method": "digest", "digest": "${"c".repeat(64)}" }
      },
      {
        "id": "authored-credential",
        "kind": "credential",
        "target": "~/.canonfig-packed/credentials/authored",
        "spec": { "kind": "credential", "reference": "secure-store://packed-authored" },
        "verify": {
          "method": "credential-present",
          "reference": "secure-store://packed-authored"
        }
      },
      {
        "id": "authored-skill",
        "kind": "skill",
        "target": "~/.canonfig-packed/skills/authored",
        "spec": {
          "kind": "skill",
          "name": "authored",
          "files": [{ "path": "SKILL.md", "content": "# Authored\\n" }]
        },
        "verify": { "method": "digest", "digest": "${"d".repeat(64)}" }
      },
      {
        "id": "authored-tool",
        "kind": "tool",
        "target": "~/.canonfig-packed/bin/authored-tool",
        "spec": {
          "kind": "tool",
          "toolId": "authored-tool",
          "recipes": [{
            "platform": "linux",
            "method": "npm",
            "package": "authored-tool",
            "version": "1.0.0"
          }]
        },
        "verify": { "method": "executable-present", "executable": "authored-tool" }
      }
    ]
  }
`);
  const authored = invoke(sourceHome, [
    "source",
    "publish",
    "--profile-file",
    authoredProfilePath,
    "--reviewer",
    "packed-test",
    "--json",
  ]);
  expect(authored.status, authored.stderr).toBe(0);
  authoredRevision = JSON.parse(authored.stdout).data.id;
  const port = await unusedPort();
  const source = await startPackedSource(port);
  sourceEndpoint = source.endpoint;
}, 360_000);

afterAll(() => {
  sourceProcess?.kill("SIGKILL");
  rmSync(packedRoot, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
});

describe("packed Canonfig executable", () => {
  it("runs shipped help and version entrypoints", () => {
    const help = invoke(sourceHome, ["--help"]);
    const version = invoke(followerHome, ["--version"]);
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: canonfig");
    expect(version).toEqual({ status: 0, stdout: "3.1.1\n", stderr: "" });
  });

  it("runs representative safe routes with stable JSON", () => {
    const profiles = invoke(followerHome, ["profile", "list", "--json"]);
    expect(profiles).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(profiles.stdout)).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "profile.list",
      status: "success",
      exitCode: 0,
      data: { revisions: [] },
    });

    const policy = invoke(
      followerHome,
      ["agent", "policy", "deterministic-only", "--json"],
    );
    expect(policy).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(policy.stdout)).toMatchObject({
      command: "agent.policy.set",
      exitCode: 0,
      data: "deterministic-only",
    });
  });

  it("maps invalid input to the stable usage exit code", () => {
    const result = invoke(followerHome, ["sync", "--plan", "--apply"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--plan and --apply are mutually exclusive");
  });

  it("publishes authored JSONC resources into a signed immutable revision", () => {
    const shown = invoke(sourceHome, [
      "profile",
      "show",
      authoredRevision,
      "--json",
    ]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stderr).toBe("");
    const envelope = JSON.parse(shown.stdout);
    expect(envelope.data).toMatchObject({
      id: authoredRevision,
      profileId: "packed-authored",
      signature: expect.stringMatching(/^ed25519:/u),
      scheduleDefault: { type: "daily", at: "04:30", timezone: "local" },
    });
    expect(envelope.data.resources.map((resource: { id: string }) => resource.id))
      .toEqual([
        "authored-config",
        "authored-credential",
        "authored-directory",
        "authored-file",
        "authored-skill",
        "authored-tool",
      ]);
    expect(JSON.stringify(envelope)).not.toContain("credentialValue");
    expect(JSON.stringify(envelope)).not.toContain("packed-authored-secret");
  });

  it("rejects malformed, duplicate, conflicting, and secret-bearing profile input without leakage", () => {
    const cases = [
      ["malformed", `{"id": "bad", "name": `],
      ["duplicate", `{
        "id": "bad-duplicate",
        "name": "Bad duplicate",
        "resources": [
          {
            "id": "same",
            "kind": "file",
            "target": "~/.canonfig-packed/a",
            "spec": { "kind": "file", "content": "a" },
            "verify": { "method": "digest", "digest": "${"a".repeat(64)}" }
          },
          {
            "id": "same",
            "kind": "file",
            "target": "~/.canonfig-packed/b",
            "spec": { "kind": "file", "content": "b" },
            "verify": { "method": "digest", "digest": "${"b".repeat(64)}" }
          }
        ]
      }`],
      ["conflicting", `{
        "id": "bad-conflict",
        "name": "Bad conflict",
        "resources": [
          {
            "id": "one",
            "kind": "file",
            "target": "~/.canonfig-packed/conflict",
            "spec": { "kind": "file", "content": "a" },
            "verify": { "method": "digest", "digest": "${"a".repeat(64)}" }
          },
          {
            "id": "two",
            "kind": "file",
            "target": "~/.canonfig-packed/./conflict",
            "spec": { "kind": "file", "content": "b" },
            "verify": { "method": "digest", "digest": "${"b".repeat(64)}" }
          }
        ]
      }`],
      ["secret", `{
        "id": "bad-secret",
        "name": "Bad secret",
        "credentialValue": "packed-profile-secret-must-not-leak"
      }`],
    ] as const;
    for (const [name, text] of cases) {
      const path = resolve(sourceHome, `${name}.jsonc`);
      writeFileSync(path, text);
      const result = invoke(sourceHome, [
        "source",
        "publish",
        "--profile-file",
        path,
        "--reviewer",
        "packed-test",
        "--json",
      ]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("packed-profile-secret-must-not-leak");
      expect(result.stderr).toContain("authored profile file");
    }
  });

  it("exposes the authored revision through signed follower transport", () => {
    const invitationResult = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(invitationResult.status, invitationResult.stderr).toBe(0);
    const enrolled = invoke(authoredFollowerHome, [
      "follower",
      "enroll",
      JSON.parse(invitationResult.stdout).data.invite,
      "--name",
      "packed-authored-follower",
      "--profile",
      "packed-authored",
      "--json",
    ]);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const plan = invoke(authoredFollowerHome, [
      "sync",
      "--plan",
      "--json",
    ]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout).data).toMatchObject({
      revision: authoredRevision,
    });
  });

  it("resolves the enrolled credential policy without the environment", () => {
    // A native scheduled job carries no environment, and the local-file policy
    // used to be selected only by CANONFIG_LOCAL_CREDENTIAL_ROOT, so a follower
    // enrolled under it had no credential during a scheduled run and every
    // fire failed. The enrolled configuration is the authority now.
    const withoutEnvironment = invoke(
      authoredFollowerHome,
      ["status", "--json"],
      { CANONFIG_LOCAL_CREDENTIAL_ROOT: undefined },
    );
    expect(withoutEnvironment.status, withoutEnvironment.stderr).toBe(0);
    expect(JSON.parse(withoutEnvironment.stdout).data.follower.name).toBe(
      "packed-authored-follower",
    );

    // A plan needs the credential to authenticate to the source, so this is
    // the assertion that actually exercises credential resolution.
    const planned = invoke(
      authoredFollowerHome,
      ["sync", "--plan", "--json"],
      { CANONFIG_LOCAL_CREDENTIAL_ROOT: undefined },
    );
    expect(planned.status, planned.stderr).toBe(0);
  });

  it("probes the agent policy the enrolled follower actually runs under", () => {
    // `agent policy` writes to the follower configuration once enrolled, and a
    // run reads it from there. The doctor probe read ~/.canonfig/policy.json,
    // which enrollment stops using, so an enrolled follower with an agent
    // policy and no harness reported a skipped probe instead of the failure a
    // run would hit.
    const policy = invoke(authoredFollowerHome, ["agent", "policy", "agent-apply", "--json"]);
    expect(policy.status, policy.stderr).toBe(0);

    const result = invoke(
      authoredFollowerHome,
      ["doctor", "--json", "--no-input", "--timeout-ms", "2000"],
    );
    const envelope = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
    const agentProbe = envelope.data.probes.find(
      (probe: { readonly name: string }) => probe.name === "agent-adapter",
    );
    expect(agentProbe).toMatchObject({
      name: "agent-adapter",
      status: "fail",
      details: { policy: "agent-apply", configured: false },
    });

    const restored = invoke(
      authoredFollowerHome,
      ["agent", "policy", "deterministic-only", "--json"],
    );
    expect(restored.status, restored.stderr).toBe(0);
  });

  it("refuses to replace a completed enrollment unless asked", () => {
    const invitationResult = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(invitationResult.status, invitationResult.stderr).toBe(0);
    // A completed enrollment is a singleton. Enrolling over it silently left
    // the previous identity's records orphaned under an id nothing used.
    const again = invoke(authoredFollowerHome, [
      "follower",
      "enroll",
      JSON.parse(invitationResult.stdout).data.invite,
      "--name",
      "packed-second-name",
      "--profile",
      "packed-authored",
      "--json",
    ]);
    expect(again.status).toBe(4);
    const envelope = JSON.parse(again.stderr);
    expect(envelope.message).toContain("already enrolled");
    expect(envelope.message).toContain("--replace");

    // The original identity is untouched.
    const status = invoke(authoredFollowerHome, ["status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).data.follower.name).toBe(
      "packed-authored-follower",
    );
  });

  it("runs doctor with bounded noninteractive probes and redaction", () => {
    const secret = "packed-doctor-secret-must-not-leak";
    const result = invoke(
      followerHome,
      ["doctor", "--json", "--no-input", "--timeout-ms", "2000"],
      {
        CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
        CANONFIG_SOURCE_TLS_FINGERPRINT: "packed-fingerprint",
        CANONFIG_SOURCE_CREDENTIAL_REFERENCE: secret,
      },
    );
    const doctorExitCodes = process.platform === "win32" ? [5, 7] : [5];
    expect(doctorExitCodes).toContain(result.status);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    const envelope = JSON.parse(result.stderr);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "error",
      exitCode: result.status,
      data: {
        schema: "canonfig.doctor/v1",
        noInput: true,
        status: "unhealthy",
      },
    });
    expect(envelope.data.probes).toHaveLength(7);
  });

  it("keeps unavailable scheduled apply quiet on stdout and truthful on stderr", () => {
    const first = invoke(
      followerHome,
      ["sync", "--apply", "--no-input"],
    );
    const second = invoke(
      followerHome,
      ["sync", "--apply", "--no-input"],
    );
    expect(first.status).toBe(2);
    expect(first.stdout).toBe("");
    expect(first.stderr).toBe(
      "follower synchronization configuration is not enrolled\n",
    );
    expect(second).toEqual(first);
    expect(first.stderr).not.toContain("completed");
  });

  it("runs an authenticated source-to-follower lifecycle across packed processes", () => {
    const invitationResult = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(invitationResult.status, invitationResult.stderr).toBe(0);
    const invitation = JSON.parse(invitationResult.stdout).data.invite;
    const enrolled = invoke(followerHome, [
      "follower",
      "enroll",
      invitation,
      "--name",
      "packed-follower",
      "--profile",
      "packed-profile",
      "--json",
    ]);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const follower = JSON.parse(enrolled.stdout).data.follower.id;

    const overlays = invoke(followerHome, ["overlay", "list", "--json"]);
    expect(overlays.status, overlays.stderr).toBe(0);
    expect(JSON.parse(overlays.stdout).data).toEqual({ overlays: [] });

    // Every platform converges. This used to expect exit 7 on Linux, because
    // the plan always appended a schedule-default action and that action failed
    // without a systemd user session, so a container or headless host could
    // never converge. The native job is no longer a planned action.
    const first = invoke(followerHome, ["sync", "--apply", "--json"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      command: "sync.apply",
      status: "success",
      exitCode: 0,
      data: {
        revision: packedRevision,
        outcome: { outcome: "Converged" },
      },
    });

    const second = invoke(
      followerHome,
      ["sync", "--apply", "--no-input", "--json"],
    );
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      command: "sync.apply",
      status: "success",
      exitCode: 0,
      data: {
        revision: packedRevision,
        outcome: { outcome: "Converged" },
      },
    });

    const status = invoke(followerHome, ["status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).data.follower.id).toBe(follower);
    const recovery = invoke(followerHome, ["recover", "--no-input", "--json"]);
    expect(recovery.status).toBe(2);
    expect(recovery.stdout).toBe("");
    expect(JSON.parse(recovery.stderr)).toMatchObject({
      command: "recover",
      status: "error",
      exitCode: 2,
    });

    // `abandon` is the terminal close for a run `recover` cannot resolve. It
    // reports the same way when there is nothing open, so an operator can tell
    // "nothing to abandon" from "abandoned it".
    const abandon = invoke(followerHome, ["abandon", "--json"]);
    expect(abandon.status).toBe(2);
    expect(abandon.stdout).toBe("");
    expect(JSON.parse(abandon.stderr)).toMatchObject({
      command: "abandon",
      status: "error",
      exitCode: 2,
    });

    const revoked = invoke(sourceHome, [
      "source",
      "revoke",
      follower,
      "--json",
    ]);
    expect(revoked.status, revoked.stderr).toBe(0);
    const rejected = invoke(followerHome, ["sync", "--apply", "--json"]);
    expect(rejected.status).toBe(5);
    expect(rejected.stdout).toBe("");
  }, 180_000);

  it("rejects a tampered TLS fingerprint from the packed executable", () => {
    const secondInvitation = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(secondInvitation.status, secondInvitation.stderr).toBe(0);
    const tamperedEnrollment = invoke(tamperedFollowerHome, [
      "follower",
      "enroll",
      JSON.parse(secondInvitation.stdout).data.invite,
      "--name",
      "tampered-follower",
      "--profile",
      "packed-profile",
      "--json",
    ]);
    expect(tamperedEnrollment.status, tamperedEnrollment.stderr).toBe(0);
    const statePath = resolve(tamperedFollowerHome, ".canonfig/state.sqlite");
    const database = new DatabaseSync(statePath);
    const row = Schema.decodeUnknownSync(Schema.Struct({
      configuration_json: Schema.String,
    }))(database.prepare(`
      SELECT configuration_json
      FROM follower_sync_configuration
      WHERE singleton = 1
    `).get());
    const configuration = JSON.parse(row.configuration_json);
    configuration.source.tlsFingerprint = "tampered-tls-fingerprint";
    database.prepare(`
      UPDATE follower_sync_configuration
      SET configuration_json = ?
      WHERE singleton = 1
    `).run(JSON.stringify(configuration));
    database.close();
    const tampered = invoke(
      tamperedFollowerHome,
      ["sync", "--apply", "--json"],
    );
    expect(tampered.status).not.toBe(0);
    expect(tampered.stdout).toBe("");
  });

  it("converges a packed source across multiple isolated followers", () => {
    const scanFiles = {
      agents: resolve(sourceHome, "AGENTS.md"),
      hooks: resolve(sourceHome, "hooks.sh"),
      mcp: resolve(sourceHome, "mcp.json"),
      settings: resolve(sourceHome, "settings.json"),
      package: resolve(sourceHome, "package.json"),
    };
    writeFileSync(scanFiles.agents, `# Source machine instructions

\`\`\`sh
node --version
npm install --global canonfig-fixture@1.0.0
\`\`\`
`);
    writeFileSync(scanFiles.hooks, "#!/bin/sh\nnode --version\n");
    writeFileSync(
      scanFiles.mcp,
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["--version"] },
        },
      }),
    );
    writeFileSync(
      scanFiles.settings,
      JSON.stringify({
        hooks: {
          onStart: [{ command: ["node", "--version"] }],
        },
      }),
    );
    writeFileSync(
      scanFiles.package,
      JSON.stringify({
        name: "packed-source-tools",
        version: "1.0.0",
        bin: { "packed-source-tool": "bin.js" },
      }),
    );
    const scan = requireSuccess(
      invoke(sourceHome, [
        "source",
        "scan",
        "--file",
        scanFiles.agents,
        "--file",
        scanFiles.hooks,
        "--file",
        scanFiles.mcp,
        "--file",
        scanFiles.settings,
        "--file",
        scanFiles.package,
        "--json",
      ]),
      "scan source machine metadata",
    );
    expect(scan.data.scannedPaths).toHaveLength(5);
    const evidenceKinds = new Set(
      // SAFETY: The scan response contract emits evidence records with string
      // kinds, and the preceding response assertion verifies that envelope.
      (scan.data.evidence as ReadonlyArray<{ readonly kind: string }>)
        .map((entry) => entry.kind),
    );
    expect(evidenceKinds).toEqual(
      new Set(["agents", "hook", "mcp", "package-metadata"]),
    );

    const configV1 = JSON.stringify({
      canonical: { enabled: true, removed: "v1" },
    }, undefined, 2) + "\n";
    const configV2 = JSON.stringify({
      canonical: { enabled: false },
    }, undefined, 2) + "\n";
    const directoryV1 = [
      { path: "keep.txt", content: "directory v1\n" },
      { path: "remove.txt", content: "owned v1\n" },
    ];
    const directoryV2 = [
      { path: "keep.txt", content: "directory v2\n" },
    ];
    const skillFiles = [{ path: "SKILL.md", content: "# Packed multi skill\n" }];
    const profilePath = resolve(sourceHome, "packed-multi.jsonc");
    const profileFor = (version: 1 | 2): string => {
      const directory = version === 1 ? directoryV1 : directoryV2;
      const fileContent = version === 1 ? "version one\n" : "version two\n";
      const resources = [
        {
          id: "base-file",
          kind: "file",
          policy: "replace",
          target: "~/.canonfig-packed-multi/managed.txt",
          groups: ["base"],
          spec: { kind: "file", content: fileContent },
          verify: { method: "digest", digest: sha256(fileContent) },
        },
        {
          id: "base-executable",
          kind: "file",
          policy: "replace",
          target: "~/.canonfig-packed-multi/bin/managed-tool",
          groups: ["base"],
          spec: {
            kind: "file",
            content: "#!/bin/sh\necho packed-multi\n",
            executable: true,
          },
          verify: {
            method: "digest",
            digest: sha256("#!/bin/sh\necho packed-multi\n"),
          },
        },
        {
          id: "base-directory",
          kind: "directory",
          policy: "mirror-owned",
          target: "~/.canonfig-packed-multi/mirror",
          groups: ["base"],
          dependsOn: ["base-file"],
          spec: { kind: "directory", files: directory },
          verify: { method: "digest", digest: directoryDigest(directory) },
        },
        {
          id: "base-config",
          kind: "config",
          policy: "merge",
          target: "~/.canonfig-packed-multi/settings.json",
          groups: ["base"],
          spec: {
            kind: "config",
            format: "json",
            keys: version === 1
              ? [
                { path: "canonical.enabled", value: true },
                { path: "canonical.removed", value: "v1" },
              ]
              : [{ path: "canonical.enabled", value: false }],
          },
          verify: {
            method: "digest",
            digest: sha256(version === 1 ? configV1 : configV2),
          },
        },
        {
          id: "base-skill",
          kind: "skill",
          policy: "replace-if-unmodified",
          target: "~/.canonfig-packed-multi/skills/packed",
          groups: ["base"],
          spec: { kind: "skill", name: "packed", files: skillFiles },
          verify: { method: "digest", digest: directoryDigest(skillFiles) },
        },
        ...(version === 1
          ? [
            {
              id: "restricted-file",
              kind: "file",
              policy: "replace",
              target: "~/.canonfig-packed-multi/restricted.txt",
              groups: ["restricted"],
              spec: { kind: "file", content: "restricted\n" },
              verify: {
                method: "digest",
                digest: sha256("restricted\n"),
              },
            },
            {
              id: "human-tool",
              kind: "tool",
              policy: "ensure",
              target: "packed-human-tool",
              groups: ["restricted"],
              spec: {
                kind: "tool",
                toolId: "packed-human-tool",
                recipes: [
                  {
                    platform: "linux",
                    method: "source",
                    package: "packed-human-tool",
                    version: "v1.0.0",
                  },
                  {
                    platform: "macos",
                    method: "source",
                    package: "packed-human-tool",
                    version: "v1.0.0",
                  },
                  {
                    platform: "windows",
                    method: "source",
                    package: "packed-human-tool",
                    version: "v1.0.0",
                  },
                ],
                login: { required: false },
              },
              verify: {
                method: "executable-present",
                executable: "packed-human-tool",
              },
            },
          ]
          : []),
        {
          id: "credential-metadata",
          kind: "credential",
          policy: "require-local",
          target: "~/.canonfig-packed-multi/credentials/metadata",
          groups: ["secrets"],
          spec: {
            kind: "credential",
            reference: "secret-service:packed-multi-hidden",
          },
          verify: {
            method: "credential-present",
            reference: "secret-service:packed-multi-hidden",
          },
        },
      ];
      return `{
  // This profile is authored JSONC and is content-addressed on publish.
  "id": "packed-multi",
  "version": 2,
  "name": "Packed multi-follower profile",
  "groups": [
    { "name": "base" },
    { "name": "restricted" },
    { "name": "secrets" }
  ],
  "scheduleDefault": {
    "type": "daily",
    "at": "00:00",
    "timezone": "local"
  },
  "resources": ${JSON.stringify(resources, undefined, 2)}
}
`;
    };

    writeFileSync(profilePath, profileFor(1));
    const firstPublication = requireSuccess(
      invoke(sourceHome, [
        "source",
        "publish",
        "--profile-file",
        profilePath,
        "--reviewer",
        "packed-multi-reviewer",
        "--json",
      ]),
      "publish packed multi-follower revision one",
    );
    const revisionOne = String(firstPublication.data.id);
    const shown = requireSuccess(
      invoke(sourceHome, ["profile", "show", revisionOne, "--json"]),
      "inspect packed multi-follower revision one",
    );
    expect(JSON.stringify(shown.data)).not.toContain("credentialValue");
    expect(JSON.stringify(shown.data)).not.toContain("packed-multi-secret");
    expect(
      // SAFETY: The signed revision response contract emits normalized resource
      // records, and the preceding response assertion verifies that envelope.
      (shown.data.resources as ReadonlyArray<{ readonly id: string }>)
        .map((resource) => resource.id),
    ).toEqual([
      "base-config",
      "base-directory",
      "base-executable",
      "base-file",
      "base-skill",
      "credential-metadata",
      "human-tool",
      "restricted-file",
    ]);

    const invitationFor = (
      group: "base" | "restricted",
    ): string => {
      const invitation = requireSuccess(
        invoke(sourceHome, [
          "source",
          "invite",
          "--endpoint",
          sourceEndpoint,
          "--expires",
          "15m",
          "--group",
          group,
          "--json",
        ]),
        `issue ${group} invitation`,
      );
      return String(invitation.data.invite);
    };
    const enroll = (
      home: string,
      invitation: string,
      name: string,
    ): string => {
      const result = requireSuccess(
        invoke(home, [
          "follower",
          "enroll",
          invitation,
          "--name",
          name,
          "--profile",
          "packed-multi",
          "--json",
        ]),
        `enroll ${name}`,
      );
      return String(
        // SAFETY: Enrollment success always includes the follower identifier
        // required by the persisted follower contract.
        (result.data.follower as { readonly id: string }).id,
      );
    };
    const workstationId = enroll(
      workstationHome,
      invitationFor("base"),
      "packed-workstation",
    );
    const _restrictedId = enroll(
      restrictedHome,
      invitationFor("restricted"),
      "packed-restricted",
    );
    const rotatedInvitation = invitationFor("base");
    const rotatedId = enroll(
      rotatedHome,
      rotatedInvitation,
      "packed-rotated",
    );
    const replay = invoke(
      resolve(packedRoot, "replay-home"),
      [
        "follower",
        "enroll",
        rotatedInvitation,
        "--name",
        "packed-replay",
        "--profile",
        "packed-multi",
        "--json",
      ],
    );
    // Replaying a consumed invitation is an authorization refusal, not a
    // transport failure: the request reached the Source Machine and was
    // answered. It exited 6 only because the old categorizer matched the word
    // "Invitation" in the error type name and filed it under transport.
    expect(replay.status).toBe(5);
    expect(replay.stdout).toBe("");

    const workstationStatus = requireSuccess(
      invoke(workstationHome, ["status", "--json"]),
      "render workstation status",
    );
    // SAFETY: Status success always includes the enrolled follower identity
    // and its credential reference.
    const workstationFollower = workstationStatus.data.follower as {
      readonly credentialReference: string;
      readonly id: string;
    };
    expect(workstationFollower.id).toBe(workstationId);
    expect(workstationStatus.data.sourceIdentity).toMatchObject({
      publicKeyFingerprint: expect.any(String),
    });
    expect(statSync(resolve(workstationHome, ".canonfig", "state.sqlite")).isFile())
      .toBe(true);

    // The follower owns its native job, so it has none until it asks for one.
    // `schedule status` used to render a built-in default whether or not
    // anything was scheduled, which is why the only schedule that could ever
    // read `current` was a daily 00:00 job installed from PATH.
    const beforeAnySchedule = requireSuccess(
      invoke(workstationHome, ["schedule", "status", "--json"]),
      "report no schedule before one is chosen",
    );
    expect(beforeAnySchedule.data).toEqual({ state: "disabled" });
    const schedulerInstall = invoke(workstationHome, [
      "schedule",
      "set",
      "daily@00:00",
      "--json",
    ]);
    let schedulerAvailable = schedulerInstall.status === 0;
    if (!schedulerAvailable && process.platform === "linux") {
      const simulatedSystemctl = resolve(fixtureBin, "systemctl-simulated");
      writeFileSync(simulatedSystemctl, `#!/bin/sh
set -eu
operation="\${2:-}"
marker="$HOME/.canonfig-packed-systemd-enabled"
case "$operation" in
  daemon-reload) exit 0 ;;
  is-enabled)
    if test -f "$marker"; then
      printf 'enabled\n'
      exit 0
    fi
    printf 'disabled\n'
    exit 1
    ;;
  is-active)
    if test -f "$marker"; then
      printf 'active\n'
      exit 0
    fi
    printf 'inactive\n'
    exit 3
    ;;
  enable) touch "$marker" ;;
  disable) rm -f "$marker" ;;
  *) exit 0 ;;
esac
`);
      chmodSync(simulatedSystemctl, 0o700);
      packedSchedulerEnvironment = {
        CANONFIG_SYSTEMCTL: simulatedSystemctl,
      };
      const simulatedInstall = invoke(workstationHome, [
        "schedule",
        "set",
        "daily@00:00",
        "--json",
      ]);
      requireSuccess(simulatedInstall, "install simulated Linux scheduler");
      schedulerAvailable = true;
    }
    if (!schedulerAvailable) {
      console.warn(
        `native scheduler installation unavailable on ${process.platform}; `
          + "packed multi-follower apply coverage is limited to plan/transport "
          + `and rendering (${schedulerInstall.stderr.trim()})`,
      );
      return;
    }
    const schedulerState = requireSuccess(
      invoke(workstationHome, ["schedule", "status", "--json"]),
      "verify installed native scheduler",
    );
    expect(schedulerState.data.state).toBe("current");
    expect(schedulerState.data).toMatchObject({
      platform: process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
        ? "windows"
        : "linux",
      definition: {
        mechanism: process.platform === "darwin"
          ? "launchd-user-agent"
          : process.platform === "win32"
          ? "task-scheduler"
          : "systemd-user-timer",
      },
    });

    const root = resolve(workstationHome, ".canonfig-packed-multi");
    mkdirSync(resolve(root, "mirror"), { recursive: true });
    writeFileSync(
      resolve(root, "mirror", "unowned.txt"),
      "local unowned\n",
    );
    writeFileSync(
      resolve(root, "settings.json"),
      JSON.stringify({
        local: { keep: "preserve" },
        canonical: { existing: "preserve" },
      }, undefined, 2) + "\n",
    );
    const overlaySet = requireSuccess(
      invoke(workstationHome, [
        "overlay",
        "set",
        "base-config",
        "--target",
        "~/.canonfig-packed-multi/settings.json",
        "--key",
        "canonical.enabled",
        "--json",
      ]),
      "set local overlay conflict",
    );
    expect(overlaySet.data).toMatchObject({
      resource: "base-config",
      saved: true,
      keys: ["canonical.enabled"],
    });
    const overlayList = requireSuccess(
      invoke(workstationHome, ["overlay", "list", "--json"]),
      "list local overlay conflict",
    );
    expect(overlayList.data.overlays).toEqual([
      expect.objectContaining({
        resource: "base-config",
        keys: ["canonical.enabled"],
      }),
    ]);
    const overlayConflict = invoke(
      workstationHome,
      ["sync", "--apply", "--no-input", "--json"],
    );
    expect(overlayConflict.status).toBe(3);
    expect(overlayConflict.stdout).toBe("");
    expect(JSON.parse(overlayConflict.stderr).data.outcome.outcome)
      .toBe("HumanActionRequired");
    expect(JSON.parse(readFileSync(resolve(root, "settings.json"), "utf8")))
      .toEqual({
        local: { keep: "preserve" },
        canonical: { existing: "preserve" },
      });
    requireSuccess(
      invoke(workstationHome, ["overlay", "remove", "base-config", "--json"]),
      "remove local overlay conflict",
    );
    expect(
      requireSuccess(
        invoke(workstationHome, ["overlay", "list", "--json"]),
        "list overlays after removal",
      ).data.overlays,
    ).toEqual([]);

    const workstationPlan = requireSuccess(
      invoke(workstationHome, ["sync", "--plan", "--json"]),
      "plan workstation revision one",
    );
    // SAFETY: The plan response contract emits a revision and ordered actions.
    const planOne = workstationPlan.data.plan as {
      readonly revision: string;
      readonly actions: ReadonlyArray<{
        readonly kind: string;
        readonly resource: string;
      }>;
    };
    expect(workstationPlan.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: expect.any(Number),
      reusedBlobs: expect.any(Number),
    });
    expect(
      Number(workstationPlan.data.downloadedBlobs)
        + Number(workstationPlan.data.reusedBlobs),
    ).toBeGreaterThan(0);
    expect(planOne.actions.map((action) => action.resource)).toEqual(
      expect.arrayContaining([
        "base-config",
        "base-directory",
        "base-executable",
        "base-file",
        "base-skill",
      ]),
    );
    expect(planOne.actions.map((action) => action.resource))
      .not.toContain("restricted-file");
    expect(planOne.actions.map((action) => action.resource))
      .not.toContain("credential-metadata");

    const doctor = requireSuccess(
      invoke(
        workstationHome,
        ["doctor", "--no-input", "--timeout-ms", "10000", "--json"],
        {
          CANONFIG_SOURCE_ENDPOINT: sourceEndpoint,
          CANONFIG_SOURCE_TLS_FINGERPRINT: String(
            // SAFETY: Invitation payloads are created by the source CLI and
            // always carry the TLS fingerprint consumed by the doctor probe.
            (JSON.parse(
              Buffer.from(
                invitationFor("base"),
                "base64url",
              ).toString("utf8"),
            ) as { readonly tlsFingerprint: string }).tlsFingerprint,
          ),
          CANONFIG_SOURCE_CREDENTIAL_REFERENCE:
            workstationFollower.credentialReference,
        },
      ),
      "run healthy doctor probes",
    );
    expect(doctor.data).toMatchObject({
      schema: "canonfig.doctor/v1",
      status: "degraded",
      noInput: true,
      probes: expect.arrayContaining([
        expect.objectContaining({ name: "source", status: "pass" }),
        expect.objectContaining({ name: "credentials", status: "warning" }),
      ]),
    });

    const firstApply = requireSuccess(
      invoke(workstationHome, ["sync", "--apply", "--json"]),
      "apply workstation revision one",
    );
    expect(firstApply.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: 0,
      outcome: { outcome: "Converged" },
    });
    expect(readFileSync(resolve(root, "managed.txt"), "utf8"))
      .toBe("version one\n");
    const executableMetadata = statSync(resolve(root, "bin", "managed-tool"));
    expect(executableMetadata.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(executableMetadata.mode & 0o100).not.toBe(0);
    }
    expect(readFileSync(resolve(root, "mirror", "keep.txt"), "utf8"))
      .toBe("directory v1\n");
    expect(readFileSync(resolve(root, "mirror", "unowned.txt"), "utf8"))
      .toBe("local unowned\n");
    expect(JSON.parse(readFileSync(resolve(root, "settings.json"), "utf8")))
      .toEqual({
        local: { keep: "preserve" },
        canonical: { existing: "preserve", enabled: true, removed: "v1" },
      });
    expect(readFileSync(resolve(root, "skills", "packed", "SKILL.md"), "utf8"))
      .toBe("# Packed multi skill\n");

    const secondApply = requireSuccess(
      invoke(workstationHome, ["sync", "--apply", "--no-input", "--json"]),
      "idempotent workstation revision one apply",
    );
    expect(secondApply.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: 0,
      reusedBlobs: expect.any(Number),
      outcome: { outcome: "Converged" },
    });
    expect(
      // SAFETY: A converged synchronization response includes verified
      // resource identifiers in its outcome details.
      (secondApply.data.outcome as { readonly verified: ReadonlyArray<string> })
        .verified,
    ).toEqual(expect.arrayContaining([
      "base-config",
      "base-directory",
      "base-executable",
      "base-file",
      "base-skill",
    ]));

    const oldRotatedStatus = requireSuccess(
      invoke(rotatedHome, ["status", "--json"]),
      "capture pre-revocation follower status",
    );
    // SAFETY: Status success always includes the enrolled follower credential
    // reference used to prove rotation.
    const oldRotatedFollower = oldRotatedStatus.data.follower as {
      readonly credentialReference: string;
    };
    const oldRotatedCredential = readFileSync(
      oldRotatedFollower.credentialReference.replace(/^local-file:/u, ""),
      "utf8",
    );

    writeFileSync(profilePath, profileFor(2));
    const secondPublication = requireSuccess(
      invoke(sourceHome, [
        "source",
        "publish",
        "--profile-file",
        profilePath,
        "--reviewer",
        "packed-multi-reviewer",
        "--json",
      ]),
      "publish packed multi-follower revision two",
    );
    const revisionTwo = String(secondPublication.data.id);
    expect(revisionTwo).not.toBe(revisionOne);

    const scheduleDrift = requireSuccess(
      invoke(workstationHome, [
        "schedule",
        "set",
        "daily@01:00",
        "--json",
      ]),
      "mutate native schedule before revision two",
    );
    expect(scheduleDrift.data).toMatchObject({
      status: { state: "current" },
    });

    // A broken native scheduler no longer fails the run. Scheduler
    // reconciliation is not part of the resource transaction, so it cannot roll
    // back configuration that applied correctly, and the follower converges on
    // a host whose scheduler does not work at all.
    const failSystemctl = resolve(fixtureBin, "systemctl-fail");
    writeFileSync(failSystemctl, "#!/bin/sh\nexit 42\n");
    chmodSync(failSystemctl, 0o700);
    const failedApply = invoke(
      workstationHome,
      ["sync", "--apply", "--no-input", "--json"],
      process.platform === "linux"
        ? { CANONFIG_SYSTEMCTL: failSystemctl }
        : {},
    );
    expect(failedApply.status, failedApply.stderr).toBe(0);

    const appliedRevisionTwo = parseEnvelope(failedApply);
    expect(appliedRevisionTwo.data).toMatchObject({
      revision: revisionTwo,
      outcome: { outcome: "Converged" },
    });
    expect(readFileSync(resolve(root, "managed.txt"), "utf8"))
      .toBe("version two\n");
    expect(readFileSync(resolve(root, "mirror", "keep.txt"), "utf8"))
      .toBe("directory v2\n");
    expect(readFileSync(resolve(root, "mirror", "unowned.txt"), "utf8"))
      .toBe("local unowned\n");
    expect(() => statSync(resolve(root, "mirror", "remove.txt"))).toThrow();
    // `canonical.removed` was declared in revision one and dropped in revision
    // two, so it is gone. It used to stay behind with its old value while the
    // plan read no-op, and only removing the whole resource ever removed an
    // owned key. The Local Overlay is untouched.
    expect(JSON.parse(readFileSync(resolve(root, "settings.json"), "utf8")))
      .toEqual({
        local: { keep: "preserve" },
        canonical: { existing: "preserve", enabled: false },
      });
    // The operator's own `schedule set daily@01:00` survives the apply. It used
    // to last exactly one run, because the plan reinstalled the profile default
    // over it every time.
    expect(requireSuccess(
      invoke(workstationHome, ["schedule", "status", "--json"]),
      "verify the follower's own schedule survives an apply",
    ).data.schedule).toMatchObject({ kind: "daily", localTime: "01:00" });

    const restrictedPlan = requireSuccess(
      invoke(restrictedHome, ["sync", "--plan", "--json"]),
      "plan restricted follower after resource removal",
    );
    // SAFETY: The plan response contract emits the selected revision and
    // authorized resource actions.
    const restrictedPlanBody = restrictedPlan.data.plan as {
      readonly revision: string;
      readonly actions: ReadonlyArray<{ readonly resource: string }>;
    };
    expect(restrictedPlanBody.revision.split(":view:")[0]).toBe(revisionTwo);
    expect(restrictedPlanBody.actions.map((action) => action.resource))
      .not.toContain("restricted-file");
    expect(restrictedPlanBody.actions.map((action) => action.resource))
      .not.toContain("human-tool");
    const restrictedApply = requireSuccess(
      invoke(restrictedHome, ["sync", "--apply", "--no-input", "--json"]),
      "clean up restricted follower authorized view",
    );
    expect(restrictedApply.data.outcome).toMatchObject({
      outcome: "Converged",
    });
    expect(requireSuccess(
      invoke(restrictedHome, ["schedule", "status", "--json"]),
      "verify restricted follower schedule remains active",
    ).data.state).toBe("current");
    expect(() => statSync(resolve(
      restrictedHome,
      ".canonfig-packed-multi",
      "restricted.txt",
    ))).toThrow();

    const revoked = requireSuccess(
      invoke(sourceHome, ["source", "revoke", rotatedId, "--json"]),
      "revoke rotated follower",
    );
    expect(revoked.data).toMatchObject({
      follower: rotatedId,
      revoked: true,
    });
    const denied = invoke(rotatedHome, ["sync", "--plan", "--json"]);
    expect(denied.status).toBe(5);
    expect(denied.stdout).toBe("");
    expect(JSON.parse(denied.stderr)).toMatchObject({
      command: "sync.plan",
      exitCode: 5,
      message: "the follower credential has been revoked",
    });

    const reEnrolled = enroll(
      rotatedHome,
      invitationFor("base"),
      "packed-rotated",
    );
    expect(reEnrolled).toBe(rotatedId);
    const newRotatedStatus = requireSuccess(
      invoke(rotatedHome, ["status", "--json"]),
      "capture post-reenrollment follower status",
    );
    expect(
      // SAFETY: Re-enrollment status includes the newly issued credential
      // reference under the same follower identity.
      (newRotatedStatus.data.follower as {
        readonly credentialReference: string;
      }).credentialReference,
    ).toBe(oldRotatedFollower.credentialReference);
    expect(
      readFileSync(
        oldRotatedFollower.credentialReference.replace(/^local-file:/u, ""),
        "utf8",
      ),
    ).not.toBe(oldRotatedCredential);
    expect(newRotatedStatus.data.sourceIdentity).toMatchObject({
      publicKeyFingerprint:
        // SAFETY: The workstation status assertion above verifies source
        // identity is present and fingerprinted.
        (workstationStatus.data.sourceIdentity as {
          readonly publicKeyFingerprint: string;
        }).publicKeyFingerprint,
    });
    expect(requireSuccess(
      invoke(rotatedHome, ["sync", "--plan", "--json"]),
      "plan rotated follower after reenrollment",
    ).data.revision).toBe(revisionTwo);

    const interruptedRoot = resolve(workstationHome, ".canonfig-packed-multi");
    writeFileSync(resolve(interruptedRoot, "managed.txt"), "interrupted\n");
    const recoveryPlanResult = requireSuccess(
      invoke(workstationHome, ["sync", "--plan", "--json"]),
      "plan interrupted workstation state",
    );
    // SAFETY: The plan response contract emits a revision and action ids used
    // to seed the interrupted-run journal.
    const recoveryPlan = recoveryPlanResult.data.plan as {
      readonly revision: string;
      readonly actions: ReadonlyArray<{ readonly id: string }>;
    };
    expect(recoveryPlan.actions.length).toBeGreaterThan(0);
    const recoveryRun = "packed-multi-recovery";
    const database = new DatabaseSync(
      resolve(workstationHome, ".canonfig", "state.sqlite"),
    );
    database.prepare(`
      INSERT INTO synchronization_runs (
        id, follower_id, revision_id, status, plan_json, started_at
      ) VALUES (?, ?, ?, 'applying', ?, ?)
    `).run(
      recoveryRun,
      workstationId,
      recoveryPlan.revision,
      JSON.stringify(recoveryPlan),
      new Date().toISOString(),
    );
    for (const [ordinal, action] of recoveryPlan.actions.entries()) {
      database.prepare(`
        INSERT INTO run_actions (run_id, action_id, plan_ordinal)
        VALUES (?, ?, ?)
      `).run(recoveryRun, action.id, ordinal);
      database.prepare(`
        INSERT INTO action_journal (
          run_id, action_id, sequence, state, recorded_at, attempt
        ) VALUES (?, ?, ?, 'pending', ?, 0)
      `).run(
        recoveryRun,
        action.id,
        ordinal,
        new Date().toISOString(),
      );
    }
    database.close();
    const recovered = requireSuccess(
      invoke(workstationHome, ["recover", "--no-input", "--json"]),
      "recover interrupted workstation apply",
    );
    expect(recovered.data).toMatchObject({
      revision: revisionTwo,
      outcome: { outcome: "Converged", run: recoveryRun },
    });
    expect(readFileSync(resolve(interruptedRoot, "managed.txt"), "utf8"))
      .toBe("version two\n");
    const convergedAgain = requireSuccess(
      invoke(workstationHome, ["sync", "--apply", "--no-input", "--json"]),
      "converge workstation after recovery",
    );
    expect(convergedAgain.data.outcome).toMatchObject({
      outcome: "Converged",
    });
  }, 360_000);
});
