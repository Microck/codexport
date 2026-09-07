import {
  createPrivateKey,
  sign,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  join,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import type { AgentResolutionInput } from "../../src/agent/agent-resolution.types.ts";
import {
  BlobId,
  GroupName,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
  SourceSignature,
} from "../../src/domain/brand.ts";
import type {
  MachineProfile,
  ProfileRevision,
  PublishedResource,
  ResourceSpecInput,
} from "../../src/domain/profile.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import {
  enrollFollower,
  getRevisionMetadata,
} from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type { SourceServerHandle } from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import type {
  MachinePlatform,
  RenderedSchedulerJob,
  SchedulerBackend,
  SchedulerInspection,
  SchedulerSnapshot,
} from "../../src/machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import {
  canonicalJson,
  digestOf,
  directoryVerificationDigest,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { revisionSigningPayload } from "../../src/profile/publication.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import {
  serializeConfigDocument,
  setConfigPath,
  type ConfigDocument,
} from "../../src/synchronization/config-codec.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import {
  recoverFollower,
  synchronizeFollower,
} from "../../src/synchronization/follower-orchestration.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { parseTextComposition } from "../../src/domain/text-composition.ts";

const decode = Schema.decodeUnknownSync;
const roots: Array<string> = [];
const servers: Array<SourceServerHandle> = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const hostPlatform = (): MachinePlatform => {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      throw new Error(`unsupported acceptance host ${process.platform}`);
  }
};

const acceptancePlatform = (): MachinePlatform => {
  const platform = hostPlatform();
  const requested = process.env.CANONFIG_ACCEPTANCE_PLATFORM;
  if (requested !== undefined && requested !== platform) {
    throw new Error(
      `acceptance platform ${requested} does not match native host ${platform}`,
    );
  }
  return platform;
};

const asJson = <Value>(value: Value) =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

class RecordingScheduler implements SchedulerBackend {
  definition: RenderedSchedulerJob | undefined;
  installs = 0;

  readonly inspect = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerInspection> =>
    Effect.succeed({
      installed: this.definition !== undefined,
      enabled: this.definition !== undefined,
      matches: this.definition?.service === expected.service
        && this.definition.schedule === expected.schedule,
    });

  readonly snapshot = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerSnapshot> =>
    Effect.succeed(this.definition === undefined
      ? {
        state: "absent" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
      }
      : {
        state: "present" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
        enabled: true,
        servicePresent: true,
        schedulePresent: true,
        service: this.definition.service,
        schedule: this.definition.schedule,
      });

  readonly install = (
    definition: RenderedSchedulerJob,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = definition;
      this.installs += 1;
    });

  readonly remove = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = undefined;
    });

  readonly restore = (
    expected: RenderedSchedulerJob,
    snapshot: SchedulerSnapshot,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (snapshot.state === "absent") {
        this.definition = undefined;
        return;
      }
      this.definition = {
        ...expected,
        service: snapshot.service ?? "",
        schedule: snapshot.schedule ?? "",
      };
    });
}

interface PlatformFixture {
  readonly platform: MachinePlatform;
  readonly home: string;
  readonly bin: string;
  readonly credentials: string;
  readonly layer: ReturnType<typeof linuxMachineStateLayer>;
}

const machineFixture = (
  platform: MachinePlatform,
  root: string,
  scheduler?: SchedulerBackend,
): PlatformFixture => {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const credentials = join(root, "credentials");
  mkdirSync(bin, { recursive: true });
  const canonfigExecutable = join(
    bin,
    platform === "windows" ? "canonfig.exe" : "canonfig",
  );
  writeFileSync(canonfigExecutable, "");
  if (platform !== "windows") chmodSync(canonfigExecutable, 0o755);
  const path = [bin, dirname(process.execPath)].join(
    platform === "windows" ? ";" : delimiter,
  );
  if (platform === "linux") {
    return {
      platform,
      home,
      bin,
      credentials,
      layer: linuxMachineStateLayer({
        credentialPolicy: { kind: "local-file", path: credentials },
        environment: [
          { name: "HOME", value: home },
          { name: "PATH", value: path },
        ],
        schedulerBackend: scheduler,
      }),
    };
  }
  if (platform === "macos") {
    return {
      platform,
      home,
      bin,
      credentials,
      layer: macosMachineStateLayer({
        credentialPolicy: { kind: "local-file", path: credentials },
        environment: [
          { name: "HOME", value: home },
          { name: "PATH", value: path },
        ],
        schedulerBackend: scheduler,
      }),
    };
  }
  return {
    platform,
    home,
    bin,
    credentials,
    layer: windowsMachineStateLayer({
      credentialPolicy: { kind: "local-file", path: credentials },
      environment: [
        { name: "USERPROFILE", value: home },
        { name: "APPDATA", value: join(home, "AppData", "Roaming") },
        { name: "LOCALAPPDATA", value: join(home, "AppData", "Local") },
        { name: "PATH", value: path },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
        { name: "SystemRoot", value: process.env.SystemRoot ?? "C:\\Windows" },
      ],
      schedulerBackend: scheduler,
    }),
  };
};

const declaredDigest = (spec: ResourceSpecInput): string => {
  const compareText = (left: string, right: string): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  };
  switch (spec.kind) {
    case "file":
      return sha256Hex(spec.symlinkTo ?? spec.content);
    case "directory":
    case "skill":
      return directoryVerificationDigest(
        spec.files.map((file) => ({
          path: file.path,
          digest: sha256Hex(file.symlinkTo ?? file.content),
          executable: file.executable,
        })),
      );
    case "config": {
      const document: ConfigDocument = {};
      for (const entry of [...spec.keys].sort((left, right) =>
        compareText(left.path, right.path)
      )) {
        setConfigPath(document, entry.path, entry.value);
      }
      return sha256Hex(serializeConfigDocument(spec.format, document));
    }
    case "tool":
    case "credential":
      return sha256Hex(spec.kind);
  }
};

const resource = (
  id: string,
  kind: PublishedResource["kind"],
  policy: PublishedResource["policy"],
  target: string,
  spec: ResourceSpecInput,
  groups?: ReadonlyArray<typeof GroupName.Type>,
): MachineProfile["resources"][number] => ({
  id: decode(ResourceId)(id),
  kind,
  policy,
  target,
  groups,
  dependsOn: [],
  spec,
  verify: kind === "tool"
    ? { method: "executable-present", executable: target }
    : kind === "credential"
    ? { method: "credential-present", reference: spec.kind === "credential" ? spec.reference : target }
    : { method: "digest", digest: declaredDigest(spec) },
});

const latestPlan = (
  databasePath: string,
): {
  readonly actions: ReadonlyArray<{ readonly kind: string }>;
} => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = decode(Schema.Struct({ plan_json: Schema.String }))(
    database.prepare(`
    SELECT plan_json
    FROM synchronization_runs
    ORDER BY rowid DESC
    LIMIT 1
  `).get(),
  );
  database.close();
  return JSON.parse(row.plan_json);
};

describe(`cross-platform acceptance (${acceptancePlatform()})`, () => {
  it("converges one authenticated revision with deterministic cross-platform evidence", async () => {
    const platform = acceptancePlatform();
    const root = mkdtempSync(join(tmpdir(), `canonfig-acceptance-${platform}-`));
    roots.push(root);
    const scheduler = new RecordingScheduler();
    const sourceMachine = machineFixture(platform, join(root, "source"));
    const followerMachine = machineFixture(
      platform,
      join(root, "follower"),
      scheduler,
    );
    const sourceDatabase = join(root, "source.sqlite");
    const followerDatabase = join(root, "follower.sqlite");
    const sourceLayer = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(sourceDatabase)),
      Layer.provideMerge(sourceMachine.layer),
    );
    const sourceRuntime = ManagedRuntime.make(sourceLayer);
    runtimes.push(sourceRuntime);

    const localCredential = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.storeCredential({
          name: "acceptance-local-credential",
          value: Redacted.make("acceptance-local-value"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    const managedFile = join(followerMachine.home, "managed.txt");
    const instructionsFile = join(followerMachine.home, "AGENTS.md");
    const localInstructions = "Local instructions\r\n東京\n";
    mkdirSync(followerMachine.home, { recursive: true });
    await writeFile(instructionsFile, localInstructions);
    const configFile = join(followerMachine.home, "settings.json");
    const skillRoot = join(followerMachine.home, "skills", "acceptance");
    const scheduleFile = join(followerMachine.home, "schedule.json");
    const hiddenFile = join(followerMachine.home, "hidden.txt");
    const skillContent = "# Acceptance skill\n";
    const platformRecipes = [
      {
        platform: "linux" as const,
        method: "apt",
        package: "canonfig-acceptance",
        version: "1.0.0",
      },
      {
        platform: "macos" as const,
        method: "brew",
        package: "canonfig-acceptance",
        version: "1.0.0",
      },
      {
        platform: "windows" as const,
        method: "winget",
        package: "Canonfig.Acceptance",
        version: "1.0.0",
      },
    ];
    const profile: MachineProfile = {
      id: decode(ProfileId)("acceptance-profile"),
      version: 2,
      name: "Cross-platform acceptance profile",
      groups: [
        { name: decode(GroupName)("acceptance") },
        { name: decode(GroupName)("excluded") },
      ],
      resources: [
        resource(
          "a-file",
          "file",
          "replace",
          managedFile,
          { kind: "file", content: "canonical acceptance\n", executable: false },
        ),
        resource(
          "b-config",
          "config",
          "merge",
          configFile,
          {
            kind: "config",
            format: "json",
            keys: [
              { path: "theme", value: "dark" },
              { path: "telemetry", value: false },
            ],
          },
        ),
        resource(
          "b-instructions",
          "file",
          "append-local",
          instructionsFile,
          { kind: "file", content: "Source instructions\n", executable: false },
        ),
        resource(
          "c-skill",
          "skill",
          "replace-if-unmodified",
          skillRoot,
          {
            kind: "skill",
            name: "acceptance",
            files: [{ path: "SKILL.md", content: skillContent, executable: false }],
          },
        ),
        resource(
          "d-tool",
          "tool",
          "ensure",
          "node",
          {
            kind: "tool",
            toolId: "node",
            recipes: platformRecipes,
            login: { required: false },
          },
        ),
        resource(
          "e-login-tool",
          "tool",
          "ensure",
          "acceptance-login",
          {
            kind: "tool",
            toolId: "acceptance-login",
            recipes: platformRecipes,
            login: {
              required: true,
              howTo: "Run acceptance-login auth, then rerun synchronization.",
            },
          },
        ),
        resource(
          "f-credential",
          "credential",
          "require-local",
          String(localCredential),
          { kind: "credential", reference: String(localCredential) },
        ),
        resource(
          "y-hidden",
          "file",
          "replace",
          hiddenFile,
          { kind: "file", content: "must stay unauthorized\n", executable: false },
          [decode(GroupName)("excluded")],
        ),
        resource(
          "z-agent",
          "tool",
          "ensure",
          "agent-installed-tool",
          {
            kind: "tool",
            toolId: "agent-installed-tool",
            recipes: [],
            login: { required: false },
            // A tool an agent may install says so, and says where. Without
            // this the planner refuses to invent bounds and reports a human
            // action instead of dispatching a task nothing can satisfy.
            //
            // The path is inside the harness's own allowed root so the two
            // agree and the bounded task keeps it. A path outside that root
            // would be filtered away, which is what an empty allowedPaths
            // means and why asserting one proves nothing.
            agentInstall: {
              paths: [join(followerMachine.home, ".local", "bin", "agent-installed-tool")],
              origins: ["https://packages.example.test"],
            },
          },
        ),
      ],
      scheduleDefault: {
        type: "daily",
        at: "00:00",
        timezone: "local",
      },
    };

    const revision = await sourceRuntime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const machine = yield* MachineState;
      const repository = yield* StateRepository;
      const source = yield* enrollment.initializeSource();
      const privateKey = createPrivateKey(Redacted.value(
        yield* machine.loadCredential({ reference: source.signingKeyReference }),
      ));
      const canonicalBytes = canonicalJson(asJson(profile));
      const digest = sha256Hex(canonicalBytes);
      const resources = profile.resources.map((entry): PublishedResource => {
        const base = {
          id: decode(ResourceId)(entry.id),
          kind: entry.kind,
          policy: entry.policy ?? "replace",
          target: entry.target,
          dependsOn: [],
          blobs: [decode(BlobId)(digestOf(asJson(entry.spec)))],
        };
        return entry.groups === undefined ? base : { ...base, groups: entry.groups };
      });
      const id = decode(ProfileRevisionId)(`${profile.id}:${digest}`);
      const unsigned = {
        id,
        profileId: profile.id,
        sequence: 1,
        canonicalBytes,
        digest,
        publishedAt: "2026-08-16T00:00:00Z",
        resources,
        groups: profile.groups,
        signingKeyId: source.source.keyId,
      };
      const published: ProfileRevision = {
        id,
        profileId: profile.id,
        sequence: 1,
        canonicalBytes,
        digest,
        signature: decode(SourceSignature)(
          `ed25519:${
            sign(
              null,
              Buffer.from(revisionSigningPayload(unsigned)),
              privateKey,
            ).toString("base64url")
          }`,
        ),
        publishedAt: unsigned.publishedAt,
        resources,
        groups: profile.groups,
      };
      yield* repository.publishRevision({ revision: published });
      return published;
    }));

    const server = await sourceRuntime.runPromise(startSourceServer());
    servers.push(server);
    const invitation = await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.createInvitation({
          endpoint: server.endpoint,
          expiresInMilliseconds: 60_000,
          groups: [decode(GroupName)("acceptance")],
        })
      ),
    );
    const enrollment = await Effect.runPromise(
      enrollFollower({
        invitation,
        followerName: `${platform} acceptance follower`,
      }).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(enrollment.source.publicKeyFingerprint).toBe(
      invitation.sourceFingerprint,
    );
    expect(enrollment.tlsFingerprint).toBe(invitation.tlsFingerprint);

    const follower = {
      ...enrollment.follower,
      credentialReference: enrollment.credentialReference,
    };
    const followerRepository = stateRepositoryLayer(followerDatabase);
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrollment.source,
          configuration: decode(FollowerSynchronizationConfiguration)({
            schemaVersion: 1,
            follower,
            selectedProfile: profile.id,
            source: {
              endpoint: server.endpoint,
              tlsFingerprint: enrollment.tlsFingerprint,
              signingFingerprint: enrollment.source.publicKeyFingerprint,
            },
            credentialReference: enrollment.credentialReference,
            cacheDirectory: join(root, "follower-cache"),
            stateLocation: followerDatabase,
            agentPolicy: "agent-apply",
            agentHarness: {
              kind: "codex",
              executable: process.execPath,
              maximumInputBytes: 16_384,
              allowedPaths: [followerMachine.home],
              allowedExecutables: [],
              // The follower grants the origin the profile asks for. Both
              // sides have to agree: `agentInstall` says what would be
              // acceptable, the harness says what is actually permitted.
              allowedOrigins: ["https://packages.example.test"],
              allowedCapabilities: [],
            },
            scheduledInvocation: {
              ...defaultScheduledInvocation,
              timeoutMilliseconds: 10_000,
            },
            updatedAt: "2026-08-16T00:00:01Z",
          }),
        })
      ).pipe(Effect.provide(followerRepository)),
    );

    const agentInputs: Array<AgentResolutionInput> = [];
    const agent = AgentResolution.of({
      resolve: (input) =>
        Effect.sync(() => {
          agentInputs.push(input);
          return {
            outcome: "applied" as const,
            task: input.task,
            proposal: { summary: "Accepted bounded acceptance resolution", actions: [] },
            harness: {
              executable: process.execPath,
              arguments: [],
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
            },
            executions: [],
            verification: {
              command: input.task.verification.command,
              exitCode: 0,
              stdout: "verified",
              stderr: "",
              matched: true,
            },
          };
        }),
      proposeProfileChange: () => Effect.die("unused in acceptance"),
    });
    const synchronization = SynchronizationLive.pipe(
      Layer.provide(Layer.merge(followerRepository, followerMachine.layer)),
    );
    const schedules = scheduleManagerLayer.pipe(
      Layer.provide(followerMachine.layer),
    );
    const application = Layer.mergeAll(
      followerRepository,
      followerMachine.layer,
      schedules,
      synchronization,
      Layer.succeed(AgentResolution, agent),
    );
    const transport = {
      endpoint: server.endpoint,
      tlsFingerprint: enrollment.tlsFingerprint,
      credentialReference: enrollment.credentialReference,
      sourceFingerprint: enrollment.source.publicKeyFingerprint,
      revisionId: revision.id,
    };
    const metadata = await Effect.runPromise(
      getRevisionMetadata(transport).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(metadata.id).toBe(revision.id);
    expect(metadata.resources.map((entry) => entry.id)).not.toContain("y-hidden");

    const initial = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    if (initial.plan === undefined) {
      throw new Error("acceptance planning did not return a synchronization plan");
    }
    expect(initial.revision).toBe(revision.id);
    expect(initial.downloadedBlobs).toBe(metadata.resources.length);
    expect(initial.reusedBlobs).toBe(0);
    expect(initial.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "e-login-tool",
        detail: expect.objectContaining({
          kind: "install-tool",
          method: platform === "linux"
            ? "apt"
            : platform === "macos"
            ? "brew"
            : "winget",
        }),
      }),
      expect.objectContaining({
        resource: "e-login-tool",
        detail: expect.objectContaining({
          kind: "human-action",
          instructions: "Run acceptance-login auth, then rerun synchronization.",
        }),
      }),
    ]));
    expect(initial.agentResolutions).toHaveLength(1);
    expect(agentInputs[0]?.scheduled).toBe(false);
    expect(agentInputs[0]?.task).toMatchObject({
      // The declared install path survived the harness bounds, which is what
      // makes this task capable of installing anything at all.
      allowedPaths: [join(followerMachine.home, ".local", "bin", "agent-installed-tool")],
      allowedExecutables: [],
      allowedOrigins: ["https://packages.example.test"],
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
    });

    const loginExecutable = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.normalizePath({
          path: platform === "windows"
            ? join(followerMachine.bin, "acceptance-login.exe")
            : join(followerMachine.bin, "acceptance-login"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    const agentExecutable = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.normalizePath({
          path: platform === "windows"
            ? join(followerMachine.bin, "agent-installed-tool.exe")
            : join(followerMachine.bin, "agent-installed-tool"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    await writeFile(loginExecutable.absolute, "");
    await writeFile(agentExecutable.absolute, "");
    if (platform !== "windows") {
      chmodSync(loginExecutable.absolute, 0o755);
      chmodSync(agentExecutable.absolute, 0o755);
    }
    {
      const first = await Effect.runPromise(
        synchronizeFollower(followerDatabase, "apply").pipe(
          Effect.provide(application),
        ),
      );
      if (first.outcome === undefined) {
        throw new Error("acceptance apply did not return an outcome");
      }
      expect(first.outcome.outcome, JSON.stringify(first.outcome)).toBe(
        "Converged",
      );
      expect(first).toMatchObject({
        revision: revision.id,
        downloadedBlobs: 0,
        reusedBlobs: metadata.resources.length,
        outcome: { outcome: "Converged" },
      });
    }
    expect(await readFile(managedFile, "utf8")).toBe("canonical acceptance\n");
    expect(parseTextComposition(await readFile(instructionsFile))).toEqual({
      kind: "managed",
      source: "Source instructions\n",
      local: localInstructions,
    });
    const addedInstructions = "More local instructions\r\n";
    await writeFile(instructionsFile, Buffer.concat([
      await readFile(instructionsFile),
      Buffer.from(addedInstructions),
    ]));
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      theme: "dark",
      telemetry: false,
    });
    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toBe(skillContent);
    await expect(readFile(hiddenFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(second).toMatchObject({
      downloadedBlobs: 0,
      reusedBlobs: metadata.resources.length,
      outcome: { outcome: "Converged" },
    });
    expect(server.blobRequests()).toBe(metadata.resources.length);
    expect(parseTextComposition(await readFile(instructionsFile))).toEqual({
      kind: "managed",
      source: "Source instructions\n",
      local: localInstructions + addedInstructions,
    });
    expect(latestPlan(followerDatabase).actions.filter(
      (action) => action.kind !== "no-op",
    )).toEqual([]);

    await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.removeCredential(localCredential)
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    const human = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(human.outcome).toMatchObject({
      outcome: "HumanActionRequired",
      actions: [
        expect.objectContaining({
          resource: "f-credential",
          reason: expect.stringContaining("unavailable"),
        }),
      ],
    });
    const restoredCredential = await Effect.runPromise(
      Effect.flatMap(MachineState, (machine) =>
        machine.storeCredential({
          name: "acceptance-local-credential",
          value: Redacted.make("acceptance-local-value"),
        })
      ).pipe(Effect.provide(followerMachine.layer)),
    );
    expect(restoredCredential).toBe(localCredential);

    await writeFile(join(skillRoot, "SKILL.md"), "# locally modified\n");
    const drifted = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(drifted.outcome).toMatchObject({
      outcome: "FollowerDrift",
      conflicts: [
        expect.objectContaining({
          resource: "c-skill",
          target: skillRoot,
        }),
      ],
    });
    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toBe(
      "# locally modified\n",
    );

    const scheduleLayer = scheduleManagerLayer.pipe(
      Layer.provide(followerMachine.layer),
    );
    const installedSchedule = await Effect.runPromise(
      Effect.flatMap(ScheduleManager, (manager) =>
        manager.install({ executable: process.execPath })
      ).pipe(Effect.provide(scheduleLayer)),
    );
    // The converged apply already reconciled the inherited profile default, so
    // installing here updates that job rather than creating the first one. The
    // difference from before is where the reconciliation happens: after the
    // run, not as a planned action that could roll the run back.
    expect(installedSchedule.change).toBe("updated");
    expect(installedSchedule.status.platform).toBe(platform);
    expect(installedSchedule.status.definition.mechanism).toBe(
      platform === "linux"
        ? "systemd-user-timer"
        : platform === "macos"
        ? "launchd-user-agent"
        : "task-scheduler",
    );
    expect(scheduler.installs).toBe(2);
    const unchangedSchedule = await Effect.runPromise(
      Effect.flatMap(ScheduleManager, (manager) =>
        manager.install({ executable: process.execPath })
      ).pipe(Effect.provide(scheduleLayer)),
    );
    expect(unchangedSchedule.change).toBe("unchanged");
    expect(scheduler.installs).toBe(2);

    await writeFile(managedFile, "interrupted local state\n");
    const recoveryPlan = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    if (recoveryPlan.plan === undefined) {
      throw new Error("acceptance recovery planning did not return a plan");
    }
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.startRun({
          id: decode(RunId)(`acceptance-recovery-${platform}`),
          follower: follower.id,
          revision: recoveryPlan.plan.revision,
          plan: recoveryPlan.plan,
          startedAt: "2026-08-16T00:10:00Z",
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const interruptedDatabase = new DatabaseSync(followerDatabase, {
      readOnly: true,
    });
    const interrupted = decode(Schema.Struct({ status: Schema.String }))(
      interruptedDatabase.prepare(`
        SELECT status
        FROM synchronization_runs
        WHERE id = ?
      `).get(`acceptance-recovery-${platform}`),
    );
    interruptedDatabase.close();
    expect(interrupted.status).toBe("applying");

    const recovered = await Effect.runPromise(
      recoverFollower(followerDatabase).pipe(Effect.provide(application)),
    );
    expect(recovered).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: metadata.resources.length,
      outcome: {
        outcome: "FollowerDrift",
        run: `acceptance-recovery-${platform}`,
      },
    });
    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toBe(
      "# locally modified\n",
    );
    expect(await readFile(managedFile, "utf8")).toBe("canonical acceptance\n");
  });
});
