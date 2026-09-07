import {
  createPrivateKey,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolutionLive } from "../../src/agent/agent-resolution.layer.ts";
import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import { DeniedAgentCapabilityError } from "../../src/agent/agent-resolution.errors.ts";
import {
  ActionId,
  AgentTaskId,
  BlobId,
  ContentDigest,
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
} from "../../src/domain/profile.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { enrollFollower } from "../../src/enrollment/follower-client.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import type { SourceServerHandle } from "../../src/enrollment/enrollment.types.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import {
  SyncScheduleSchema,
  type SyncSchedule,
} from "../../src/schedule/schedule-manager.types.ts";
import {
  canonicalJson,
  digestOf,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { revisionSigningPayload } from "../../src/profile/publication.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import {
  serializeConfigDocument,
  setConfigPath,
  type ConfigDocument,
} from "../../src/synchronization/config-codec.ts";
import {
  authorizationViewIdentity,
  recoverFollower,
  resolveAgentTasks,
  synchronizeFollower,
} from "../../src/synchronization/follower-orchestration.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { parseTextComposition } from "../../src/domain/text-composition.ts";

const decode = Schema.decodeUnknownSync;
const directories: Array<string> = [];
const servers: Array<SourceServerHandle> = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<Enrollment | MachineState | StateRepository, never>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const machineLayer = (root: string) =>
  linuxMachineStateLayer({
    environment: [
      { name: "HOME", value: join(root, "home") },
      { name: "PATH", value: join(root, "bin") },
    ],
    credentialPolicy: {
      kind: "local-file",
      path: join(root, "credentials"),
    },
  });

const asJson = <Value>(value: Value) =>
  decode(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));

const directoryDigest = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean | undefined;
  }>,
) => decode(ContentDigest)(directoryVerificationDigest(files.map((file) => ({
  path: file.path,
  digest: sha256Hex(file.content),
  executable: file.executable,
}))));

describe("production follower orchestration", () => {
  it("keeps follower text across adoption, local edits, Source replacement, and removal", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-text-orchestration-"));
    directories.push(root);
    const followerRoot = join(root, "follower");
    const target = join(followerRoot, "home", "AGENTS.md");
    const followerDatabase = join(root, "follower.sqlite");
    const sourceLayer = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(join(root, "source.sqlite"))),
      Layer.provideMerge(machineLayer(join(root, "source"))),
    );
    const sourceRuntime = ManagedRuntime.make(sourceLayer);
    runtimes.push(sourceRuntime);
    const source = await sourceRuntime.runPromise(Effect.flatMap(Enrollment, (enrollment) => enrollment.initializeSource()));
    const privateKey = await sourceRuntime.runPromise(Effect.gen(function*() {
      const machine = yield* MachineState;
      return createPrivateKey(Redacted.value(yield* machine.loadCredential({ reference: source.signingKeyReference })));
    }));
    const profileId = decode(ProfileId)("local-instructions");
    const resourceId = decode(ResourceId)("instructions");
    let sequence = 0;
    const publish = async (content?: string) => {
      sequence += 1;
      const profile: MachineProfile = {
        id: profileId, version: 2, name: "Local instructions", groups: [],
        resources: content === undefined ? [] : [{
          id: resourceId, kind: "file", policy: "append-local", target, dependsOn: [],
          spec: { kind: "file", content, executable: false, mode: 0o600 },
          verify: { method: "digest", digest: sha256Hex(content) },
        }],
      };
      const canonicalBytes = canonicalJson(asJson(profile));
      const digest = sha256Hex(canonicalBytes);
      const unsigned = {
        id: decode(ProfileRevisionId)(`${profileId}:${digest}`), profileId, sequence,
        canonicalBytes, digest, publishedAt: `2026-09-07T00:00:${String(sequence).padStart(2, "0")}Z`,
        groups: [], signingKeyId: source.source.keyId,
        resources: profile.resources.map((resource) => ({
          id: decode(ResourceId)(resource.id), kind: resource.kind, policy: resource.policy ?? "replace",
          target, dependsOn: [], blobs: [decode(BlobId)(digestOf(asJson(resource.spec)))],
        })),
      };
      await sourceRuntime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.publishRevision({
        revision: { ...unsigned, signature: decode(SourceSignature)(`ed25519:${sign(null, Buffer.from(revisionSigningPayload(unsigned)), privateKey).toString("base64url")}`) },
      })));
    };
    await publish("Source one\n");
    const server = await sourceRuntime.runPromise(startSourceServer().pipe(Effect.provide(sourceLayer)));
    servers.push(server);
    const invitation = await sourceRuntime.runPromise(Effect.flatMap(Enrollment, (enrollment) => enrollment.createInvitation({
      endpoint: server.endpoint, expiresInMilliseconds: 60_000,
    })));
    const followerMachine = machineLayer(followerRoot);
    const enrolled = await Effect.runPromise(enrollFollower({ invitation, followerName: "Text follower" }).pipe(Effect.provide(followerMachine)));
    const followerRepository = stateRepositoryLayer(followerDatabase);
    await Effect.runPromise(Effect.flatMap(StateRepository, (repository) => repository.saveFollowerSynchronizationConfiguration({
      sourceIdentity: enrolled.source,
      configuration: {
        schemaVersion: 1, follower: { ...enrolled.follower, credentialReference: enrolled.credentialReference },
        selectedProfile: profileId,
        source: { endpoint: server.endpoint, tlsFingerprint: enrolled.tlsFingerprint, signingFingerprint: enrolled.source.publicKeyFingerprint },
        credentialReference: enrolled.credentialReference,
        cacheDirectory: join(root, "cache"), stateLocation: followerDatabase,
        agentPolicy: "deterministic-only", scheduledInvocation: defaultScheduledInvocation, updatedAt: "2026-09-07T00:00:00Z",
      },
    })).pipe(Effect.provide(followerRepository)));
    const application = Layer.mergeAll(followerRepository, followerMachine, AgentResolutionLive,
      SynchronizationLive.pipe(Layer.provide(Layer.merge(followerRepository, followerMachine))));
    const sync = (mode: "plan" | "apply" = "apply") => Effect.runPromise(synchronizeFollower(followerDatabase, mode).pipe(Effect.provide(application)));
    const text = async () => parseTextComposition(await readFile(target));
    await mkdir(join(followerRoot, "home"), { recursive: true });
    const local = "Existing rules\r\n\uFEFF東京\n";
    await writeFile(target, local);
    expect((await sync("plan")).plan.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "write-file" })]));
    expect(await readFile(target, "utf8")).toBe(local);
    expect((await sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(await text()).toEqual({ kind: "managed", source: "Source one\n", local });
    const adopted = await readFile(target, "utf8");
    const added = "New local rule\r\n";
    await writeFile(target, adopted + added);
    const unchanged = await sync();
    expect(unchanged.outcome).toMatchObject({ outcome: "Converged" });
    expect((await sync("plan")).plan.actions.every((action) => action.kind === "no-op")).toBe(true);
    expect(await readFile(target, "utf8")).toBe(adopted + added);
    const applied = await Effect.runPromise(Effect.flatMap(StateRepository, (repository) => repository.loadAppliedResources(enrolled.follower.id)).pipe(Effect.provide(followerRepository)));
    expect(applied).toEqual([expect.objectContaining({ policy: "append-local", digest: sha256Hex("Source one\n") })]);

    await writeFile(target, (adopted + added).replace("Source one", "Local Source edit"));
    expect((await sync()).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(await readFile(target, "utf8")).toContain("Local Source edit");
    await writeFile(target, (adopted + added).replace("canonfig:source:end", "broken:end"));
    expect((await sync()).outcome).toMatchObject({ outcome: "HumanActionRequired" });
    await writeFile(target, adopted + added);

    await publish("Source two\r\n");
    const updatedPlan = await sync("plan");
    expect(updatedPlan.plan.actions).toEqual(expect.arrayContaining([expect.objectContaining({
      detail: expect.objectContaining({ kind: "write-file", previousSourceDigest: sha256Hex("Source one\n") }),
    })]));
    expect((await sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(await text()).toEqual({ kind: "managed", source: "Source two\r\n", local: local + added });
    const beforeRemoval = await readFile(target, "utf8");
    await publish();
    await writeFile(target, beforeRemoval.replace("Source two", "edited Source"));
    expect((await sync()).outcome).toMatchObject({ outcome: "FollowerDrift" });
    expect(await readFile(target, "utf8")).toContain("edited Source");
    await writeFile(target, beforeRemoval);
    expect((await sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(await readFile(target, "utf8")).toBe(local + added);
    expect((await sync("plan")).plan.actions).toEqual([]);

    // A fresh adoption of identical text introduces ownership without a copy.
    await writeFile(target, "Source three");
    await publish("Source three");
    expect((await sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(await text()).toEqual({ kind: "managed", source: "Source three", local: "" });
    await unlink(target);
    expect((await sync()).outcome).toMatchObject({ outcome: "Converged" });
    expect(await text()).toEqual({ kind: "managed", source: "Source three", local: "" });
  });

  it("separates authorization-filtered views of one source revision", () => {
    const first = authorizationViewIdentity({
      id: "revision-shared",
      profileId: "profile-shared",
      metadataDigest: decode(ContentDigest)("a".repeat(64)),
    });
    const second = authorizationViewIdentity({
      id: "revision-shared",
      profileId: "profile-shared",
      metadataDigest: decode(ContentDigest)("b".repeat(64)),
    });

    expect(first.revision).not.toBe(second.revision);
    expect(first.profile).not.toBe(second.profile);
  });

  it("routes emitted agent tasks through configured bounded policy and preserves human fallback", async () => {
    const taskId = decode(AgentTaskId)("agent:tool:0");
    const actionId = decode(ActionId)("action:tool:0:agent-task");
    const resource = decode(ResourceId)("agent-tool");
    const task = {
      id: taskId,
      resource,
      summary: "Resolve agent tool",
      desiredOutcome: "Make agent-tool available",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["/tmp/canonfig-agent"],
      allowedExecutables: ["agent-tool"],
      executableAuthorizations: [{
        executable: "agent-tool",
        behavior: "leaf" as const,
      }],
      allowedOrigins: ["https://packages.example.test"],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 30,
      outputLimitBytes: 4096,
      verification: { command: ["agent-tool", "--version"] },
    };
    const body = {
      revision: "revision-agent",
      follower: "follower-agent",
      requiredBlobs: [],
      actions: [{
        id: actionId,
        resource,
        kind: "agent-task" as const,
        detail: {
          kind: "agent-task" as const,
          taskId,
          summary: task.summary,
        },
        before: [],
      }],
      agentTasks: [task],
    };
    const encoded = canonicalJson(asJson(body));
    const plan = {
      ...body,
      encoded,
      digest: sha256Hex(encoded),
    };
    const baseConfiguration = decode(FollowerSynchronizationConfiguration)({
      schemaVersion: 1,
      follower: {
        id: "follower-agent",
        name: "Agent follower",
        groups: [],
        revoked: false,
        credentialReference: "secure-store://agent-follower",
        enrolledAt: "2026-08-16T00:00:00Z",
      },
      selectedProfile: "profile-agent",
      source: {
        endpoint: "https://127.0.0.1:17342",
        tlsFingerprint: "tls-agent",
        signingFingerprint: "signing-agent",
      },
      credentialReference: "secure-store://agent-follower",
      cacheDirectory: "/tmp/canonfig-agent-cache",
      stateLocation: "/tmp/canonfig-agent-state.sqlite",
      agentPolicy: "agent-apply",
      agentHarness: {
        kind: "codex",
        executable: "/opt/codex",
        maximumInputBytes: 8192,
        allowedPaths: ["/tmp/canonfig-agent"],
        allowedExecutables: ["agent-tool"],
        executableAuthorizations: [{
          executable: "agent-tool",
          behavior: "leaf",
        }],
        allowedOrigins: ["https://packages.example.test"],
        allowedCapabilities: [],
      },
      scheduledInvocation: defaultScheduledInvocation,
      updatedAt: "2026-08-16T00:00:01Z",
    });
    const recordingAgent = AgentResolution.of({
      resolve: (input) => Effect.succeed({
        outcome: "applied" as const,
        task: input.task,
        proposal: { summary: "Install agent tool", actions: [] },
        harness: {
          executable: "/opt/codex",
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
          stdout: "agent-tool 1.0",
          stderr: "",
          matched: true,
        },
      }),
      proposeProfileChange: () => Effect.die("unused"),
    });
    const applied = await Effect.runPromise(
      resolveAgentTasks(baseConfiguration, plan, false).pipe(
        Effect.provideService(AgentResolution, recordingAgent),
      ),
    );
    expect(applied.plan.actions[0]).toMatchObject({
      kind: "no-op",
      detail: { kind: "no-op" },
    });
    expect(applied.agentResolutions).toHaveLength(1);

    const missingHarness = await Effect.runPromise(
      resolveAgentTasks(
        {
          ...baseConfiguration,
          agentHarness: undefined,
        },
        plan,
        true,
      ).pipe(Effect.provideService(AgentResolution, recordingAgent)),
    );
    expect(missingHarness.plan.actions[0]).toMatchObject({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: expect.stringContaining("not configured"),
      },
    });

    // A persisted harness that classifies a nested-command launcher must fail
    // closed at synchronization time, routing the task to Human Action
    // Required instead of trusting the stored classification.
    const launcherClassified = await Effect.runPromise(
      resolveAgentTasks(
        {
          ...baseConfiguration,
          agentHarness: {
            ...baseConfiguration.agentHarness!,
            executableAuthorizations: [{
              executable: "xargs",
              behavior: "leaf",
            }],
          },
        },
        plan,
        true,
      ).pipe(Effect.provideService(AgentResolution, recordingAgent)),
    );
    expect(launcherClassified.plan.actions[0]).toMatchObject({
      kind: "human-action",
      detail: {
        kind: "human-action",
        reason: expect.stringContaining("nested-command launcher"),
      },
    });
    expect(launcherClassified.agentResolutions).toHaveLength(0);

    // A harness that refuses is reported rather than dropped. `sync --plan`
    // used to compute this and discard it, so the agent task showed unchanged
    // with an empty agentResolutions and no reason at all, while the same
    // failure during apply ended the run.
    const refusingAgent = AgentResolution.of({
      resolve: () =>
        Effect.fail(
          new DeniedAgentCapabilityError({
            capability: "path",
            value: "/tmp/canonfig-agent",
          }),
        ),
      proposeProfileChange: () => Effect.die("unused"),
    });
    const refused = await Effect.runPromise(
      resolveAgentTasks(baseConfiguration, plan, false, undefined, true).pipe(
        Effect.provideService(AgentResolution, refusingAgent),
      ),
    );
    expect(refused.agentResolutions).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: expect.stringContaining("could not safely resolve"),
      }),
    ]);
    // A plan still shows the agent task, because a plan describes what would
    // be attempted; the refusal is reported alongside it rather than silently
    // dropped.
    expect(refused.plan.actions[0]).toMatchObject({ kind: "agent-task" });
  });

  it("persists enrollment config, transfers a selected revision, converges, reuses cache, detects drift, and rejects revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-orchestration-"));
    directories.push(root);
    const sourceDatabase = join(root, "source.sqlite");
    const followerDatabase = join(root, "follower.sqlite");
    const sourceMachine = machineLayer(join(root, "source"));
    const followerMachine = machineLayer(join(root, "follower"));
    const sourceLayer = EnrollmentLive.pipe(
      Layer.provideMerge(stateRepositoryLayer(sourceDatabase)),
      Layer.provideMerge(sourceMachine),
    );
    const sourceRuntime = ManagedRuntime.make(sourceLayer);
    runtimes.push(sourceRuntime);
    const target = join(root, "follower", "home", "managed.txt");
    const configTarget = join(root, "follower", "home", "managed.json");
    const directoryTarget = join(root, "follower", "home", "managed-directory");
    const restrictedTarget = join(root, "follower", "home", "alpha-only.txt");
    const profileId = decode(ProfileId)("production-profile");
    const content = "canonical follower content\n";
    const spec = {
      kind: "file" as const,
      content,
      executable: false,
    };
    const configSpec = {
      kind: "config" as const,
      format: "json" as const,
      keys: [{ path: "canonical.value", value: "source" }],
    };
    const managedConfigDocument: ConfigDocument = {};
    setConfigPath(managedConfigDocument, "canonical.value", "source");
    const configDigest = sha256BytesHex(
      new TextEncoder().encode(
        serializeConfigDocument("json", managedConfigDocument),
      ),
    );
    const directorySpec = {
      kind: "directory" as const,
      mode: 0o750,
      directories: [{ path: "empty", mode: 0o710 }],
      files: [
        { path: "kept.txt", content: "kept\n", executable: false, mode: 0o640 },
        { path: "removed.txt", content: "remove later\n", executable: false },
        { path: "東京.txt", content: "unicode path\n", executable: false },
      ],
    };
    let signingKey: ReturnType<typeof createPrivateKey> | undefined;

    const revision = await sourceRuntime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const machine = yield* MachineState;
      const repository = yield* StateRepository;
      const source = yield* enrollment.initializeSource();
      const privateKey = createPrivateKey(Redacted.value(
        yield* machine.loadCredential({
          reference: source.signingKeyReference,
        }),
      ));
      signingKey = privateKey;
      const profile: MachineProfile = {
        id: profileId,
        version: 2,
        name: "Production profile",
        groups: [{ name: "alpha" }],
        resources: [
          {
            id: decode(ResourceId)("managed-file"),
            kind: "file",
            policy: "replace-if-unmodified",
            target,
            dependsOn: [],
            spec,
            verify: {
              method: "digest",
              digest: sha256Hex(content),
            },
          },
          {
            id: decode(ResourceId)("managed-config"),
            kind: "config",
            policy: "merge",
            target: configTarget,
            dependsOn: [],
            spec: configSpec,
            verify: {
              method: "digest",
              digest: configDigest,
            },
          },
          {
            id: decode(ResourceId)("managed-directory"),
            kind: "directory",
            policy: "mirror-owned",
            target: directoryTarget,
            dependsOn: [],
            spec: directorySpec,
            verify: {
              method: "digest",
              digest: directoryDigest(directorySpec.files),
            },
          },
          {
            id: decode(ResourceId)("alpha-only-file"),
            kind: "file",
            policy: "replace",
            target: restrictedTarget,
            groups: ["alpha"],
            dependsOn: [],
            spec: {
              kind: "file",
              content: "alpha-only content\n",
              executable: false,
            },
            verify: {
              method: "digest",
              digest: sha256Hex("alpha-only content\n"),
            },
          },
        ],
        scheduleDefault: {
          type: "daily",
          at: "00:00",
          timezone: "local",
        },
      };
      const canonicalBytes = canonicalJson(asJson(profile));
      const digest = sha256Hex(canonicalBytes);
      const id = decode(ProfileRevisionId)(`${profileId}:${digest}`);
      const resources = profile.resources.map((resource) => {
        const published = {
          id: decode(ResourceId)(resource.id),
          kind: resource.kind,
          policy: resource.policy ?? "replace",
          target: resource.target,
          dependsOn: [],
          blobs: [decode(BlobId)(digestOf(asJson(resource.spec)))],
        };
        return resource.groups === undefined
          ? published
          : { ...published, groups: resource.groups };
      });
      const unsigned = {
        id,
        profileId,
        sequence: 1,
        canonicalBytes,
        digest,
        publishedAt: "2026-08-16T00:00:00Z",
        resources,
        groups: profile.groups,
        signingKeyId: source.source.keyId,
      };
      const signed: ProfileRevision = {
        id,
        profileId,
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
      yield* repository.publishRevision({ revision: signed });
      return signed;
    }));

    const server = await sourceRuntime.runPromise(
      startSourceServer().pipe(Effect.provide(sourceLayer)),
    );
    servers.push(server);
    const invitation = await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.createInvitation({
          endpoint: server.endpoint,
          expiresInMilliseconds: 60_000,
        })
      ),
    );
    const enrolled = await Effect.runPromise(
      enrollFollower({
        invitation,
        followerName: "Production follower",
      }).pipe(Effect.provide(followerMachine)),
    );
    const follower = {
      ...enrolled.follower,
      credentialReference: enrolled.credentialReference,
    };
    const followerRepository = stateRepositoryLayer(followerDatabase);
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrolled.source,
          configuration: {
            schemaVersion: 1,
            follower,
            selectedProfile: profileId,
            source: {
              endpoint: server.endpoint,
              tlsFingerprint: enrolled.tlsFingerprint,
              signingFingerprint: enrolled.source.publicKeyFingerprint,
            },
            credentialReference: enrolled.credentialReference,
            cacheDirectory: join(root, "follower-cache"),
            stateLocation: followerDatabase,
            agentPolicy: "deterministic-only",
            scheduledInvocation: defaultScheduledInvocation,
            updatedAt: "2026-08-16T00:00:01Z",
          },
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const synchronization = SynchronizationLive.pipe(
      Layer.provide(Layer.merge(followerRepository, followerMachine)),
    );
    const profileScheduleCalls: Array<unknown> = [];
    let profileSchedule: SyncSchedule | undefined = {
      kind: "daily",
      localTime: "00:00",
    };
    const profileScheduleManager = ScheduleManager.of({
      install: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      update: (input) => Effect.sync(() => {
        profileScheduleCalls.push(input?.schedule);
        const schedule = input?.schedule ?? {
          kind: "daily" as const,
          localTime: "00:00",
        };
        profileSchedule = schedule;
        return {
          change: "updated" as const,
          status: {
            state: "current" as const,
            platform: "linux" as const,
            schedule,
            definition: {
              platform: "linux" as const,
              mechanism: "systemd-user-timer" as const,
              serviceName: "test",
              service: "",
              schedule: "",
            },
          },
        };
      }),
      status: (input) => Effect.sync(() => {
        const schedule = input?.schedule ?? {
          kind: "daily" as const,
          localTime: "00:00",
        };
        return {
          state: profileSchedule === undefined
            ? "not-installed" as const
            : JSON.stringify(profileSchedule) === JSON.stringify(schedule)
              ? "current" as const
              : "drifted" as const,
          platform: "linux" as const,
          schedule,
          definition: {
            platform: "linux" as const,
            mechanism: "systemd-user-timer" as const,
            serviceName: "test",
            service: "",
            schedule: "",
          },
        };
      }),
      snapshot: () => Effect.sync(() => profileSchedule === undefined
        ? {
          state: "absent" as const,
          platform: "linux" as const,
          mechanism: "systemd-user-timer" as const,
          serviceName: "test",
        }
        : {
          state: "present" as const,
          platform: "linux" as const,
          mechanism: "systemd-user-timer" as const,
          serviceName: "test",
          enabled: true,
          servicePresent: true,
          schedulePresent: true,
          service: "",
          schedule: JSON.stringify(profileSchedule),
        }),
      restore: (_input, snapshot) => Effect.sync(() => {
        profileSchedule = snapshot.state === "absent"
          ? undefined
          : Schema.decodeUnknownSync(SyncScheduleSchema)(
            JSON.parse(snapshot.schedule ?? "{}"),
          );
      }),
      remove: () => Effect.sync(() => {
        profileScheduleCalls.push(undefined);
        profileSchedule = undefined;
        return { change: "removed" as const };
      }),
    });
    const application = Layer.mergeAll(
      followerRepository,
      followerMachine,
      synchronization,
      AgentResolutionLive,
      Layer.succeed(ScheduleManager, profileScheduleManager),
    );

    const planOnly = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    expect(planOnly.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "write-file" }),
    ]));
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    const appliedDuringPlan = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(appliedDuringPlan).toEqual([]);

    const first = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(first).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: 3,
      outcome: { outcome: "Converged" },
    });
    expect(await readFile(target, "utf8")).toBe(content);
    expect(await readFile(join(directoryTarget, "removed.txt"), "utf8")).toBe(
      "remove later\n",
    );
    expect(await readFile(join(directoryTarget, "kept.txt"), "utf8")).toBe("kept\n");

    const second = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(second).toMatchObject({
      downloadedBlobs: 0,
      reusedBlobs: 3,
      outcome: { outcome: "Converged" },
    });
    expect(server.blobRequests()).toBe(3);

    const publicViewRevisions = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.listRevisions()
      ).pipe(Effect.provide(followerRepository)),
    );
    const publicView = publicViewRevisions.find((entry) =>
      entry.id.startsWith(`${revision.id}:view:`)
    );
    expect(publicView).toBeDefined();

    await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.updateFollowerGroups(
          follower.id,
          [decode(GroupName)("alpha")],
        )
      ),
    );
    const alphaViewSync = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(alphaViewSync).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 1,
      reusedBlobs: 3,
      outcome: { outcome: "Converged" },
    });
    expect(await readFile(restrictedTarget, "utf8")).toBe("alpha-only content\n");
    expect(server.blobRequests()).toBe(4);

    const authorizedViewRevisions = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.listRevisions()
      ).pipe(Effect.provide(followerRepository)),
    );
    const viewIds = authorizedViewRevisions
      .map((entry) => entry.id)
      .filter((id) => id.startsWith(`${revision.id}:view:`));
    expect(viewIds).toHaveLength(2);
    expect(new Set(viewIds).size).toBe(2);
    expect(viewIds).toContain(publicView?.id);

    await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.updateFollowerGroups(follower.id, [])
      ),
    );
    const publicViewAgain = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(publicViewAgain).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: 3,
      outcome: { outcome: "Converged" },
    });
    const emptyViewConfiguration = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.getFollowerSynchronizationConfiguration()
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(emptyViewConfiguration?.scheduleDefault).toEqual({
      type: "daily",
      at: "00:00",
      timezone: "local",
    });
    expect(server.blobRequests()).toBe(4);
    const stableViews = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.listRevisions()
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(
      stableViews
        .map((entry) => entry.id)
        .filter((id) => id.startsWith(`${revision.id}:view:`)),
    ).toHaveLength(2);

    const planned = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.startRun({
          id: decode(RunId)("process-restart-run"),
          follower: follower.id,
          revision: planned.plan.revision,
          plan: planned.plan,
          startedAt: "2026-08-16T00:01:00Z",
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const restartedApplication = Layer.mergeAll(
      followerRepository,
      followerMachine,
      SynchronizationLive.pipe(
        Layer.provide(Layer.merge(followerRepository, followerMachine)),
      ),
      AgentResolutionLive,
    );
    const recovered = await Effect.runPromise(
      recoverFollower(followerDatabase).pipe(
        Effect.provide(restartedApplication),
      ),
    );
    expect(recovered).toMatchObject({
      revision: revision.id,
      downloadedBlobs: 0,
      reusedBlobs: 3,
      outcome: { outcome: "Converged", run: "process-restart-run" },
    });

    if (signingKey === undefined) throw new Error("source signing key was not initialized");
    const nextDirectorySpec = {
      ...directorySpec,
      files: [directorySpec.files[0]!, directorySpec.files[2]!],
    };
    const nextProfile: MachineProfile = {
      id: profileId,
      version: 2,
      name: "Production profile",
      groups: [],
      resources: [
        {
          id: decode(ResourceId)("managed-file"),
          kind: "file",
          policy: "replace-if-unmodified",
          target,
          dependsOn: [],
          spec,
          verify: { method: "digest", digest: sha256Hex(content) },
        },
        {
          id: decode(ResourceId)("managed-config"),
          kind: "config",
          policy: "merge",
          target: configTarget,
          dependsOn: [],
          spec: configSpec,
          verify: { method: "digest", digest: configDigest },
        },
        {
          id: decode(ResourceId)("managed-directory"),
          kind: "directory",
          policy: "mirror-owned",
          target: directoryTarget,
          dependsOn: [],
          spec: nextDirectorySpec,
          verify: {
            method: "digest",
            digest: directoryDigest(nextDirectorySpec.files),
          },
        },
      ],
      scheduleDefault: { type: "daily", at: "01:15", timezone: "local" },
    };
    const nextCanonicalBytes = canonicalJson(asJson(nextProfile));
    const nextDigest = sha256Hex(nextCanonicalBytes);
    const nextResources = nextProfile.resources.map((resource) => ({
      id: decode(ResourceId)(resource.id),
      kind: resource.kind,
      policy: resource.policy ?? "replace",
      target: resource.target,
      dependsOn: [],
      blobs: [decode(BlobId)(digestOf(asJson(resource.spec)))],
    }));
    expect(nextResources.some((resource) => resource.id === "alpha-only-file")).toBe(false);
    const nextId = decode(ProfileRevisionId)(`${profileId}:${nextDigest}`);
    const nextUnsigned = {
      id: nextId,
      profileId,
      sequence: 2,
      canonicalBytes: nextCanonicalBytes,
      digest: nextDigest,
      publishedAt: "2026-08-16T00:02:00Z",
      resources: nextResources,
      groups: [],
      signingKeyId: enrolled.source.keyId,
    };
    await sourceRuntime.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.publishRevision({
          revision: {
            ...nextUnsigned,
            signature: decode(SourceSignature)(
              `ed25519:${
                sign(
                  null,
                  Buffer.from(revisionSigningPayload(nextUnsigned)),
                  signingKey,
                ).toString("base64url")
              }`,
            ),
          },
        })
      ),
    );

    const ownershipPlan = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    const appliedBeforeOwnershipPlan = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(
      appliedBeforeOwnershipPlan.find((record) =>
        record.resource === "managed-directory"
      ),
    ).toMatchObject({
      ownedFiles: [
        { path: "kept.txt" },
        { path: "removed.txt" },
        { path: "東京.txt" },
        { path: "empty", objectKind: "directory" },
      ],
    });
    expect(
      appliedBeforeOwnershipPlan.find((record) =>
        record.resource === "alpha-only-file"
      ),
    ).toBeUndefined();
    expect(ownershipPlan.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "managed-directory",
        detail: expect.objectContaining({
          kind: "mirror-directory",
          adds: [],
          removes: ["removed.txt"],
        }),
      }),
    ]));
    const ownershipApplied = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(ownershipApplied).toMatchObject({ outcome: { outcome: "Converged" } });
    // The inherited default is reconciled after the run, not as a planned
    // action, so a scheduler failure cannot roll back configuration that
    // applied correctly.
    expect(profileScheduleCalls.at(-1)).toEqual({
      kind: "daily",
      localTime: "01:15",
    });
    const updatedConfiguration = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.getFollowerSynchronizationConfiguration()
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(updatedConfiguration?.scheduleDefault).toEqual({
      type: "daily",
      at: "01:15",
      timezone: "local",
    });
    await expect(readFile(join(directoryTarget, "removed.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(restrictedTarget)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(directoryTarget, "kept.txt"), "utf8")).toBe("kept\n");
    const appliedAfterOwnership = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(followerRepository)),
    );
    expect(appliedAfterOwnership.some((record) =>
      record.resource === "alpha-only-file"
    )).toBe(false);
    const ownershipReplan = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    expect(
      ownershipReplan.plan.actions.filter((action) => action.kind !== "no-op"),
    ).toEqual([]);
    const ownershipAgain = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(ownershipAgain).toMatchObject({ outcome: { outcome: "Converged" } });
    expect(await readFile(join(directoryTarget, "kept.txt"), "utf8")).toBe("kept\n");
    const database = new DatabaseSync(followerDatabase, { readOnly: true });
    // SAFETY: COUNT(*) AS count always returns one numeric SQLite aggregate row.
    const removalCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM action_journal
      WHERE action_id LIKE 'action:alpha-only-file:%:remove-resource'
        AND state = 'succeeded'
    `).get() as { count: number };
    database.close();
    expect(removalCount.count).toBe(1);

    const baseFollowerConfiguration = {
      schemaVersion: 1 as const,
      follower,
      selectedProfile: profileId,
      source: {
        endpoint: server.endpoint,
        tlsFingerprint: enrolled.tlsFingerprint,
        signingFingerprint: enrolled.source.publicKeyFingerprint,
      },
      credentialReference: enrolled.credentialReference,
      cacheDirectory: join(root, "follower-cache"),
      stateLocation: followerDatabase,
      agentPolicy: "deterministic-only" as const,
      scheduledInvocation: defaultScheduledInvocation,
      updatedAt: "2026-08-16T00:03:00Z",
    };
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrolled.source,
          configuration: {
            ...baseFollowerConfiguration,
            localOverlay: [{
              resource: decode(ResourceId)("managed-config"),
              target: configTarget,
              keys: ["canonical.value"],
            }],
          },
        })
      ).pipe(Effect.provide(followerRepository)),
    );
    const restartedFollowerRepository = stateRepositoryLayer(followerDatabase);
    const persistedOverlay = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.listLocalOverlays()
      ).pipe(Effect.provide(restartedFollowerRepository)),
    );
    expect(persistedOverlay).toEqual([{
      resource: decode(ResourceId)("managed-config"),
      target: configTarget,
      keys: ["canonical.value"],
    }]);
    const overlayPlan = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "plan").pipe(
        Effect.provide(application),
      ),
    );
    expect(overlayPlan.plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "managed-config",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: expect.stringContaining(
            "Local Overlay conflicts with canonical keys: canonical.value",
          ),
        }),
      }),
    ]));
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.saveFollowerSynchronizationConfiguration({
          sourceIdentity: enrolled.source,
          configuration: {
            ...baseFollowerConfiguration,
            updatedAt: "2026-08-16T00:03:01Z",
          },
        })
      ).pipe(Effect.provide(followerRepository)),
    );

    await writeFile(target, "local drift\n");
    const drifted = await Effect.runPromise(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    );
    expect(drifted).toMatchObject({
      outcome: { outcome: "FollowerDrift" },
    });
    expect(await readFile(target, "utf8")).toBe("local drift\n");

    await sourceRuntime.runPromise(
      Effect.flatMap(Enrollment, (enrollment) =>
        enrollment.revokeFollower(follower.id)
      ),
    );
    const revoked = await Effect.runPromise(Effect.flip(
      synchronizeFollower(followerDatabase, "apply").pipe(
        Effect.provide(application),
      ),
    ));
    expect(revoked._tag).toBe("RevokedFollowerCredentialError");
  });
});
