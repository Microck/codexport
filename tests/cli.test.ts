import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  evaluateCli,
  runCli,
  type CliIo,
} from "../src/cli/cli.ts";
import {
  CliExitCode,
  type CliFailureCategory,
} from "../src/cli/exit-codes.ts";
import {
  FollowerCommands,
  type FollowerCommandsService,
} from "../src/cli/follower-commands.ts";
import {
  renderCliResult,
} from "../src/cli/render.ts";
import {
  CliCommandFailure,
  SourceCommands,
  type CliPayload,
  type SourceCommandsService,
} from "../src/cli/source-commands.ts";

interface Invocation {
  readonly route: string;
  readonly input?: CliPayload | undefined;
}

const invitation = Buffer.from(JSON.stringify({
  code: "invitation-code",
  nonce: "invitation-nonce",
  endpoint: "https://127.0.0.1:17342",
  sourceFingerprint: "source-fingerprint",
  tlsFingerprint: "tls-fingerprint",
  groups: ["developers"],
  expiresAt: "2026-08-16T00:00:00.000Z",
})).toString("base64url");

const recordingLayers = (
  invocations: Array<Invocation>,
  failure?: CliFailureCategory,
) => {
  const invoke = (
    route: string,
    input?: CliPayload,
  ): Effect.Effect<CliPayload, CliCommandFailure> => {
    invocations.push(input === undefined ? { route } : { route, input });
    return failure === undefined
      ? Effect.succeed({ route })
      : Effect.fail(new CliCommandFailure({
        category: failure,
        message: `${failure} failure`,
        details: { credential: "must-not-leak" },
      }));
  };
  const source: SourceCommandsService = {
    initialize: () => invoke("source.init"),
    scan: (input) => invoke("source.scan", input),
    publish: (input) => invoke("source.publish", input),
    serve: (input) => invoke("source.serve", input),
    invite: (input) => invoke("source.invite", input),
    revoke: (input) => invoke("source.revoke", input),
    listProfiles: () => invoke("profile.list"),
    inspectProfile: (input) => invoke("profile.show", input),
  };
  const follower: FollowerCommandsService = {
    enroll: (input) => invoke("follower.enroll", input),
    synchronize: (input) => invoke("sync", input),
    recover: (input) => invoke("recover", input),
    abandon: () => invoke("abandon", {}),
    status: (input) => invoke("status", input),
    setLocalOverlay: (input) => invoke("overlay.set", input),
    listLocalOverlays: () => invoke("overlay.list"),
    removeLocalOverlay: (input) => invoke("overlay.remove", input),
    setAgentPolicy: (input) => invoke("agent.policy.set", input),
    getAgentPolicy: () => invoke("agent.policy.get"),
    setAgentHarness: (input) => invoke("agent.harness.set", input),
    getAgentHarness: () => invoke("agent.harness.get"),
    selectProfile: (input) => invoke("profile.select", input),
    setSchedule: (input) => invoke("schedule.set", input),
    scheduleStatus: () => invoke("schedule.status"),
    removeSchedule: () => invoke("schedule.remove"),
    doctor: () => invoke("doctor"),
  };
  return Layer.merge(
    Layer.succeed(SourceCommands, SourceCommands.of(source)),
    Layer.succeed(FollowerCommands, FollowerCommands.of(follower)),
  );
};

const execute = async (
  arguments_: ReadonlyArray<string>,
  failure?: CliFailureCategory,
) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const exitCodes: Array<number> = [];
  const invocations: Array<Invocation> = [];
  const io: CliIo = {
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };
  await Effect.runPromise(
    runCli(arguments_, io).pipe(
      Effect.provide(recordingLayers(invocations, failure)),
    ),
  );
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode: exitCodes.at(-1),
    invocations,
  };
};

describe("typed CLI command boundary", () => {
  it.each([
    [["source", "init"], "source.init"],
    [["source", "scan", "--file", "AGENTS.md"], "source.scan"],
    [[
      "source",
      "publish",
      "--proposal",
      "proposal.json",
      "--profile",
      "workstation",
      "--name",
      "Workstation",
      "--reviewer",
      "operator",
    ], "source.publish"],
    [[
      "source",
      "publish",
      "--profile-file",
      "profile.jsonc",
      "--reviewer",
      "operator",
    ], "source.publish"],
    [["source", "serve"], "source.serve"],
    [[
      "source",
      "invite",
      "--endpoint",
      "https://127.0.0.1:17342",
      "--group",
      "developers",
    ], "source.invite"],
    [["source", "revoke", "follower-one"], "source.revoke"],
    [
      // --profile is required: the help text always showed it as required and
      // the runtime always refused without it, but the parser used to accept
      // its absence and hint at a usage line that omitted it.
      ["follower", "enroll", invitation, "--name", "workstation", "--profile", "base"],
      "follower.enroll",
    ],
    [["sync", "--plan"], "sync"],
    [["sync", "--apply"], "sync"],
    [["recover"], "recover"],
    [["abandon"], "abandon"],
    [["status", "--follower", "follower-one"], "status"],
    [["overlay", "list"], "overlay.list"],
    [[
      "overlay",
      "set",
      "config-one",
      "--target",
      "/home/user/config.json",
      "--key",
      "local.theme",
    ], "overlay.set"],
    [["overlay", "remove", "config-one"], "overlay.remove"],
    [["doctor"], "doctor"],
    [["profile", "list"], "profile.list"],
    [["profile", "show", "revision-one"], "profile.show"],
    [["profile", "select", "profile-one"], "profile.select"],
    [["agent", "policy"], "agent.policy.get"],
    [["agent", "policy", "agent-propose"], "agent.policy.set"],
    [["agent", "harness"], "agent.harness.get"],
    [[
      "agent",
      "harness",
      "codex",
      "--executable",
      "/opt/codex",
      "--allow-path",
      "/tmp/canonfig",
      "--allow-leaf-executable",
      "npm",
      "--allow-origin",
      "https://registry.npmjs.org",
    ], "agent.harness.set"],
    [["schedule", "set", "daily@00:00"], "schedule.set"],
    [["schedule", "set", "weekly:Mon@12:30"], "schedule.set"],
    [["schedule", "status"], "schedule.status"],
    [["schedule", "remove"], "schedule.remove"],
  ] as const)("routes %j through %s", async (arguments_, expectedRoute) => {
    const result = await execute([...arguments_, "--json"]);
    expect(result.exitCode).toBe(CliExitCode.success);
    expect(result.stderr).toBe("");
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.route).toBe(expectedRoute);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "canonfig.cli/v1",
      status: "success",
      exitCode: 0,
    });
  });

  it("decodes schedule, identifiers, and enrollment invitation before dispatch", async () => {
    const schedule = await execute([
      "schedule",
      "set",
      "weekly:Fri,Mon,Fri@23:15",
      "--timezone",
      "Europe/Paris",
      "--executable",
      "/opt/canonfig",
    ]);
    expect(schedule.invocations[0]?.input).toEqual({
      schedule: {
        kind: "weekly",
        weekdays: ["Mon", "Fri"],
        localTime: "23:15",
        timezone: "Europe/Paris",
      },
      executable: "/opt/canonfig",
    });

    const enrollment = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
    ]);
    expect(enrollment.invocations[0]?.input).toMatchObject({
      followerName: "laptop",
      invitation: {
        code: "invitation-code",
        groups: ["developers"],
      },
    });

    const harness = await execute([
      "agent",
      "harness",
      "claude",
      "--executable",
      "/opt/claude",
      "--allow-path",
      "/home/operator",
      "--allow-leaf-executable",
      "npm",
      "--allow-origin",
      "https://registry.npmjs.org",
      "--allow-capability",
      "restart",
      "--maximum-input-bytes",
      "4096",
    ]);
    expect(harness.invocations[0]?.input).toEqual({
      kind: "claude",
      executable: "/opt/claude",
      maximumInputBytes: 4096,
      allowedPaths: ["/home/operator"],
      allowedExecutables: ["npm"],
      executableAuthorizations: [{ executable: "npm", behavior: "leaf" }],
      allowedOrigins: ["https://registry.npmjs.org"],
      allowedCapabilities: ["restart"],
    });
  });

  it("carries authored profile input separately from discovery review input", async () => {
    const result = await execute([
      "source",
      "publish",
      "--proposal",
      "proposal.json",
      "--profile-file",
      "profile.jsonc",
      "--reviewer",
      "operator",
    ]);
    expect(result.invocations[0]?.input).toEqual({
      proposalPath: "proposal.json",
      profilePath: "profile.jsonc",
      reviewer: "operator",
    });
  });

  it("emits a CLI envelope for a usage error when --json is requested", async () => {
    // Every post-parse failure was already an envelope; parse failures printed
    // two human lines whatever the output mode, so a program driving Canonfig
    // with --json got unparseable text for the whole class.
    const result = await execute(["sync", "--plan", "--apply", "--json"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "canonfig.cli/v1",
      command: "usage",
      status: "error",
      exitCode: CliExitCode.usageOrConfiguration,
      message: "--plan and --apply are mutually exclusive",
    });
  });

  it("keeps the help hint out of the envelope but in human output", async () => {
    const human = await execute(["sync", "--plan", "--apply"]);
    expect(human.stderr).toBe(
      "--plan and --apply are mutually exclusive\nRun 'canonfig --help' for usage.\n",
    );
  });

  it("reports a bare option list as a missing command", async () => {
    // `canonfig --json` used to produce the empty message `Unknown argument: `.
    const result = await execute(["--json"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: "usage",
      status: "error",
      message: "Missing command",
    });
  });

  it("blames a stray argument rather than the command that received it", async () => {
    // These reported `Unknown schedule command: status`, naming the action as
    // unknown when the problem was the extra argument.
    for (
      const arguments_ of [
        ["schedule", "status", "extra"],
        ["schedule", "remove", "extra"],
      ]
    ) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.stderr).toContain(
        `canonfig schedule ${arguments_[1]} accepts no arguments`,
      );
      expect(result.stderr).not.toContain("Unknown schedule command");
    }
  });

  it("reports an unknown option as an unknown option", async () => {
    for (
      const arguments_ of [
        ["schedule", "status", "--executable", "/x"],
        ["agent", "policy", "--no-input"],
      ]
    ) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.stderr).toContain("Unknown option:");
    }
  });

  it("routes --replace through to enrollment", async () => {
    const result = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
      "--replace",
      "--json",
    ]);
    expect(result.exitCode).toBe(CliExitCode.success);
    expect(result.invocations[0]?.input).toMatchObject({
      followerName: "laptop",
      replace: true,
    });
  });

  it("defaults --replace to false", async () => {
    const result = await execute([
      "follower",
      "enroll",
      invitation,
      "--name",
      "laptop",
      "--profile",
      "workstation",
      "--json",
    ]);
    expect(result.invocations[0]?.input).toMatchObject({ replace: false });
  });

  it("requires the --profile the enroll usage line promises", async () => {
    const result = await execute(["follower", "enroll", invitation, "--name", "laptop"]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.stderr).toContain("Missing required option: --profile");
  });

  it("reports the exit code it set, so source serve can wait only on success", async () => {
    // `source serve` keeps the process alive; main.ts decides that from this
    // result, because runCli turns every failure into an exit code rather than
    // into a failed effect.
    const succeeded = await Effect.runPromise(
      runCli(["source", "serve"], {
        writeStdout: () => {},
        writeStderr: () => {},
        setExitCode: () => {},
      }).pipe(Effect.provide(recordingLayers([]))),
    );
    expect(succeeded).toBe(CliExitCode.success);
    const failed = await Effect.runPromise(
      runCli(["source", "serve"], {
        writeStdout: () => {},
        writeStderr: () => {},
        setExitCode: () => {},
      }).pipe(Effect.provide(recordingLayers([], "transport"))),
    );
    expect(failed).toBe(CliExitCode.transport);
  });

  it("rejects malformed and ambiguous inputs before selecting a service", async () => {
    for (const arguments_ of [
      ["sync", "--plan", "--apply"],
      ["source", "revoke", "not valid"],
      ["follower", "enroll", "not-base64", "--name", "host"],
      ["schedule", "set", "weekly:Funday@99:00"],
      ["source", "invite", "--endpoint", "http://example.test"],
      ["agent", "harness", "unsupported", "--executable", "agent"],
      [
        "agent",
        "harness",
        "codex",
        "--executable",
        "codex",
        "--allow-origin",
        "https://example.test/path",
      ],
      ["legacy-source", "init"],
    ]) {
      const result = await execute(arguments_);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.invocations).toEqual([]);
      expect(result.stderr).toContain("Run 'canonfig --help' for usage.");
    }
  });

  it("carries --no-input to apply and recovery without a prompting seam", async () => {
    const apply = await execute(["sync", "--apply", "--no-input"]);
    expect(apply.invocations).toEqual([{
      route: "sync",
      input: { mode: "apply", noInput: true },
    }]);
    expect(apply.stdout).toBe("");
    const recover = await execute(["recover", "--no-input"]);
    expect(recover.invocations).toEqual([{
      route: "recover",
      input: { noInput: true },
    }]);
  });

  it("rejects classifying a nested-command launcher as bounded at parse time", async () => {
    for (const launcher of ["xargs", "find", "awk", "perl", "make", "npx"]) {
      const result = await execute([
        "agent",
        "harness",
        "codex",
        "--executable",
        "/opt/codex",
        "--allow-path",
        "/home/operator",
        "--allow-leaf-executable",
        launcher,
      ]);
      expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
      expect(result.invocations).toEqual([]);
      expect(result.stderr).toContain("nested commands");
    }
  });

  it("rejects the removed script-interpreter authorization option", async () => {
    const result = await execute([
      "agent",
      "harness",
      "codex",
      "--executable",
      "/opt/codex",
      "--allow-path",
      "/home/operator",
      "--allow-leaf-executable",
      "npm",
      "--allow-script-interpreter",
      "/usr/bin/node",
    ]);
    expect(result.exitCode).toBe(CliExitCode.usageOrConfiguration);
    expect(result.invocations).toEqual([]);
    expect(result.stderr).toContain("Unknown option: --allow-script-interpreter");
  });
});

describe("CLI rendering and exit semantics", () => {
  it("renders stable human and JSON envelopes", async () => {
    const human = await execute(["profile", "list"]);
    expect(human.stdout).toBe(
      "profile.list completed\n{\n  \"route\": \"profile.list\"\n}\n",
    );
    const machine = await execute(["profile", "list", "--json"]);
    expect(machine.stdout).toBe(
      "{\"schema\":\"canonfig.cli/v1\",\"command\":\"profile.list\",\"status\":\"success\",\"exitCode\":0,\"message\":\"profile.list completed\",\"data\":{\"route\":\"profile.list\"}}\n",
    );
  });

  it.each([
    ["usage-or-configuration", 2],
    ["human-action-required", 3],
    ["conflict-or-drift", 4],
    ["authentication-or-revocation", 5],
    ["transport", 6],
    ["verification-or-apply-failure", 7],
    ["internal", 1],
  ] as const)("maps %s failures to exit code %i", async (category, exitCode) => {
    const result = await execute(["doctor", "--json"], category);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`"exitCode":${exitCode}`);
    expect(result.stderr).not.toContain("must-not-leak");
    expect(result.stderr).toContain("[REDACTED]");
  });

  it("recursively redacts secret values while preserving references", () => {
    const rendered = renderCliResult({
      command: "status",
      message: "status completed",
      exitCode: CliExitCode.success,
      data: {
        credential: "raw",
        nested: { password: "raw", credentialReference: "keychain:item" },
      },
    }, "json");
    expect(rendered).not.toContain('"raw"');
    expect(rendered).toContain("keychain:item");
  });

  it("preserves help and version without constructing command layers", () => {
    expect(evaluateCli(["--help"])._tag).toBe("Help");
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "3.1.1",
      exitCode: 0,
    });
  });
});
