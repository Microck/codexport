import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AgentResolution } from "../../src/agent/agent-resolution.service.ts";
import {
  ActionId,
  AgentTaskId,
  ContentDigest,
  FollowerId,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
} from "../../src/domain/brand.ts";
import { FollowerIdentity } from "../../src/domain/identity.ts";
import type { ProfileRevision, PublishedResource } from "../../src/domain/profile.ts";
import type {
  AutomaticRecipeMethod,
  RecipeIndexPolicy,
  RecipeSource,
} from "../../src/domain/resource.ts";
import type {
  ActionDetail,
  SynchronizationOutcome,
} from "../../src/domain/synchronization.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import type {
  RenderedSchedulerJob,
  SchedulerBackend,
  SchedulerInspection,
  SchedulerSnapshot,
} from "../../src/machine/machine-state.types.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import type { JsonValue } from "../../src/profile/profile-codec.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import { ScheduleVerificationError } from "../../src/schedule/schedule-manager.errors.ts";
import {
  SyncScheduleSchema,
  type SyncSchedule,
} from "../../src/schedule/schedule-manager.types.ts";
import { planSynchronization } from "../../src/synchronization/planner.ts";
import { RollbackCleanupError } from "../../src/synchronization/synchronization.errors.ts";
import {
  defaultSynchronizationExecutionLimits,
  executeSynchronizationAction,
  executionContexts,
} from "../../src/synchronization/executor.ts";
import {
  getConfigPath,
  parseConfigDocument,
  serializeConfigDocument,
  setConfigPath,
} from "../../src/synchronization/config-codec.ts";
import {
  prepareResourceAction,
  restoreRollbackReference,
  verifyResource,
  type ResourceExecutionContext,
} from "../../src/synchronization/resource-executors.ts";
import type { NpmArtifactTransport } from "../../src/synchronization/npm-artifact.ts";
import { defaultLocalExecution } from "../../src/synchronization/follower-sync-config.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { Synchronization } from "../../src/synchronization/synchronization.service.ts";
import type {
  DesiredResource,
  PlanningProfileRevision,
  SynchronizationArtifact,
  SynchronizationRunInput,
} from "../../src/synchronization/synchronization.types.ts";
import type { AgentResolutionOutcome } from "../../src/agent/agent-resolution.types.ts";
import { composeTextFile, parseTextComposition } from "../../src/domain/text-composition.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-run-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly target: string;
  readonly revision: PlanningProfileRevision;
  readonly artifact: SynchronizationArtifact;
  readonly input: SynchronizationRunInput;
}

class RecordingScheduler implements SchedulerBackend {
  definition: RenderedSchedulerJob | undefined;
  readonly installs: Array<RenderedSchedulerJob> = [];
  removals = 0;

  readonly inspect = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerInspection> =>
    Effect.sync(() => ({
      installed: this.definition !== undefined,
      enabled: this.definition !== undefined,
      matches: this.definition?.service === expected.service
        && this.definition.schedule === expected.schedule,
    }));

  readonly snapshot = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerSnapshot> =>
    Effect.sync(() => this.definition === undefined
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
      this.installs.push(definition);
    });

  readonly remove = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = undefined;
      this.removals += 1;
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

const fileFixture = (
  root: string,
  run = "run-1",
  observedDigest?: string | undefined,
  content = new TextEncoder().encode("canonical content"),
): Fixture => {
  const digest = sha256BytesHex(content);
  const target = join(root, "home", "settings.json");
  const resource: PublishedResource = {
    id: decode(ResourceId)("settings"),
    kind: "file",
    policy: "replace",
    target,
    dependsOn: [],
    blobs: [],
  };
  const baseRevision: ProfileRevision = {
    id: decode(ProfileRevisionId)("revision-1"),
    profileId: decode(ProfileId)("profile-1"),
    sequence: 1,
    canonicalBytes: "{}",
    digest,
    signature: "test-signature",
    publishedAt: "2026-08-15T00:00:00Z",
    resources: [resource],
    groups: [],
  };
  const desired: DesiredResource = {
    kind: "file",
    digest,
    executable: false,
  };
  const revision: PlanningProfileRevision = {
    ...baseRevision,
    desired: [{
      resource: resource.id,
      desired,
      verification: { method: "digest", digest },
    }],
    blobs: [],
  };
  const follower = decode(FollowerId)("follower-1");
  const plan = Effect.runSync(planSynchronization({
    revision,
    follower,
    observedState: {
      platform: "linux",
      resources: [{
        resource: resource.id,
        observed: observedDigest === undefined
          ? { state: "absent" }
          : {
            state: "present",
            digest: decode(ContentDigest)(observedDigest),
            executable: false,
          },
      }],
      availableBlobs: [],
    },
    localOverlay: [],
    appliedResources: [],
  }));
  const artifact = { digest, content };
  return {
    root,
    database: join(root, "state.sqlite"),
    target,
    revision,
    artifact,
    input: {
      id: decode(RunId)(run),
      plan,
      revision,
      artifacts: [artifact],
    },
  };
};

const appendLocalContext = (root: string, previousSource?: string): ResourceExecutionContext => {
  const fixture = fileFixture(root);
  const resource = fixture.revision.resources[0];
  const entry = fixture.revision.desired[0];
  const action = fixture.input.plan.actions[0];
  if (resource === undefined || entry === undefined || action?.detail.kind !== "write-file") {
    throw new Error("file fixture did not produce a write");
  }
  return {
    run: fixture.input.id,
    resource: { ...resource, policy: "append-local" },
    desired: entry.desired,
    verification: entry.verification,
    action: { ...action, detail: { ...action.detail, previousSourceDigest: previousSource === undefined ? undefined : sha256Hex(previousSource) } },
    artifacts: new Map([[fixture.artifact.digest, fixture.artifact]]),
    limits: defaultSynchronizationExecutionLimits,
  };
};

const agentFixture = (root: string): Fixture => {
  const target = join(root, "home", "agent-tool");
  const resource: PublishedResource = {
    id: decode(ResourceId)("agent-tool"),
    kind: "tool",
    policy: "ensure",
    target,
    dependsOn: [],
    blobs: [],
  };
  const revision: PlanningProfileRevision = {
    id: decode(ProfileRevisionId)("revision-agent"),
    profileId: decode(ProfileId)("profile-agent"),
    sequence: 1,
    canonicalBytes: "{}",
    digest: decode(ContentDigest)(sha256Hex("{}")),
    signature: "test-signature",
    publishedAt: "2026-08-15T00:00:00Z",
    resources: [resource],
    groups: [],
    desired: [{
      resource: resource.id,
      desired: {
        kind: "tool",
        toolId: "agent-tool",
        recipes: [],
        loginRequired: false,
      },
      verification: {
        method: "executable-present",
        executable: "agent-tool",
      },
    }],
    blobs: [],
  };
  const task = {
    id: decode(AgentTaskId)("agent:agent-tool:0"),
    resource: resource.id,
    summary: "Resolve agent tool",
    desiredOutcome: "Make agent-tool available",
    observedEvidence: ["Observed state: absent"],
    allowedPaths: [target],
    allowedExecutables: ["agent-tool"],
    executableAuthorizations: [{
      executable: "agent-tool",
      behavior: "leaf" as const,
    }],
    allowedOrigins: [],
    forbidden: ["elevation", "login", "restart", "reboot"] as const,
    timeLimitSeconds: 30,
    outputLimitBytes: 4096,
    verification: { command: ["agent-tool", "--version"] },
  };
  const action = {
    id: decode(ActionId)("action:agent-tool:0:agent-task"),
    resource: resource.id,
    kind: "agent-task" as const,
    detail: {
      kind: "agent-task" as const,
      taskId: task.id,
      summary: task.summary,
    },
    before: [],
  };
  const body = {
    revision: revision.id,
    follower: follower.id,
    requiredBlobs: [],
    actions: [action],
    agentTasks: [task],
  };
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
  const persistedPlan = {
    ...body,
    encoded,
    digest: sha256Hex(encoded),
  };
  return {
    root,
    database: join(root, "state.sqlite"),
    target,
    revision,
    artifact: { digest: "unused", content: new Uint8Array() },
    input: {
      id: decode(RunId)("run-agent"),
      plan: persistedPlan,
      revision,
      artifacts: [],
    },
  };
};

const mirrorContext = (
  root: string,
  target: string,
  relative: string,
  content: string,
): ResourceExecutionContext => {
  const bytes = new TextEncoder().encode(content);
  const digest = decode(ContentDigest)(sha256BytesHex(bytes));
  const resource = decode(ResourceId)("managed-directory");
  return {
    run: decode(RunId)("run-mirror"),
    action: {
      id: decode(ActionId)("action:managed-directory:0:mirror"),
      resource,
      kind: "mirror-directory",
      detail: {
        kind: "mirror-directory",
        target,
        adds: [relative],
        removes: [],
      },
      before: [],
    },
    resource: {
      id: resource,
      kind: "directory",
      policy: "mirror-owned",
      target,
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "directory",
      mode: 0o755,
      directories: [],
      files: [{ path: relative, digest, executable: false, mode: 0o644 }],
    },
    verification: { method: "digest", digest },
    artifacts: new Map([[digest, { digest, content: bytes }]]),
    limits: defaultSynchronizationExecutionLimits,
  };
};

const scheduleContext = (
  root: string,
  previousSchedule?: {
    readonly kind: "daily";
    readonly localTime: string;
  } | undefined,
): ResourceExecutionContext => {
  const spec = {
    kind: "schedule" as const,
    calendar: { type: "daily" as const, at: "03:30" },
    timezone: "local",
  };
  const content = new TextEncoder().encode(JSON.stringify(spec));
  const digest = decode(ContentDigest)(sha256BytesHex(content));
  const resourceId = decode(ResourceId)("schedule");
  return {
    run: decode(RunId)("run-schedule"),
    action: {
      id: decode(ActionId)("action:schedule:0:write-file"),
      resource: resourceId,
      kind: "write-file",
      detail: {
        kind: "write-file",
        target: join(root, "schedule.json"),
        digest,
      },
      before: [],
    },
    resource: {
      id: resourceId,
      kind: "schedule",
      policy: "replace",
      target: join(root, "schedule.json"),
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "schedule",
      digest,
      schedule: { kind: "daily", localTime: "03:30" },
    },
    verification: {
      method: "command",
      command: [process.execPath, "--version"],
    },
    artifacts: new Map([[digest, { digest, content }]]),
    limits: defaultSynchronizationExecutionLimits,
    previousSchedule,
  };
};

const follower = decode(FollowerIdentity)({
  id: "follower-1",
  name: "Follower",
  groups: [],
  revoked: false,
  credentialReference: "secure-store://follower",
  enrolledAt: "2026-08-15T00:00:00Z",
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

const applicationLayer = (
  fixture: Fixture,
  machine = machineLayer(fixture.root),
) =>
  SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(fixture.database)),
    Layer.provideMerge(machine),
  );

const seedAndRun = (
  fixture: Fixture,
  machine = machineLayer(fixture.root),
): Promise<SynchronizationOutcome> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      const {
        removedResources: _,
        desired: __,
        blobs: ___,
        ...persistableRevision
      } = fixture.revision;
      yield* repository.publishRevision({ revision: persistableRevision });
      const synchronization = yield* Synchronization;
      return yield* synchronization.run(fixture.input);
    }).pipe(
      Effect.provide(applicationLayer(fixture, machine)),
    ),
  );

const actionRows = (databasePath: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(`
    SELECT state, verification_json, rollback_reference, removed_resource_json
    FROM action_journal
    ORDER BY sequence
  `).all();
  database.close();
  return rows;
};

const decorateMachine = (
  root: string,
  transform: (service: MachineState["Service"]) => MachineState["Service"],
) =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, transform),
  ).pipe(Layer.provide(machineLayer(root)));

const reencodePlan = (
  plan: SynchronizationRunInput["plan"],
): SynchronizationRunInput["plan"] => {
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify({
      revision: plan.revision,
      follower: plan.follower,
      requiredBlobs: plan.requiredBlobs,
      actions: plan.actions,
      agentTasks: plan.agentTasks,
    })),
  ));
  return { ...plan, encoded, digest: sha256Hex(encoded) };
};

const scheduleDefaultRunInput = (
  fixture: Fixture,
  run: string,
  operation: "upsert" | "remove" = "upsert",
): SynchronizationRunInput => {
  const schedule = { kind: "daily" as const, localTime: "03:30" };
  const previousSchedule = { kind: "daily" as const, localTime: "02:15" };
  const action = {
    id: decode(ActionId)("action:canonfig.schedule-default:0:schedule-default"),
    resource: decode(ResourceId)("canonfig.schedule-default"),
    kind: "schedule-default" as const,
    detail: {
      kind: "schedule-default" as const,
      operation,
      schedule,
      previousSchedule,
    },
    before: [],
  };
  const body = {
    revision: fixture.revision.id,
    follower: follower.id,
    requiredBlobs: [],
    actions: [action],
    agentTasks: [],
  };
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
  return {
    id: decode(RunId)(run),
    plan: {
      ...body,
      encoded,
      digest: sha256Hex(encoded),
    },
    revision: fixture.revision,
    artifacts: [],
  };
};

const scheduleManagerFor = (controls: {
  failUpdate: boolean;
  blockUpdate: boolean;
  failRemove?: boolean;
  failAfterMutation?: boolean;
  initial?: SyncSchedule | undefined;
  started?: (() => void) | undefined;
}): ScheduleManager["Service"] => {
  let current: SyncSchedule | undefined = controls.initial;
  let blockedOnce = false;
  const status = (schedule: SyncSchedule) => ({
    state: current === undefined
      ? "not-installed" as const
      : JSON.stringify(current) === JSON.stringify(schedule)
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
  });
  const update = (input?: { readonly schedule?: SyncSchedule }) => {
    const schedule = input?.schedule ?? { kind: "daily" as const, localTime: "00:00" };
    if (controls.blockUpdate && !blockedOnce) {
      blockedOnce = true;
      controls.started?.();
      return Effect.never;
    }
    if (controls.failUpdate) {
      if (controls.failAfterMutation) current = schedule;
      return Effect.fail(new ScheduleVerificationError({
        operation: "update",
        state: "failed",
        message: "injected schedule update failure",
      }));
    }
    current = schedule;
    return Effect.succeed({
      change: "updated" as const,
      status: status(schedule),
    });
  };
  return ScheduleManager.of({
    install: update,
    update,
    inspect: (input) => Effect.succeed(status(
      input?.schedule ?? { kind: "daily", localTime: "00:00" },
    )),
    status: (input) => Effect.succeed(status(
      input?.schedule ?? { kind: "daily", localTime: "00:00" },
    )),
    snapshot: () => Effect.succeed(current === undefined
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
        schedule: JSON.stringify(current),
      }),
    restore: (_input, snapshot) => Effect.sync(() => {
      current = snapshot.state === "absent"
        ? undefined
        : Schema.decodeUnknownSync(SyncScheduleSchema)(
          JSON.parse(snapshot.schedule ?? "{}"),
        );
    }),
    remove: () => {
      if (controls.failRemove) {
        if (controls.failAfterMutation) current = undefined;
        return Effect.fail(new ScheduleVerificationError({
          operation: "remove",
          state: "failed",
          message: "injected schedule remove failure",
        }));
      }
      current = undefined;
      return Effect.succeed({ change: "removed" as const });
    },
  });
};

const npmTarballBytes = (
  manifest: JsonValue,
): Buffer => {
  const content = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
};

const installerInvocation = async (
  method: string,
  packageName: string,
  version?: string | undefined,
  onInvocation?: () => void,
  onLookup?: () => void,
  source?: RecipeSource | undefined,
  npmArtifactTransport?: ((root: string) => NpmArtifactTransport) | undefined,
  indexPolicy?: RecipeIndexPolicy | undefined,
) => {
  const root = temporaryDirectory();
  const executableQueries: Array<string> = [];
  const invocations: Array<{ readonly executable: string; readonly arguments: ReadonlyArray<string> }> = [];
  const environments: Array<ReadonlyArray<{ readonly name: string; readonly value: string }>> = [];
  const machine = decorateMachine(root, (service) => ({
    ...service,
    findExecutable: ({ name }) => {
      onLookup?.();
      executableQueries.push(name);
      return Effect.succeed({
        name,
        path: { platform: "linux", absolute: join(root, "bin", name) },
      });
    },
    runProcess: (input) => {
      onInvocation?.();
      invocations.push({
        executable: input.executable.absolute,
        arguments: input.arguments,
      });
      environments.push(input.environment ?? []);
      return Effect.succeed({
        exitCode: 0,
        signal: null,
        standardOutput: new Uint8Array(),
        standardError: new Uint8Array(),
      });
    },
  }));
  const resourceId = decode(ResourceId)("tool");
  let detail: Extract<ActionDetail, { readonly kind: "install-tool" }>;
  if (version === undefined) {
    detail = {
      kind: "install-tool" as const,
      toolId: "tool",
      // SAFETY: This helper deliberately injects hostile method strings to
      // verify the execution boundary rejects them before lookup or spawn.
      method: method as AutomaticRecipeMethod,
      package: packageName,
    };
  } else {
    detail = {
      kind: "install-tool" as const,
      toolId: "tool",
      method,
      package: packageName,
      version,
    };
  }
  if (source !== undefined) Object.assign(detail, { source });
  if (indexPolicy !== undefined) Object.assign(detail, { indexPolicy });
  const context: ResourceExecutionContext = {
    run: decode(RunId)(`run-${method}`),
    action: {
      id: decode(ActionId)(`action:tool:0:install-${method}`),
      resource: resourceId,
      kind: "install-tool",
      detail,
      before: [],
    },
    resource: {
      id: resourceId,
      kind: "tool",
      policy: "ensure",
      target: "tool",
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "tool",
      toolId: "tool",
      recipes: [],
      loginRequired: false,
    },
    verification: { method: "executable-present", executable: "tool" },
    artifacts: new Map(),
    limits: defaultSynchronizationExecutionLimits,
    npmArtifactTransport: npmArtifactTransport?.(root),
  };
  await Effect.runPromise(
    Effect.gen(function*() {
      const prepared = yield* prepareResourceAction(context);
      yield* prepared.execute;
    }).pipe(Effect.provide(machine)),
  );
  return { executableQueries, invocations, environments };
};

const realUvInstallerContext = (
  root: string,
  packageName: string,
  indexPolicy?: RecipeIndexPolicy | undefined,
): ResourceExecutionContext => {
  const resourceId = decode(ResourceId)("uv-tool");
  const baseDetail = {
    kind: "install-tool" as const,
    toolId: "uv-tool",
    method: "uv" as const,
    package: packageName,
    version: "1.2.3",
  };
  const detail = indexPolicy === undefined
    ? baseDetail
    : { ...baseDetail, indexPolicy };
  return {
    run: decode(RunId)("run-uv-real"),
    action: {
      id: decode(ActionId)("action:uv-tool:0:install-uv"),
      resource: resourceId,
      kind: "install-tool",
      detail,
      before: [],
    },
    resource: {
      id: resourceId,
      kind: "tool",
      policy: "ensure",
      target: join(root, "home", "uv-tool"),
      dependsOn: [],
      blobs: [],
    },
    desired: {
      kind: "tool",
      toolId: "uv-tool",
      recipes: [],
      loginRequired: false,
    },
    verification: { method: "executable-present", executable: "uv-tool" },
    artifacts: new Map(),
    limits: defaultSynchronizationExecutionLimits,
  };
};

describe("synchronization apply run", () => {
  it.each(["absent", "unmanaged", "managed", "identical"] as const)(
    "restores a persisted append-local backup for an initially %s file",
    async (initial) => {
      const root = temporaryDirectory();
      const oldSource = "previous Source\n";
      const context = appendLocalContext(root, initial === "managed" ? oldSource : undefined);
      const target = context.resource.target;
      const before = initial === "absent" ? undefined
        : initial === "managed" ? composeTextFile(oldSource, { kind: "unmanaged", local: "local\r\n" })
        : new TextEncoder().encode(initial === "identical" ? "canonical content" : "local\r\n");
      await mkdir(dirname(target), { recursive: true });
      if (before !== undefined) {
        await writeFile(target, before);
        chmodSync(target, 0o640);
      }
      const layer = machineLayer(root);
      const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
      if (prepared.rollbackReference === undefined) throw new Error("missing text backup");
      await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
      expect((await Effect.runPromise(verifyResource(context).pipe(Effect.provide(layer)))).passed).toBe(true);
      // Use the persisted reference, not the closure, to prove restart behavior.
      await Effect.runPromise(restoreRollbackReference(context, prepared.rollbackReference).pipe(Effect.provide(layer)));
      await Effect.runPromise(restoreRollbackReference(context, prepared.rollbackReference).pipe(Effect.provide(layer)));
      if (before === undefined) {
        await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(target)).toEqual(Buffer.from(before));
        expect(statSync(target).mode & 0o777).toBe(0o640);
      }
    },
  );

  it("refuses append-local rollback after a new local edit and retains both versions", async () => {
    const root = temporaryDirectory();
    const context = appendLocalContext(root);
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, "original local\r\n");
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
    if (prepared.rollbackReference === undefined) throw new Error("missing text backup");
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    const changed = Buffer.concat([await readFile(context.resource.target), Buffer.from("later edit\n")]);
    await writeFile(context.resource.target, changed);
    await expect(Effect.runPromise(restoreRollbackReference(context, prepared.rollbackReference).pipe(Effect.provide(layer))))
      .rejects.toMatchObject({ _tag: "InvalidExecutionPlanError", message: expect.stringContaining("changed after the action") });
    expect(await readFile(context.resource.target)).toEqual(changed);
    expect(await readFile(`${prepared.rollbackReference}.${sha256Hex(context.resource.target)}.bin`, "utf8"))
      .toBe("original local\r\n");
  });

  it("recovers append-local text near its parsing limit from a raw backup", async () => {
    const root = temporaryDirectory();
    const base = appendLocalContext(root, "old");
    const context = { ...base, limits: { ...base.limits, maximumFileBytes: 256 } };
    const before = composeTextFile("old", { kind: "unmanaged", local: "x".repeat(130) });
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, before);
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
    if (prepared.rollbackReference === undefined) throw new Error("missing text backup");
    expect(await readFile(`${prepared.rollbackReference}.${sha256Hex(context.resource.target)}.bin`))
      .toEqual(Buffer.from(before));
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    await Effect.runPromise(restoreRollbackReference(context, prepared.rollbackReference).pipe(Effect.provide(layer)));
    expect(await readFile(context.resource.target)).toEqual(Buffer.from(before));
  });

  it.each([false, true])("recovers a journaled append-local write without erasing later edits: edited=%s", async (edited) => {
    const root = temporaryDirectory();
    const base = fileFixture(root);
    const context = appendLocalContext(root, "previous Source");
    const revision = { ...base.revision, resources: [context.resource] };
    const plan = reencodePlan({ ...base.input.plan, actions: [context.action] });
    const layer = applicationLayer({ ...base, revision });
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, composeTextFile("previous Source", { kind: "unmanaged", local: "local\n" }));
    const reference = await Effect.runPromise(Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision });
      yield* repository.startRun({ id: context.run, follower: follower.id, revision: revision.id, plan, startedAt: "2026-09-07T00:00:00Z" });
      const prepared = yield* prepareResourceAction(context);
      yield* repository.journalAction({
        run: context.run, action: context.action.id, state: "running", recordedAt: "2026-09-07T00:00:01Z",
        attempt: 1, rollbackReference: prepared.rollbackReference,
      });
      yield* prepared.execute;
      return prepared.rollbackReference;
    }).pipe(Effect.provide(layer)));
    if (reference === undefined) throw new Error("missing text backup");
    const written = await readFile(context.resource.target);
    if (edited) await writeFile(context.resource.target, Buffer.concat([written, Buffer.from("after interruption\n")]));
    // Reopen SQLite and hydrate the serialized action as a fresh process does.
    const recovery = Effect.runPromise(Effect.flatMap(Synchronization, (synchronization) => synchronization.recover({
      follower: follower.id, revision, artifacts: [base.artifact],
    })).pipe(Effect.provide(applicationLayer({ ...base, revision }))));
    if (edited) {
      await expect(recovery).rejects.toMatchObject({ _tag: "RecoveryIntegrityError" });
      expect(await readFile(context.resource.target, "utf8")).toContain("after interruption\n");
      await expect(access(reference)).resolves.toBeUndefined();
    } else {
      expect(await recovery).toMatchObject({ outcome: "Converged" });
      expect(await readFile(context.resource.target)).toEqual(written);
      await expect(access(reference)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves local changes made after planning but rejects a changed Source baseline", async () => {
    const root = temporaryDirectory();
    const oldSource = "old Source";
    const context = appendLocalContext(root, oldSource);
    const layer = machineLayer(root);
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, composeTextFile(oldSource, { kind: "unmanaged", local: "late local edit" }));
    const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    expect(parseTextComposition(await readFile(context.resource.target))).toEqual({
      kind: "managed", source: "canonical content", local: "late local edit",
    });
    const changed = composeTextFile("unexpected Source", { kind: "unmanaged", local: "keep local" });
    await writeFile(context.resource.target, changed);
    await expect(Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer))))
      .rejects.toMatchObject({ _tag: "InvalidExecutionPlanError", message: expect.stringContaining("Source text changed") });
    expect(await readFile(context.resource.target)).toEqual(Buffer.from(changed));
  });

  it("refuses a local edit between append-local preparation and execution", async () => {
    const root = temporaryDirectory();
    const context = appendLocalContext(root);
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, "new local content");
    await expect(Effect.runPromise(prepared.execute.pipe(Effect.provide(layer))))
      .rejects.toMatchObject({ _tag: "InvalidExecutionPlanError", message: expect.stringContaining("changed while preparing") });
    expect(await readFile(context.resource.target, "utf8")).toBe("new local content");
  });

  it("removes only Source text and can restore that removal from its backup", async () => {
    const root = temporaryDirectory();
    const base = appendLocalContext(root);
    const context: ResourceExecutionContext = { ...base, action: {
      ...base.action, kind: "remove-resource", detail: { kind: "remove-resource", target: base.resource.target, paths: [], keys: [] },
    } };
    const before = composeTextFile("canonical content", { kind: "unmanaged", local: "local\r\n" });
    await mkdir(dirname(context.resource.target), { recursive: true });
    await writeFile(context.resource.target, before);
    chmodSync(context.resource.target, 0o640);
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)));
    if (prepared.rollbackReference === undefined) throw new Error("missing text backup");
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    expect(await readFile(context.resource.target, "utf8")).toBe("local\r\n");
    await Effect.runPromise(restoreRollbackReference(context, prepared.rollbackReference).pipe(Effect.provide(layer)));
    expect(await readFile(context.resource.target)).toEqual(Buffer.from(before));
    expect(statSync(context.resource.target).mode & 0o777).toBe(0o640);
  });

  it("rejects binary text, oversized compositions, and symlinks before mutation", async () => {
    const root = temporaryDirectory();
    const base = appendLocalContext(root);
    const context = { ...base, limits: { ...base.limits, maximumFileBytes: 128 } };
    const target = context.resource.target;
    const layer = machineLayer(root);
    await mkdir(dirname(target), { recursive: true });
    for (const bytes of [Buffer.from([0xff]), Buffer.from("\0binary"), Buffer.from("x".repeat(100))]) {
      await writeFile(target, bytes);
      await expect(Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)))).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
      expect(await readFile(target)).toEqual(bytes);
    }
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside");
    rmSync(target);
    symlinkSync(outside, target);
    await expect(Effect.runPromise(prepareResourceAction(context).pipe(Effect.provide(layer)))).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
    expect(readlinkSync(target)).toBe(outside);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it.each([
    [
      "reviewed private index",
      {
        url: "https://PACKAGES.EXAMPLE.TEST:443/repository/simple/?channel=stable",
        reviewedBy: "security-reviewer",
        reviewedAt: "2026-08-18T00:00:00Z",
      },
      "https://packages.example.test/repository/simple?channel=stable",
    ],
    ["fixed PyPI fallback", undefined, "https://pypi.org/simple"],
  ] as const)(
    "runs the deterministic uv installer in an isolated child environment: %s",
    async (_name, indexPolicy, expectedIndex) => {
      const root = temporaryDirectory();
      const bin = join(root, "bin");
      const marker = join(root, "uv-child.json");
      const hostileUvConfig = join(root, "evil-uv.toml");
      const hostilePipConfig = join(root, "evil-pip.conf");
      mkdirSync(bin, { recursive: true });
      writeFileSync(hostileUvConfig, "extra-index-url = 'https://evil.example.test/simple'\n");
      writeFileSync(hostilePipConfig, "extra-index-url=https://evil.example.test/simple\n");
      writeFileSync(
        join(bin, "uv"),
        `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const keys = [
  "UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL",
  "UV_EXTRA_INDEX_URL", "UV_INDEX", "UV_FIND_LINKS", "UV_TRUSTED_HOST",
  "PIP_EXTRA_INDEX_URL", "PIP_FIND_LINKS", "PIP_TRUSTED_HOST",
  "UV_CONFIG_FILE", "PIP_CONFIG_FILE", "UV_HTTP_PROXY", "PIP_PROXY",
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY", "NETRC",
  "KEYRING_BACKEND", "PIP_KEYRING_PROVIDER", "PIP_CERT", "PIP_CLIENT_CERT"
];
const values = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const configBytes = readFileSync(process.env.UV_CONFIG_FILE, "utf8");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  args: process.argv.slice(2),
  values,
  configBytes
}));
if (process.argv.slice(2).some((value) =>
  /(?:extra-index|find-links|trusted-host|--index(?:=|$))/iu.test(value)
)) process.exit(42);
`,
      );
      chmodSync(join(bin, "uv"), 0o755);
      const machine = linuxMachineStateLayer({
        environment: [
          { name: "HOME", value: join(root, "home") },
          { name: "PATH", value: bin },
          { name: "UV_DEFAULT_INDEX", value: "https://evil.example.test/simple" },
          { name: "UV_INDEX_URL", value: "https://evil.example.test/simple" },
          { name: "UV_EXTRA_INDEX_URL", value: "https://evil.example.test/simple" },
          { name: "UV_INDEX", value: "evil=https://evil.example.test/simple" },
          { name: "UV_FIND_LINKS", value: "https://evil.example.test/wheels" },
          { name: "UV_TRUSTED_HOST", value: "evil.example.test" },
          { name: "UV_CONFIG_FILE", value: hostileUvConfig },
          { name: "PIP_INDEX_URL", value: "https://evil.example.test/simple" },
          { name: "PIP_EXTRA_INDEX_URL", value: "https://evil.example.test/simple" },
          { name: "PIP_FIND_LINKS", value: "https://evil.example.test/wheels" },
          { name: "PIP_TRUSTED_HOST", value: "evil.example.test" },
          { name: "PIP_CONFIG_FILE", value: hostilePipConfig },
          { name: "PIP_PROXY", value: "http://evil.example.test" },
          { name: "PIP_CERT", value: join(root, "evil.pem") },
          { name: "PIP_CLIENT_CERT", value: join(root, "evil-client.pem") },
          { name: "PIP_KEYRING_PROVIDER", value: "subprocess" },
          { name: "UV_HTTP_PROXY", value: "http://evil.example.test" },
          { name: "HTTP_PROXY", value: "http://evil.example.test" },
          { name: "https_proxy", value: "http://evil.example.test" },
          { name: "FTP_PROXY", value: "http://evil.example.test" },
          { name: "ALL_PROXY", value: "http://evil.example.test" },
          { name: "NO_PROXY", value: "packages.example.test" },
          { name: "NETRC", value: join(root, "evil.netrc") },
          { name: "KEYRING_BACKEND", value: "evil.backend" },
        ],
      });
      const context = realUvInstallerContext(root, "uv-tool", indexPolicy ?? undefined);
      const prepared = await Effect.runPromise(
        prepareResourceAction(context).pipe(Effect.provide(machine)),
      );
      await Effect.runPromise(prepared.execute.pipe(Effect.provide(machine)));

      // SAFETY: The child fixture writes exactly this JSON object shape.
      const observed = JSON.parse(readFileSync(marker, "utf8")) as {
        readonly args: ReadonlyArray<string>;
        readonly values: Readonly<Record<string, string | undefined>>;
        readonly configBytes: string;
      };
      expect(observed.args).toEqual([
        "tool",
        "install",
        "uv-tool==1.2.3",
        "--only-binary=:all:",
        "--no-config",
        `--default-index=${expectedIndex}`,
      ]);
      expect(observed.values.UV_DEFAULT_INDEX).toBe(expectedIndex);
      expect(observed.values.UV_INDEX_URL).toBe(expectedIndex);
      expect(observed.values.PIP_INDEX_URL).toBe(expectedIndex);
      for (const key of [
        "UV_EXTRA_INDEX_URL",
        "UV_INDEX",
        "UV_FIND_LINKS",
        "UV_TRUSTED_HOST",
        "PIP_EXTRA_INDEX_URL",
        "PIP_FIND_LINKS",
        "PIP_TRUSTED_HOST",
        "UV_HTTP_PROXY",
        "PIP_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "FTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "NETRC",
        "KEYRING_BACKEND",
        "PIP_KEYRING_PROVIDER",
        "PIP_CERT",
        "PIP_CLIENT_CERT",
      ]) {
        expect(observed.values[key]).toBeUndefined();
      }
      expect(observed.values.UV_CONFIG_FILE).toBe("/dev/null");
      expect(observed.values.PIP_CONFIG_FILE).toBe("/dev/null");
      expect(observed.configBytes).toBe("");
    },
  );

  it.each([
    "http://packages.example.test/repository/simple",
    "https://packages.example.test/repository/simple#fragment",
    "https://user:password@packages.example.test/repository/simple",
    "https://packages.example.test/repository/packages",
    "https://packages.example.test/simple/extra",
  ])("rejects an unreviewed or unsafe uv index before lookup or spawn: %s", async (url) => {
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "uv",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
      undefined,
      undefined,
      {
        url,
        reviewedBy: "security-reviewer",
        reviewedAt: "2026-08-18T00:00:00Z",
      },
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
    });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
  });

  it("journals agent-apply before mutation and recovers an interrupted task", async () => {
    const fixture = agentFixture(temporaryDirectory());
    const bin = join(fixture.root, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, "agent-tool");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    const harness = {
      harness: "codex" as const,
      executable: process.execPath,
      maximumInputBytes: 4096,
      allowedPaths: [fixture.target],
      allowedExecutables: ["agent-tool"],
      executableAuthorizations: [{
        executable: "agent-tool",
        behavior: "leaf" as const,
      }],
      allowedOrigins: [],
      allowedCapabilities: [],
      environment: [{ name: "PATH", value: bin }],
    };
    let resolutions = 0;
    let releaseInterrupted: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupted = resolve;
    });
    const task = fixture.input.plan.agentTasks[0]!;
    const applied = (): AgentResolutionOutcome => ({
      outcome: "applied",
      task,
      proposal: { summary: "Install agent tool", actions: [] },
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
        command: task.verification.command,
        exitCode: 0,
        stdout: "agent-tool 1.0",
        stderr: "",
        matched: true,
      },
    });
    const agentResolution = AgentResolution.of({
      resolve: () => {
        resolutions += 1;
        if (resolutions === 1) {
          releaseInterrupted?.();
          return Effect.never;
        }
        return Effect.succeed(applied());
      },
      proposeProfileChange: () => Effect.die("unused"),
    });
    const agent = {
      policy: "agent-apply" as const,
      harness,
    };
    const layer = applicationLayer(fixture);
    const run = Effect.gen(function*() {
      const repository = yield* StateRepository;
      const {
        desired: _desired,
        blobs: _blobs,
        ...persistableRevision
      } = fixture.revision;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: persistableRevision });
      const synchronization = yield* Synchronization;
      return yield* synchronization.run({
        ...fixture.input,
        agent,
        agentResolution,
      });
    }).pipe(Effect.provide(layer));

    const fiber = Effect.runFork(run);
    await interrupted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const interruptedDatabase = new DatabaseSync(fixture.database, { readOnly: true });
    const interruptedRow = interruptedDatabase.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get(fixture.input.id);
    interruptedDatabase.close();
    expect(interruptedRow?.status).toBe("Interrupted");
    expect(await readFile(fixture.target).catch(() => undefined)).toBeUndefined();

    const recovered = await Effect.runPromise(
      Effect.gen(function*() {
        const synchronization = yield* Synchronization;
        return yield* synchronization.recover({
          follower: follower.id,
          revision: fixture.revision,
          artifacts: [],
          agent,
          agentResolution,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(recovered).toEqual({
      outcome: "Converged",
      run: fixture.input.id,
      verified: ["agent-tool"],
    });
    expect(resolutions).toBe(2);
    expect(actionRows(fixture.database).map((row) => row.state)).toEqual([
      "pending",
      "running",
      "failed",
      "running",
      "succeeded",
    ]);
  });

  it("bounds a command verification by the local process limit, not the transport timeout", async () => {
    // The follower used to pass scheduledInvocation.timeoutMilliseconds here,
    // a 10 second HTTP timeout, so any installer or `command` verification that
    // ran longer was killed and the run ended Failed.
    const root = temporaryDirectory();
    const context: ResourceExecutionContext = {
      run: decode(RunId)("run-command-timeout"),
      action: {
        id: decode(ActionId)("action:slow-tool:0"),
        resource: decode(ResourceId)("slow-tool"),
        kind: "no-op",
        detail: { kind: "no-op", reason: "tool already present" },
        dependsOn: [],
      },
      resource: {
        id: decode(ResourceId)("slow-tool"),
        kind: "tool",
        policy: "ensure",
        target: "slow-tool",
        dependsOn: [],
        blobs: [],
      },
      desired: {
        kind: "tool",
        toolId: "slow-tool",
        recipes: [],
        loginRequired: false,
      },
      verification: { method: "command", command: ["/bin/sleep", "1.5"] },
      artifacts: new Map(),
      limits: defaultSynchronizationExecutionLimits,
    };

    const passed = await Effect.runPromise(
      verifyResource(context).pipe(Effect.provide(machineLayer(root))),
    );
    expect(passed.passed).toBe(true);

    // The limit is genuinely what bounds it: a limit below the runtime fails.
    const timedOut = await Effect.runPromise(Effect.flip(
      verifyResource({
        ...context,
        limits: { ...defaultSynchronizationExecutionLimits, processTimeoutMilliseconds: 200 },
      }).pipe(Effect.provide(machineLayer(root))),
    ));
    expect(timedOut._tag).toBe("ProcessTimeoutError");
  });

  it("does not shorten the executor's process limit by default", () => {
    // The follower's own default must not undercut the executor's, which is
    // what passing the transport timeout did on every run.
    expect(defaultLocalExecution.processTimeoutMilliseconds).toBe(
      defaultSynchronizationExecutionLimits.processTimeoutMilliseconds,
    );
  });

  it("verifies an executable-present check that names a path", async () => {
    // Observation reports such a tool present by inspecting the path, so the
    // planner plans a no-op. Verification called findExecutable, which searches
    // PATH and refuses any name containing a separator, so the no-op could
    // never pass and the run ended Failed.
    const root = temporaryDirectory();
    const toolPath = join(root, "opt", "vendor-tool");
    await mkdir(dirname(toolPath), { recursive: true });
    await writeFile(toolPath, "#!/bin/sh\nexit 0\n");
    chmodSync(toolPath, 0o755);

    const context: ResourceExecutionContext = {
      run: decode(RunId)("run-executable-path"),
      action: {
        id: decode(ActionId)("action:vendor-tool:0"),
        resource: decode(ResourceId)("vendor-tool"),
        kind: "no-op",
        detail: { kind: "no-op", reason: "tool already present" },
        dependsOn: [],
      },
      resource: {
        id: decode(ResourceId)("vendor-tool"),
        kind: "tool",
        policy: "ensure",
        target: toolPath,
        dependsOn: [],
        blobs: [],
      },
      desired: {
        kind: "tool",
        toolId: "vendor-tool",
        recipes: [],
        loginRequired: false,
      },
      verification: { method: "executable-present", executable: toolPath },
      artifacts: new Map(),
      limits: defaultSynchronizationExecutionLimits,
    };

    const verification = await Effect.runPromise(
      verifyResource(context).pipe(Effect.provide(machineLayer(root))),
    );
    expect(verification.passed).toBe(true);

    // A path that exists but is not executable still fails.
    const dataPath = join(root, "opt", "not-a-tool");
    await writeFile(dataPath, "data\n");
    chmodSync(dataPath, 0o644);
    const rejected = await Effect.runPromise(
      verifyResource({
        ...context,
        verification: { method: "executable-present", executable: dataPath },
      }).pipe(Effect.provide(machineLayer(root))),
    );
    expect(rejected.passed).toBe(false);
  });

  it("does not follow an intermediate mirror symlink outside the managed root", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(managed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "outside content");
    symlinkSync(outside, join(managed, "sub"));
    const context = mirrorContext(
      root,
      managed,
      "sub/settings.json",
      "managed content",
    );

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(machineLayer(root)))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("restores a tree that was absent without needing the root to exist", async () => {
    // Interrupting a mirror-directory rolls the action back, which removes the
    // tree, and then `canonfig recover` restored the same material again.
    // Every non-root entry goes through the managed root, which is opened with
    // O_DIRECTORY, so this threw ENOENT with the run still open: recover kept
    // exiting 1 and apply kept exiting 4 until the operator created the
    // directory by hand.
    // The managed root does not exist yet, so the captured state records the
    // whole tree as absent and the action is what creates it.
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "desired content",
    );

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    expect(prepared.rollbackReference).toBeDefined();
    await Effect.runPromise(
      prepared.execute.pipe(Effect.provide(machineLayer(root))),
    );

    // Roll back once, which takes the whole tree away because the captured
    // state recorded it as absent.
    await Effect.runPromise(
      restoreRollbackReference(context, prepared.rollbackReference!).pipe(
        Effect.provide(machineLayer(root)),
      ),
    );

    // Restoring the same material again is what recovery does, and it has to
    // succeed rather than trip over the root it just removed.
    await Effect.runPromise(
      restoreRollbackReference(context, prepared.rollbackReference!).pipe(
        Effect.provide(machineLayer(root)),
      ),
    );
  });

  it("writes nested mirror files in-root and replaces only a final symlink", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const outside = join(root, "outside.txt");
    const target = join(managed, "nested", "settings.json");
    mkdirSync(join(managed, "nested"), { recursive: true });
    writeFileSync(outside, "outside content");
    symlinkSync(outside, target);
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(
      prepared.execute.pipe(Effect.provide(machineLayer(root))),
    );

    expect(await readFile(target, "utf8")).toBe("managed content");
    expect(await readFile(outside, "utf8")).toBe("outside content");
  });

  it("captures rollback when a mirror root is a regular file", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const target = join(managed, "nested", "settings.json");
    writeFileSync(managed, "original root file");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const layer = machineLayer(root);

    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    expect(await readFile(target, "utf8")).toBe("managed content");

    await Effect.runPromise(prepared.rollback!.pipe(Effect.provide(layer)));
    expect(await readFile(managed, "utf8")).toBe("original root file");
  });

  it("restores persisted mirror rollback material for unchanged desired directories", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const empty = join(managed, "empty");
    mkdirSync(empty, { recursive: true });
    chmodSync(empty, 0o750);
    const baseContext = mirrorContext(root, managed, "new.txt", "managed content");
    if (baseContext.desired.kind !== "directory") throw new Error("expected directory context");
    const context: ResourceExecutionContext = {
      ...baseContext,
      desired: {
        ...baseContext.desired,
        directories: [{ path: "empty", mode: 0o750 }],
      },
    };
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(layer)),
    );
    if (prepared.rollbackReference === undefined) throw new Error("expected rollback reference");

    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    await Effect.runPromise(
      restoreRollbackReference(context, prepared.rollbackReference).pipe(
        Effect.provide(layer),
      ),
    );

    await expect(access(join(managed, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(statSync(empty).isDirectory()).toBe(true);
    expect(statSync(empty).mode & 0o7777).toBe(0o750);
  });

  it("removes managed descendants before replacing their directory with a leaf", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const child = join(managed, "entry", "child.txt");
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(child, "previous child");
    const context = mirrorContext(root, managed, "entry", "replacement leaf");
    const transitionContext: ResourceExecutionContext = {
      ...context,
      action: {
        ...context.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds: ["entry"],
          removes: ["entry/child.txt"],
        },
      },
    };
    const layer = machineLayer(root);

    const prepared = await Effect.runPromise(
      prepareResourceAction(transitionContext).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    expect(await readFile(join(managed, "entry"), "utf8")).toBe("replacement leaf");

    await Effect.runPromise(prepared.rollback!.pipe(Effect.provide(layer)));
    expect(await readFile(child, "utf8")).toBe("previous child");
  });

  it("preserves exact file, directory, empty-directory, and relative-symlink state", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const context = mirrorContext(root, managed, "bin/tool", "#!/bin/sh\n");
    const linkDigest = decode(ContentDigest)(sha256BytesHex(new TextEncoder().encode("../bin/tool")));
    const desired = {
      kind: "directory" as const,
      mode: 0o755,
      directories: [
        { path: "bin", mode: 0o755 },
        { path: "empty", mode: 0o750 },
        { path: "links", mode: 0o755 },
      ],
      files: [
        { ...context.desired.files[0]!, mode: 0o755, executable: true },
        {
          path: "links/tool",
          digest: linkDigest,
          executable: false,
          mode: 0o777,
          symlinkTo: "../bin/tool",
        },
      ],
    };
    const exactContext: ResourceExecutionContext = {
      ...context,
      action: {
        ...context.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds: ["bin", "empty", "links", "bin/tool", "links/tool"],
          removes: [],
        },
      },
      desired,
      artifacts: new Map(context.artifacts),
    };

    const prepared = await Effect.runPromise(
      prepareResourceAction(exactContext).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(machineLayer(root))));

    expect(statSync(managed).mode & 0o7777).toBe(0o755);
    expect(statSync(join(managed, "bin", "tool")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(managed, "empty")).mode & 0o7777).toBe(0o750);
    expect(readlinkSync(join(managed, "links", "tool"))).toBe("../bin/tool");
  });

  it("defers restrictive directory modes until child mutations finish", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const context = mirrorContext(root, managed, "locked/value.txt", "managed content");
    const desired = {
      kind: "directory" as const,
      mode: 0o600,
      directories: [{ path: "locked", mode: 0o600 }],
      files: context.desired.files,
    };
    const restrictiveContext: ResourceExecutionContext = {
      ...context,
      action: {
        ...context.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds: ["locked", "locked/value.txt"],
          removes: [],
        },
      },
      desired,
    };

    const prepared = await Effect.runPromise(
      prepareResourceAction(restrictiveContext).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(prepared.execute.pipe(Effect.provide(machineLayer(root))));

    expect(statSync(managed).mode & 0o7777).toBe(0o600);
    chmodSync(managed, 0o700);
    expect(statSync(join(managed, "locked")).mode & 0o7777).toBe(0o600);
    chmodSync(join(managed, "locked"), 0o700);
    expect(await readFile(join(managed, "locked", "value.txt"), "utf8"))
      .toBe("managed content");
  });

  it.each([
    {
      case: "surviving",
      adds: [],
      directories: [{ path: "locked", mode: 0o500 }],
      desiredFile: undefined,
      removes: ["locked/obsolete.txt"],
    },
    {
      case: "removed",
      adds: [],
      directories: [],
      desiredFile: undefined,
      removes: ["locked/obsolete.txt", "locked"],
    },
    {
      case: "implicitly surviving",
      adds: [],
      directories: [],
      desiredFile: { exists: true, path: "locked/keep.txt" },
      removes: ["locked/obsolete.txt"],
    },
    {
      case: "implicit add",
      adds: ["locked/new.txt"],
      directories: [],
      desiredFile: { exists: false, path: "locked/new.txt" },
      removes: [],
    },
  ])("widens restrictive $case mirror directories before mutating descendants", async ({
    adds,
    directories,
    desiredFile,
    removes,
  }) => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const locked = join(managed, "locked");
    const obsolete = join(locked, "obsolete.txt");
    mkdirSync(locked, { recursive: true });
    if (removes.includes("locked/obsolete.txt")) {
      writeFileSync(obsolete, "obsolete content");
    }
    if (desiredFile?.exists === true) {
      writeFileSync(join(managed, desiredFile.path), "managed content");
    }
    chmodSync(locked, 0o500);
    chmodSync(managed, 0o500);
    const baseContext = mirrorContext(
      root,
      managed,
      desiredFile?.path ?? "unused.txt",
      "managed content",
    );
    if (baseContext.desired.kind !== "directory") throw new Error("expected directory context");
    const context: ResourceExecutionContext = {
      ...baseContext,
      action: {
        ...baseContext.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds,
          removes,
        },
      },
      desired: {
        kind: "directory",
        mode: 0o500,
        directories,
        files: desiredFile === undefined ? [] : baseContext.desired.files,
      },
    };
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(layer)),
    );

    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));

    const managedMode = statSync(managed).mode & 0o7777;
    const lockedSurvives = !removes.includes("locked");
    const lockedMode = lockedSurvives ? statSync(locked).mode & 0o7777 : undefined;
    // Leave the temporary fixture removable after proving exact restoration.
    chmodSync(managed, 0o700);
    if (lockedSurvives) chmodSync(locked, 0o700);
    if (removes.length > 0) {
      await expect(access(lockedSurvives ? obsolete : locked)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    if (adds.length > 0) {
      expect(await readFile(join(managed, adds[0]!), "utf8")).toBe("managed content");
    }
    expect(managedMode).toBe(0o500);
    if (lockedSurvives) expect(lockedMode).toBe(0o500);
  });

  it("persists and later removes an explicitly owned empty directory", async () => {
    const root = temporaryDirectory();
    const base = fileFixture(root, "run-empty-directory");
    const target = join(root, "managed");
    const resource: PublishedResource = {
      id: decode(ResourceId)("managed-tree"),
      kind: "directory",
      policy: "mirror-owned",
      target,
      dependsOn: [],
      blobs: [],
    };
    const desired: DesiredResource = {
      kind: "directory",
      mode: 0o755,
      directories: [{ path: "empty", mode: 0o750 }],
      files: [],
    };
    const digest = directoryVerificationDigest([]);
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [resource],
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "digest", digest },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const fixture: Fixture = {
      ...base,
      target,
      revision,
      input: {
        ...base.input,
        plan,
        revision,
        artifacts: [],
      },
    };

    const first = await seedAndRun(fixture);
    expect(first.outcome).toBe("Converged");
    expect(statSync(join(target, "empty")).isDirectory()).toBe(true);
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))),
    );
    expect(applied[0]).toMatchObject({
      resource: resource.id,
      mode: 0o755,
      ownedFiles: [{
        path: "empty",
        digest: sha256Hex("canonfig:directory"),
        executable: true,
        mode: 0o750,
        objectKind: "directory",
      }],
    });

    const removedRevision: PlanningProfileRevision = {
      ...revision,
      id: decode(ProfileRevisionId)("revision-empty-directory-removed"),
      sequence: 2,
      removedResources: [resource.id],
    };
    const removalPlan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "directory",
            objectKind: "directory",
            mode: 0o755,
            files: [{
              path: "empty",
              digest: decode(ContentDigest)(sha256Hex("canonfig:directory")),
              executable: true,
              mode: 0o750,
              objectKind: "directory",
            }],
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: applied,
    }));
    expect(removalPlan.actions[0]?.detail).toMatchObject({
      kind: "remove-resource",
      paths: ["empty"],
    });

    const removed = await seedAndRun({
      ...fixture,
      revision: removedRevision,
      input: {
        ...fixture.input,
        id: decode(RunId)("run-empty-directory-removed"),
        plan: removalPlan,
        revision: removedRevision,
        appliedResources: applied,
      },
    });
    expect(removed.outcome).toBe("Converged");
    await expect(access(join(target, "empty"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back a newly-created directory root to missing", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );

    await Effect.runPromise(prepared.execute.pipe(Effect.provide(machineLayer(root))));
    expect(await readFile(join(managed, "nested", "settings.json"), "utf8"))
      .toBe("managed content");

    await Effect.runPromise(prepared.rollback!.pipe(Effect.provide(machineLayer(root))));
    await expect(access(managed)).rejects.toThrow();
  });

  it("keeps managed directories writable until a rollback restores their descendants", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const target = join(nested, "settings.json");
    mkdirSync(nested, { recursive: true });
    writeFileSync(target, "original content");
    chmodSync(nested, 0o500);
    chmodSync(managed, 0o500);
    const baseContext = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    if (baseContext.desired.kind !== "directory") throw new Error("expected directory context");
    const context: ResourceExecutionContext = {
      ...baseContext,
      desired: {
        ...baseContext.desired,
        mode: 0o500,
        directories: [{ path: "nested", mode: 0o500 }],
      },
    };
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(layer)),
    );

    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));
    expect(await readFile(target, "utf8")).toBe("managed content");

    await Effect.runPromise(prepared.rollback!.pipe(Effect.provide(layer)));
    const restoredContent = await readFile(target, "utf8");
    const nestedMode = statSync(nested).mode & 0o777;
    const managedMode = statSync(managed).mode & 0o777;
    // Leave the temporary fixture removable after proving exact restoration.
    chmodSync(managed, 0o700);
    chmodSync(nested, 0o700);
    expect(restoredContent).toBe("original content");
    expect(nestedMode).toBe(0o500);
    expect(managedMode).toBe(0o500);
  });

  it("temporarily makes restrictive managed parents writable during removal", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const target = join(nested, "settings.json");
    mkdirSync(nested, { recursive: true });
    writeFileSync(target, "owned content");
    chmodSync(nested, 0o500);
    chmodSync(managed, 0o500);
    const baseContext = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "owned content",
    );
    if (baseContext.desired.kind !== "directory") throw new Error("expected directory context");
    const context: ResourceExecutionContext = {
      ...baseContext,
      action: {
        ...baseContext.action,
        kind: "remove-resource",
        detail: {
          kind: "remove-resource",
          target: managed,
          paths: ["nested/settings.json", "nested"],
          keys: [],
        },
      },
      desired: {
        ...baseContext.desired,
        mode: 0o500,
        directories: [{ path: "nested", mode: 0o500 }],
      },
    };
    const layer = machineLayer(root);
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(layer)),
    );

    await Effect.runPromise(prepared.execute.pipe(Effect.provide(layer)));

    await expect(access(nested)).rejects.toMatchObject({ code: "ENOENT" });
    expect(statSync(managed).mode & 0o7777).toBe(0o500);
  });

  it("keeps outside paths untouched when an ancestor is swapped during a mirror write", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, "outside content");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("keeps outside paths untouched when an ancestor is swapped during a mirror removal", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(nested, "settings.json"), "managed content");
    writeFileSync(outsideFile, "outside content");
    const base = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const context: ResourceExecutionContext = {
      ...base,
      action: {
        ...base.action,
        detail: {
          kind: "mirror-directory",
          target: managed,
          adds: [],
          removes: ["nested/settings.json"],
        },
      },
      desired: { kind: "directory", files: [] },
    };
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.execute.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("keeps outside paths untouched when an ancestor is swapped during mirror rollback", async () => {
    const root = temporaryDirectory();
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const displaced = join(managed, "displaced");
    const target = join(nested, "settings.json");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "settings.json");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(target, "original content");
    writeFileSync(outsideFile, "outside content");
    const context = mirrorContext(
      root,
      managed,
      "nested/settings.json",
      "managed content",
    );
    const prepared = await Effect.runPromise(
      prepareResourceAction(context).pipe(Effect.provide(machineLayer(root))),
    );
    await Effect.runPromise(
      prepared.execute.pipe(Effect.provide(machineLayer(root))),
    );
    const adversarialLayer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      beforeSafeRootMutation: async () => {
        renameSync(nested, displaced);
        symlinkSync(outside, nested);
      },
    });

    await expect(
      Effect.runPromise(prepared.rollback!.pipe(Effect.provide(adversarialLayer))),
    ).rejects.toMatchObject({
      _tag: "MachineFilesystemError",
      operation: "mutate managed path",
    });
    expect(await readFile(outsideFile, "utf8")).toBe("outside content");
  });

  it("persists, atomically applies, verifies, and journals a successful plan", async () => {
    const fixture = fileFixture(temporaryDirectory());
    const outcome = await seedAndRun(fixture);

    expect(outcome).toEqual({
      outcome: "Converged",
      run: "run-1",
      verified: ["settings"],
    });
    expect(await readFile(fixture.target, "utf8")).toBe("canonical content");
    expect(actionRows(fixture.database).map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(String(actionRows(fixture.database)[2]?.verification_json)).toContain(
      "\"status\":\"passed\"",
    );
  });

  it("verifies a no-op without rewriting the target", async () => {
    const root = temporaryDirectory();
    const first = fileFixture(root);
    mkdirSync(dirname(first.target), { recursive: true });
    writeFileSync(first.target, first.artifact.content);
    const fixture = fileFixture(root, "run-no-op", first.artifact.digest);

    const outcome = await seedAndRun(fixture);
    expect(outcome.outcome).toBe("Converged");
    expect(actionRows(fixture.database).map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(actionRows(fixture.database)[2]?.rollback_reference).toBeNull();
  });

  it("rolls back ownership from a no-op when a later action fails", async () => {
    const root = temporaryDirectory();
    const fixture = fileFixture(root, "run-no-op-later-failure");
    mkdirSync(dirname(fixture.target), { recursive: true });
    writeFileSync(fixture.target, fixture.artifact.content);
    const noOp = fileFixture(root, "unused", fixture.artifact.digest)
      .input.plan.actions[0]!;
    const input = {
      ...fixture.input,
      plan: reencodePlan({
        ...fixture.input.plan,
        actions: [noOp, ...fixture.input.plan.actions],
      }),
      artifacts: [],
    };

    const outcome = await seedAndRun({ ...fixture, input });

    expect(outcome).toMatchObject({
      outcome: "Failed",
      reason: "MissingArtifactError",
    });
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))),
    );
    expect(applied).toEqual([]);
    expect(actionRows(fixture.database)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "failed",
        verification_json: expect.stringContaining("run-rolled-back"),
      }),
    ]));
  });

  it.each([8, 17 * 1024 * 1024])("removes a %i-byte owned resource once and preserves unowned files", async (size) => {
    const fixture = fileFixture(temporaryDirectory(), "run-remove-resource-initial", undefined, Buffer.alloc(size, 0x61));
    const unowned = join(dirname(fixture.target), "unowned.txt");
    const first = await seedAndRun(fixture);
    expect(first.outcome).toBe("Converged");
    await writeFile(unowned, "keep me\n");

    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))),
    );
    const removedRevision: PlanningProfileRevision = {
      ...fixture.revision,
      id: decode(ProfileRevisionId)("revision-removed"),
      sequence: 2,
      canonicalBytes: "{\"removed\":true}",
      digest: decode(ContentDigest)(sha256Hex("{\"removed\":true}")),
      removedResources: [fixture.revision.resources[0]!.id],
    };
    const removalPlan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: fixture.revision.resources[0]!.id,
          observed: {
            state: "present",
            digest: fixture.artifact.digest,
            executable: false,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: applied,
    }));
    expect(removalPlan.actions.map((action) => action.kind)).toContain("remove-resource");

    const removed = await seedAndRun({
      ...fixture,
      revision: removedRevision,
      input: {
        ...fixture.input,
        id: decode(RunId)("run-remove-resource"),
        plan: removalPlan,
        revision: removedRevision,
        appliedResources: applied,
      },
    });
    expect(removed.outcome).toBe("Converged");
    await expect(readFile(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unowned, "utf8")).toBe("keep me\n");
    const removalJournal = actionRows(fixture.database).find((row) =>
      String(row.verification_json).includes("owned-resource-removed")
    );
    expect(String(removalJournal?.removed_resource_json)).toContain(
      `"resource":"${fixture.revision.resources[0]!.id}"`,
    );
    expect(String(removalJournal?.removed_resource_json)).toContain(
      `"target":"${fixture.revision.resources[0]!.target}"`,
    );

    const remainingApplied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(fixture.database))),
    );
    const repeatedPlan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: fixture.revision.resources[0]!.id,
          observed: { state: "absent" },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: remainingApplied,
    }));
    expect(repeatedPlan.actions).toEqual([]);
    const repeated = await seedAndRun({
      ...fixture,
      revision: removedRevision,
      input: {
        ...fixture.input,
        id: decode(RunId)("run-remove-resource-again"),
        plan: repeatedPlan,
        revision: removedRevision,
      },
    });
    expect(repeated.outcome).toBe("Converged");
    expect(await readFile(unowned, "utf8")).toBe("keep me\n");
  });

  it("rolls back successful work when a later action fails", async () => {
    const base = fileFixture(temporaryDirectory(), "run-partial");
    const secondTarget = join(base.root, "home", "other-settings.json");
    const secondContent = new TextEncoder().encode("second canonical content");
    const secondDigest = sha256BytesHex(secondContent);
    const firstResource = base.revision.resources[0]!;
    const secondResource: PublishedResource = {
      ...firstResource,
      id: decode(ResourceId)("zz-other-settings"),
      target: secondTarget,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [firstResource, secondResource],
      desired: [
        ...base.revision.desired,
        {
          resource: secondResource.id,
          desired: {
            kind: "file",
            digest: decode(ContentDigest)(secondDigest),
            executable: false,
          },
          verification: {
            method: "digest",
            digest: decode(ContentDigest)(secondDigest),
          },
        },
      ],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [
          { resource: firstResource.id, observed: { state: "absent" } },
          { resource: secondResource.id, observed: { state: "absent" } },
        ],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const failingMachine = decorateMachine(base.root, (service) => ({
      ...service,
      atomicWrite: (input) =>
        input.path.absolute === secondTarget
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test write",
            path: input.path.absolute,
            message: "injected later-action failure",
          })
          : service.atomicWrite(input),
    }));
    const failed = await seedAndRun({
      ...base,
      revision,
      input: {
        ...base.input,
        id: decode(RunId)("run-partial"),
        plan,
        revision,
        artifacts: [
          base.artifact,
          { digest: secondDigest, content: secondContent },
        ],
      },
    }, failingMachine);
    expect(failed.outcome).toBe("Failed");
    expect(await readFile(base.target).catch(() => undefined)).toBeUndefined();
    expect(await readFile(secondTarget).catch(() => undefined)).toBeUndefined();

    const appliedAfterFailure = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(base.database))),
    );
    expect(appliedAfterFailure).toEqual([]);

    const nextPlan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [
          { resource: firstResource.id, observed: { state: "absent" } },
          { resource: secondResource.id, observed: { state: "absent" } },
        ],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: appliedAfterFailure,
    }));
    expect(
      nextPlan.actions
        .filter((action) => action.kind !== "no-op")
        .map((action) => action.resource),
    ).toEqual(["settings", "zz-other-settings"]);
    const nextInput: SynchronizationRunInput = {
      ...base.input,
      id: decode(RunId)("run-partial-retry"),
      plan: nextPlan,
      revision,
      artifacts: [
        base.artifact,
        { digest: secondDigest, content: secondContent },
      ],
    };
    const recovered = await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.registerFollower({ follower });
        const synchronization = yield* Synchronization;
        return yield* synchronization.run(nextInput);
      }).pipe(Effect.provide(applicationLayer({
        ...base,
        revision,
        input: nextInput,
      }))),
    );
    expect(recovered).toEqual({
      outcome: "Converged",
      run: "run-partial-retry",
      verified: ["settings", "zz-other-settings"],
    });
    expect(await readFile(secondTarget, "utf8")).toBe("second canonical content");
    const appliedAfterRetry = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(base.database))),
    );
    expect(appliedAfterRetry.map((record) => record.resource)).toEqual([
      "settings",
      "zz-other-settings",
    ]);
  });

  it("applies and verifies executable file intent", async () => {
    const base = fileFixture(temporaryDirectory(), "run-executable");
    const resource = base.revision.resources[0]!;
    const desired: DesiredResource = {
      kind: "file",
      digest: base.artifact.digest,
      executable: true,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      desired: [{
        resource: resource.id,
        desired,
        verification: {
          method: "digest",
          digest: base.artifact.digest,
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision },
    });

    expect(outcome.outcome).toBe("Converged");
    expect(statSync(base.target).mode & 0o100).toBe(0o100);
  });

  it.each([
    { fromExecutable: false, toExecutable: true },
    { fromExecutable: true, toExecutable: false },
  ] as const)(
    "converges same-byte file mode transition $fromExecutable to $toExecutable and is idempotent",
    async ({ fromExecutable, toExecutable }) => {
      const root = temporaryDirectory();
      const base = fileFixture(
        root,
        `run-mode-${fromExecutable ? "x" : "-"}-${toExecutable ? "x" : "-"}`,
      );
      mkdirSync(dirname(base.target), { recursive: true });
      writeFileSync(base.target, base.artifact.content);
      chmodSync(base.target, fromExecutable ? 0o700 : 0o600);
      const resource = base.revision.resources[0]!;
      const desired: DesiredResource = {
        kind: "file",
        digest: base.artifact.digest,
        executable: toExecutable,
      };
      const revision: PlanningProfileRevision = {
        ...base.revision,
        id: decode(ProfileRevisionId)(
          `revision-mode-${fromExecutable ? "x" : "-"}-${toExecutable ? "x" : "-"}`,
        ),
        desired: [{
          resource: resource.id,
          desired,
          verification: { method: "digest", digest: base.artifact.digest },
        }],
      };
      const firstPlan = Effect.runSync(planSynchronization({
        revision,
        follower: follower.id,
        observedState: {
          platform: "linux",
          resources: [{
            resource: resource.id,
            observed: {
              state: "present",
              digest: decode(ContentDigest)(base.artifact.digest),
              executable: fromExecutable,
            },
          }],
          availableBlobs: [],
        },
        localOverlay: [],
        appliedResources: [],
      }));
      const first = await seedAndRun({
        ...base,
        revision,
        input: { ...base.input, plan: firstPlan, revision },
      });
      expect(first.outcome).toBe("Converged");
      expect((statSync(base.target).mode & 0o100) !== 0).toBe(toExecutable);

      const applied = await Effect.runPromise(
        Effect.flatMap(StateRepository, (repository) =>
          repository.loadAppliedResources(follower.id)
        ).pipe(Effect.provide(stateRepositoryLayer(base.database))),
      );
      expect(applied[0]?.executable).toBe(toExecutable);
      const secondPlan = Effect.runSync(planSynchronization({
        revision,
        follower: follower.id,
        observedState: {
          platform: "linux",
          resources: [{
            resource: resource.id,
            observed: {
              state: "present",
              digest: decode(ContentDigest)(base.artifact.digest),
              executable: toExecutable,
            },
          }],
          availableBlobs: [],
        },
        localOverlay: [],
        appliedResources: applied,
      }));
      expect(secondPlan.actions.map((action) => action.kind)).toEqual(["no-op"]);
      const second = await seedAndRun({
        ...base,
        revision,
        input: {
          ...base.input,
          id: decode(RunId)(
            `run-mode-second-${fromExecutable ? "x" : "-"}-${toExecutable ? "x" : "-"}`,
          ),
          plan: secondPlan,
          revision,
          appliedResources: applied,
        },
      });
      expect(second.outcome).toBe("Converged");
      expect(actionRows(base.database).at(-1)?.rollback_reference).toBeNull();
    },
  );

  it("rejects a tampered file mode action before any partial apply", async () => {
    const base = fileFixture(temporaryDirectory(), "run-mode-contract");
    const resource = base.revision.resources[0]!;
    const revision: PlanningProfileRevision = {
      ...base.revision,
      desired: [{
        resource: resource.id,
        desired: {
          kind: "file",
          digest: base.artifact.digest,
          executable: true,
        },
        verification: { method: "digest", digest: base.artifact.digest },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const action = plan.actions.find((candidate) => candidate.kind === "write-file");
    expect(action?.detail.kind).toBe("write-file");
    if (action?.detail.kind !== "write-file") return;
    const tampered = reencodePlan({
      ...plan,
      actions: plan.actions.map((candidate) =>
        candidate.id === action.id
          ? {
            ...candidate,
            detail: { ...candidate.detail, executable: false },
          }
          : candidate
      ),
    });
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan: tampered, revision },
    });
    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(base.target).catch(() => undefined)).toBeUndefined();
  });

  it("applies and verifies symlink file intent", async () => {
    const base = fileFixture(temporaryDirectory(), "run-symlink");
    const destination = join(base.root, "home", "destination.txt");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "destination");
    const resource = base.revision.resources[0]!;
    const digest = decode(ContentDigest)(sha256Hex(destination));
    const desired: DesiredResource = {
      kind: "file",
      digest,
      executable: false,
      symlinkTo: destination,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "symlink", target: destination },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision, artifacts: [] },
    });

    expect(outcome.outcome).toBe("Converged");
    expect(readlinkSync(base.target)).toBe(destination);
  });

  it("reinstalls a follower deletion of a previously applied replace-if-unmodified file", async () => {
    const base = fileFixture(temporaryDirectory(), "run-missing-owned");
    const original = base.revision.resources[0]!;
    const resource: PublishedResource = {
      ...original,
      policy: "replace-if-unmodified",
    };
    const desired = base.revision.desired[0]!.desired;
    if (desired.kind !== "file") throw new Error("file fixture produced a non-file resource");
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [resource],
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "digest", digest: desired.digest },
      }],
    };
    const applied = {
      resource: resource.id,
      revision: "revision-previous",
      digest: desired.digest,
      appliedAt: "2026-08-15T00:00:00Z",
      kind: "file" as const,
      policy: "replace-if-unmodified" as const,
      target: resource.target,
      executable: desired.executable,
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: resource.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [applied],
    }));
    // Absence is not a local edit, so Canonfig repairs it. Refusing meant a
    // deleted managed target stopped every run forever and was never restored.
    expect(plan.actions.map((action) => action.kind)).toEqual(["write-file"]);
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: {
        ...base.input,
        plan,
        revision,
        appliedResources: [applied],
      },
    });

    expect(outcome.outcome).toBe("Converged");
    expect(await readFile(base.target, "utf8")).toBe(
      new TextDecoder().decode(base.artifact.content),
    );
  });

  it("runs the declared verification command instead of the tool id", async () => {
    const base = fileFixture(temporaryDirectory(), "run-declared-verification");
    const tool: PublishedResource = {
      id: decode(ResourceId)("declared-tool"),
      kind: "tool",
      policy: "ensure",
      target: "declared-tool",
      dependsOn: [],
      blobs: [],
    };
    const desired: DesiredResource = {
      kind: "tool",
      toolId: "package-identity-not-an-executable",
      recipes: [],
      loginRequired: false,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [tool],
      desired: [{
        resource: tool.id,
        desired,
        verification: {
          method: "command",
          command: [
            process.execPath,
            "-e",
            "process.stdout.write('declared-verification')",
          ],
          expectContains: "declared-verification",
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: tool.id,
          observed: {
            state: "present",
            digest: decode(ContentDigest)(sha256Hex(process.execPath)),
            executable: true,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const outcome = await seedAndRun({
      ...base,
      revision,
      input: { ...base.input, plan, revision, artifacts: [] },
    });

    expect(outcome.outcome).toBe("Converged");
  });

  it.each([
    ["json", "{\n  \"local\": true\n}\n"],
    ["toml", "local = true\n"],
    ["yaml", "local: true\n"],
  ] as const)("merges dotted config keys with the declared %s codec", async (
    format,
    current,
  ) => {
    const base = fileFixture(temporaryDirectory(), `run-config-${format}`);
    mkdirSync(dirname(base.target), { recursive: true });
    writeFileSync(base.target, current);
    const desiredDocument = {};
    setConfigPath(desiredDocument, "agent.model", "review-model");
    const desiredBytes = new TextEncoder().encode(
      serializeConfigDocument(format, desiredDocument),
    );
    const digest = sha256BytesHex(desiredBytes);
    const resource: PublishedResource = {
      ...base.revision.resources[0]!,
      kind: "config",
      policy: "merge",
    };
    const desired: DesiredResource = {
      kind: "config",
      digest,
      format,
      keys: ["agent.model"],
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [resource],
      desired: [{
        resource: resource.id,
        desired,
        verification: { method: "digest", digest },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "present",
            digest: sha256BytesHex(new TextEncoder().encode(current)),
            executable: false,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const artifact = { digest, content: desiredBytes };
    const outcome = await seedAndRun({
      ...base,
      revision,
      artifact,
      input: { ...base.input, plan, revision, artifacts: [artifact] },
    });
    const document = parseConfigDocument(
      format,
      await readFile(base.target, "utf8"),
    );

    expect(outcome.outcome).toBe("Converged");
    expect(getConfigPath(document, "local")).toBe(true);
    expect(getConfigPath(document, "agent.model")).toBe("review-model");
  });

  it.each([8, 17 * 1024 * 1024])("returns Failed and restores %i owned bytes when verification fails", async (size) => {
    const fixture = fileFixture(temporaryDirectory(), "run-verification");
    mkdirSync(dirname(fixture.target), { recursive: true });
    const original = Buffer.alloc(size, 0x61);
    await writeFile(fixture.target, original);
    chmodSync(fixture.target, 0o750);
    const wrongDigest = decode(ContentDigest)("f".repeat(64));
    const revision: PlanningProfileRevision = {
      ...fixture.revision,
      desired: fixture.revision.desired.map((entry) => ({
        ...entry, verification: { method: "digest", digest: wrongDigest },
      })),
    };
    const outcome = await seedAndRun({ ...fixture, revision, input: { ...fixture.input, revision } });
    expect(outcome.outcome).toBe("Failed");
    expect(sha256BytesHex(await readFile(fixture.target))).toBe(sha256BytesHex(original));
    expect(statSync(fixture.target).mode & 0o777).toBe(0o750);
    expect(actionRows(fixture.database)[2]?.rollback_reference).toContain(
      "canonfig/rollback",
    );
  });

  it("returns Failed and rolls back an owned-file action failure", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-action-failure");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, "original");
    let targetWrites = 0;
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== fixture.target) return service.atomicWrite(input);
        targetWrites += 1;
        return targetWrites === 1
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test write",
            path: input.path.absolute,
            message: "injected failure",
          })
          : service.atomicWrite(input);
      },
    }));

    const outcome = await seedAndRun(fixture, machine);
    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(fixture.target, "utf8")).toBe("original");
  });

  it("records Interrupted when cancellation reaches an in-flight mutation", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-cancelled");
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      notifyStarted = resolveStarted;
    });
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== fixture.target) return service.atomicWrite(input);
        notifyStarted?.();
        return Effect.never;
      },
    }));
    const layer = applicationLayer(fixture, machine);
    const program = Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: fixture.revision });
      const synchronization = yield* Synchronization;
      return yield* synchronization.run(fixture.input);
    }).pipe(Effect.provide(layer));
    const fiber = Effect.runFork(program);
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const database = new DatabaseSync(fixture.database, { readOnly: true });
    const row = database.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get("run-cancelled");
    database.close();
    expect(row?.status).toBe("Interrupted");
  });

  it("serializes mutations that share a target", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-serialized");
    const firstAction = fixture.input.plan.actions[0]!;
    const secondAction = {
      ...firstAction,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [firstAction.id],
    };
    const serializedFixture: Fixture = {
      ...fixture,
      input: {
        ...fixture.input,
        plan: reencodePlan({
          ...fixture.input.plan,
          actions: [firstAction, secondAction],
        }),
      },
    };
    let active = 0;
    let maximum = 0;
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      atomicWrite: (input) =>
        Effect.gen(function*() {
          active += 1;
          maximum = Math.max(maximum, active);
          yield* service.atomicWrite(input);
          active -= 1;
        }),
    }));
    await seedAndRun(serializedFixture, machine);
    expect(maximum).toBe(1);
  });

  it("orders running and terminal journal records around execution", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-journal");
    await seedAndRun(fixture);
    const rows = actionRows(fixture.database);
    expect(rows.map((row) => row.state)).toEqual([
      "pending",
      "running",
      "succeeded",
    ]);
    expect(rows[1]?.verification_json).toBeNull();
    expect(rows[2]?.verification_json).not.toBeNull();
  });

  it.each([8, 17 * 1024 * 1024])("cleans rollback material after replacing %i bytes", async (size) => {
    const fixture = fileFixture(temporaryDirectory(), "run-rollback-material");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, Buffer.alloc(size, 0x61));
    expect((await seedAndRun(fixture)).outcome).toBe("Converged");

    const reference = actionRows(fixture.database)[2]?.rollback_reference;
    expect(reference).toBeTypeOf("string");
    await expect(readFile(String(reference), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(dirname(String(reference)))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["valid", "missing", "corrupt"] as const)(
    "recovers a persisted large-file snapshot with a %s backup",
    async (backupState) => {
      const base = fileFixture(temporaryDirectory(), "run-large-recovery");
      const original = Buffer.alloc(17 * 1024 * 1024, 0x61);
      await mkdir(dirname(base.target), { recursive: true });
      await writeFile(base.target, original);
      chmodSync(base.target, 0o750);
      const revision: PlanningProfileRevision = {
        ...base.revision,
        desired: base.revision.desired.map((entry) => ({
          ...entry, verification: { method: "digest", digest: decode(ContentDigest)("f".repeat(64)) },
        })),
      };
      const input = { ...base.input, revision };
      const fixture = { ...base, revision, input };
      const reference = await Effect.runPromise(Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.registerFollower({ follower });
        yield* repository.publishRevision({ revision });
        yield* repository.startRun({ id: input.id, follower: follower.id, revision: revision.id,
          plan: input.plan, startedAt: "2026-09-07T00:00:00Z" });
        const states = yield* executionContexts(input, defaultSynchronizationExecutionLimits);
        const state = states.find((entry) => entry.action.kind === "write-file");
        if (state?.context === undefined) throw new Error("missing file execution context");
        const prepared = yield* prepareResourceAction(state.context);
        yield* repository.journalAction({ run: input.id, action: state.action.id,
          state: "running", recordedAt: "2026-09-07T00:00:01Z", attempt: 1,
          rollbackReference: prepared.rollbackReference });
        yield* prepared.execute;
        if (prepared.rollbackReference === undefined) throw new Error("missing rollback reference");
        return prepared.rollbackReference;
      }).pipe(Effect.provide(applicationLayer(fixture))));
      const backup = `${reference}.${sha256Hex(base.target)}.bin`;
      expect(statSync(reference).size).toBeLessThan(1024);
      expect(statSync(backup).size).toBe(original.length);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      if (backupState === "missing") rmSync(backup);
      if (backupState === "corrupt") await writeFile(backup, "corrupt");
      // Reopen the database and filesystem services; no in-memory rollback closure survives.
      const recovery = Effect.runPromise(Effect.flatMap(Synchronization, (synchronization) =>
        synchronization.recover({ follower: follower.id, revision, artifacts: input.artifacts })
      ).pipe(Effect.provide(applicationLayer(fixture))));
      if (backupState === "valid") {
        expect((await recovery).outcome).toBe("Failed");
        expect(sha256BytesHex(await readFile(base.target))).toBe(sha256BytesHex(original));
        expect(statSync(base.target).mode & 0o777).toBe(0o750);
        await expect(access(dirname(reference))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(recovery).rejects.toMatchObject({ _tag: "RecoveryIntegrityError" });
        expect(await readFile(base.target, "utf8")).toBe("canonical content");
        await access(reference);
        if (backupState === "corrupt") expect(await readFile(backup, "utf8")).toBe("corrupt");
      }
    },
  );

  it.each(["run", "recover"] as const)("retains only failed rollback snapshots during %s", async (operation) => {
    for (const textState of ["no-op", "restored", "edited"] as const) {
      const base = fileFixture(temporaryDirectory());
      const text = appendLocalContext(base.root);
      const desired = { ...text.desired, mode: 0o600 };
      const normal = { ...text.resource, id: decode(ResourceId)("a-normal"), policy: "replace" as const,
        target: join(base.root, "home", "normal.txt") };
      const failing = { ...normal, id: decode(ResourceId)("zz-failing"), kind: "config" as const,
        target: join(base.root, "home", "failing.json") };
      const configBytes = Buffer.from('{"shared":true}');
      const configDigest = decode(ContentDigest)(sha256BytesHex(configBytes));
      const original = textState === "no-op"
        ? composeTextFile("canonical content", { kind: "unmanaged", local: "local\n" })
        : Buffer.from("local\n");
      await mkdir(dirname(base.target), { recursive: true });
      await writeFile(base.target, original);
      chmodSync(base.target, 0o600);
      await writeFile(failing.target, '{"local":true}');
      // A real child edits the text after the earlier action, then fails its
      // own verification. No timers or substituted filesystem operations.
      const command = textState === "edited"
        ? `require('node:fs').appendFileSync(${JSON.stringify(base.target)}, 'later edit\\n'); process.exit(1)`
        : "process.exit(1)";
      const revision: PlanningProfileRevision = {
        ...base.revision,
        resources: [normal, text.resource, failing],
        desired: [
          { resource: normal.id, desired, verification: text.verification },
          { resource: text.resource.id, desired, verification: text.verification },
          { resource: failing.id,
            desired: { kind: "config", format: "json", digest: configDigest, keys: ["shared"] },
            verification: { method: "command", command: [process.execPath, "-e", command] } },
        ],
      };
      const plan = Effect.runSync(planSynchronization({
        revision, follower: follower.id, localOverlay: [], appliedResources: [],
        observedState: { platform: "linux", availableBlobs: [], resources: [
          { resource: normal.id, observed: { state: "absent" } },
          { resource: text.resource.id, observed: textState === "no-op"
            ? { state: "present", objectKind: "regular", executable: false, mode: 0o600,
              digest: sha256BytesHex(original), managedSourceDigest: base.artifact.digest }
            : { state: "absent" } },
          { resource: failing.id, observed: { state: "absent" } },
        ] },
      }));
      const input = { ...base.input, revision, plan,
        artifacts: [base.artifact, { digest: configDigest, content: configBytes }] };
      const fixture = { ...base, revision, input };
      const layer = applicationLayer(fixture);
      let outcome: SynchronizationOutcome;
      if (operation === "run") {
        outcome = await seedAndRun(fixture);
      } else {
        await Effect.runPromise(Effect.gen(function*() {
          const repository = yield* StateRepository;
          yield* repository.registerFollower({ follower });
          yield* repository.publishRevision({ revision });
          yield* repository.startRun({ id: input.id, follower: follower.id, revision: revision.id,
            plan, startedAt: "2026-09-07T00:00:00Z" });
          const states = yield* executionContexts(input, defaultSynchronizationExecutionLimits);
          // Recovery must handle already-journaled successes, not only pending work.
          for (const state of states.filter((entry) => entry.action.resource !== failing.id)) {
            expect((yield* executeSynchronizationAction(input, state)).kind).toBe("verified");
          }
        }).pipe(Effect.provide(layer)));
        outcome = await Effect.runPromise(Effect.flatMap(Synchronization, (synchronization) =>
          synchronization.recover({ follower: follower.id, revision, artifacts: input.artifacts })
        ).pipe(Effect.provide(applicationLayer(fixture))));
      }
      expect(outcome.outcome).toBe("Failed");
      expect(await readFile(failing.target, "utf8")).toBe('{"local":true}');
      await expect(access(normal.target)).rejects.toMatchObject({ code: "ENOENT" });
      const references = [...new Set(actionRows(base.database).flatMap((row) =>
        row.rollback_reference === null ? [] : [decode(Schema.String)(row.rollback_reference)]
      ))];
      expect(references.length).toBe(textState === "no-op" ? 2 : 3);
      const textAction = plan.actions.find((action) => action.resource === text.resource.id);
      if (textAction === undefined) throw new Error("missing text action");
      for (const reference of references) {
        if (textState === "edited" && reference.endsWith(`${sha256Hex(textAction.id)}.json`)) {
          expect(await readFile(`${reference}.${sha256Hex(base.target)}.bin`, "utf8")).toBe("local\n");
        } else {
          await expect(access(reference)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      if (textState === "edited") {
        expect(parseTextComposition(await readFile(base.target))).toEqual({
          kind: "managed", source: "canonical content", local: "local\nlater edit\n",
        });
      } else {
        expect(await readFile(base.target)).toEqual(Buffer.from(original));
        await expect(access(dirname(references[0]!))).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("preserves the committed terminal outcome when rollback cleanup fails", async () => {
    const fixture = fileFixture(temporaryDirectory(), "run-rollback-cleanup-failure");
    mkdirSync(dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, "previous");
    const machine = decorateMachine(fixture.root, (service) => ({
      ...service,
      removeFile: (input) =>
        input.path.absolute.includes("/canonfig/rollback/")
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test rollback cleanup",
            path: input.path.absolute,
            message: "cleanup denied",
          })
          : service.removeFile(input),
    }));

    await expect(seedAndRun(fixture, machine)).rejects.toBeInstanceOf(RollbackCleanupError);
    const database = new DatabaseSync(fixture.database, { readOnly: true });
    // SAFETY: The query selects the one scalar status column for this run.
    const row = database.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get("run-rollback-cleanup-failure") as { status?: string } | undefined;
    database.close();
    expect(row?.status).toBe("Converged");
  });

  it("cleans rollback snapshots for absent, executable, and symlink states", async () => {
    const absent = fileFixture(temporaryDirectory(), "run-rollback-absent");
    const executable = fileFixture(temporaryDirectory(), "run-rollback-executable");
    mkdirSync(dirname(executable.target), { recursive: true });
    writeFileSync(executable.target, "script");
    chmodSync(executable.target, 0o700);
    const symlink = fileFixture(temporaryDirectory(), "run-rollback-symlink");
    const symlinkTarget = join(symlink.root, "original-target");
    mkdirSync(dirname(symlink.target), { recursive: true });
    writeFileSync(symlinkTarget, "target");
    symlinkSync(symlinkTarget, symlink.target);

    for (const value of [absent, executable, symlink]) {
      await seedAndRun(value);
      const reference = actionRows(value.database)[2]?.rollback_reference;
      expect(reference).toBeTypeOf("string");
      await expect(readFile(String(reference), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(dirname(String(reference)))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it.each([
    ["npm", "npm", "@example/tool", "1.2.3", [
      "install",
      "--global",
      "@example/tool@1.2.3",
      "--ignore-scripts",
    ]],
    ["npm", "npm", "@scope/tool", "1.2.3-alpha.1+build.7", [
      "install",
      "--global",
      "@scope/tool@1.2.3-alpha.1+build.7",
      "--ignore-scripts",
    ]],
    ["pnpm", "pnpm", "@scope/tool", "1.2.3", [
      "add",
      "--global",
      "@scope/tool@1.2.3",
      "--ignore-scripts",
    ]],
    ["bun", "bun", "@scope/tool", "1.2.3", [
      "add",
      "--global",
      "@scope/tool@1.2.3",
      "--ignore-scripts",
    ]],
    ["homebrew", "brew", "tool", "1.2.3", ["install", "tool@1.2.3"]],
    ["winget", "winget", "Example.Tool", "1.2.3", [
      "install",
      "--id",
      "Example.Tool",
      "--version",
      "1.2.3",
      "--exact",
      "--silent",
    ]],
    ["uv", "uv", "tool", "1.2.3", [
      "tool",
      "install",
      "tool==1.2.3",
      "--only-binary=:all:",
      "--no-config",
      "--default-index=https://pypi.org/simple",
    ]],
    ["apt", "apt-get", "tool", "1.2.3", ["install", "-y", "tool=1.2.3"]],
  ] as const)(
    "executes versioned %s recipes with ecosystem-specific arguments",
    async (method, executable, packageName, version, arguments_) => {
      const result = await installerInvocation(method, packageName, version);

      expect(result.executableQueries).toEqual([executable]);
      expect(result.invocations).toEqual([{
        executable: expect.stringMatching(new RegExp(`/${executable}$`, "u")),
        arguments: arguments_,
      }]);
    },
  );

  it.each([
    ["npm", "npm"],
    ["pnpm", "pnpm"],
    ["bun", "bun"],
  ] as const)(
    "rejects unversioned %s recipes before lookup or spawn",
    async (method, executable) => {
      let lookups = 0;
      let invocations = 0;
      await expect(installerInvocation(
        method,
        "tool",
        undefined,
        () => {
          invocations += 1;
        },
        () => {
          lookups += 1;
        },
      )).rejects.toMatchObject({
        message: expect.stringContaining(
          "require an exact version or a reviewed tarball with integrity",
        ),
      });
      expect(lookups).toBe(0);
      expect(invocations).toBe(0);
      expect(executable).toBe(method);
    },
  );

  it.each([
    "homebrew",
    "winget",
    "uv",
    "apt",
  ] as const)(
    "rejects unversioned %s recipes before lookup or spawn",
    async (method) => {
      let lookups = 0;
      let invocations = 0;
      await expect(installerInvocation(
        method,
        "tool",
        undefined,
        () => {
          invocations += 1;
        },
        () => {
          lookups += 1;
        },
      )).rejects.toMatchObject({
        _tag: "InvalidExecutionPlanError",
        message: `automatic installer ${method} requires an exact version`,
      });

      expect(lookups).toBe(0);
      expect(invocations).toBe(0);
    },
  );

  it("uses the verified local npm artifact and pins source-less installs", async () => {
    const artifact = "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz";
    const artifactBytes = npmTarballBytes({
      name: "tool",
      version: "1.2.3",
    });
    const integrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
    const reviewed = await installerInvocation(
      "npm",
      "tool",
      "1.2.3",
      undefined,
      undefined,
      { source: artifact, integrity },
      (root) => {
        const artifactPath = join(
          root,
          "home",
          ".cache",
          "canonfig",
          "npm-artifacts",
          "verified.tgz",
        );
        return {
          download: () => Effect.promise(async () => {
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, artifactBytes);
            return {
              path: artifactPath,
              bytes: artifactBytes.byteLength,
              integrity,
              source: artifact,
            };
          }),
        };
      },
    );
    const artifactPath = join(
      temporaryDirectories.at(-1)!,
      "home",
      ".cache",
      "canonfig",
      "npm-artifacts",
      "verified.tgz",
    );
    expect(reviewed.invocations[0]?.arguments).toEqual([
      "install",
      "--global",
      artifactPath,
      "--ignore-scripts",
      "--offline",
    ]);
    expect(reviewed.environments[0]).toContainEqual({
      name: "NPM_CONFIG_OFFLINE",
      value: "true",
    });

    const fallback = await installerInvocation("npm", "tool", "1.2.3");
    expect(fallback.environments[0]).toContainEqual({
      name: "NPM_CONFIG_REGISTRY",
      value: "https://registry.npmjs.org/",
    });
    expect(fallback.invocations[0]?.arguments).toContain("tool@1.2.3");
  });

  it("uses offline mode for pnpm reviewed local artifacts", async () => {
    const artifact = "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz";
    const artifactBytes = npmTarballBytes({ name: "tool", version: "1.2.3" });
    const integrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
    const reviewed = await installerInvocation(
      "pnpm",
      "tool",
      "1.2.3",
      undefined,
      undefined,
      { source: artifact, integrity },
      (root) => {
        const artifactPath = join(
          root,
          "home",
          ".cache",
          "canonfig",
          "npm-artifacts",
          "verified.tgz",
        );
        return {
          download: () => Effect.promise(async () => {
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, artifactBytes);
            return {
              path: artifactPath,
              bytes: artifactBytes.byteLength,
              integrity,
              source: artifact,
            };
          }),
        };
      },
    );
    expect(reviewed.invocations[0]?.arguments).toEqual([
      "add",
      "--global",
      expect.stringContaining("/.cache/canonfig/npm-artifacts/verified.tgz"),
      "--ignore-scripts",
      "--offline",
    ]);
    expect(reviewed.environments[0]).toContainEqual({
      name: "PNPM_CONFIG_OFFLINE",
      value: "true",
    });
  });

  it.each([
    ["dependency", {
      dependencies: { dependency: "1.0.0" },
    }],
    ["optional dependency", {
      optionalDependencies: { dependency: "1.0.0" },
    }],
    ["peer dependency", {
      peerDependencies: { dependency: "1.0.0" },
    }],
    ["optional peer metadata", {
      peerDependenciesMeta: { dependency: { optional: true } },
    }],
    ["workspace alias", {
      dependencies: { dependency: "workspace:*" },
      bundledDependencies: ["dependency"],
    }],
    ["package manager indirection", {
      packageManager: "pnpm@9.0.0",
    }],
    ["bundled dependency inconsistency", {
      dependencies: { dependency: "1.0.0" },
      bundledDependencies: ["missing"],
    }],
  ] as const)("rejects reviewed npm artifacts with %s before lookup or spawn", async (
    _name,
    fields,
  ) => {
    const artifact = "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz";
    const artifactBytes = npmTarballBytes({
      name: "tool",
      version: "1.2.3",
      ...fields,
    });
    const integrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "npm",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
      { source: artifact, integrity },
      (root) => {
        const artifactPath = join(
          root,
          "home",
          ".cache",
          "canonfig",
          "npm-artifacts",
          "verified.tgz",
        );
        return {
          download: () => Effect.promise(async () => {
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, artifactBytes);
            return {
              path: artifactPath,
              bytes: artifactBytes.byteLength,
              integrity,
              source: artifact,
            };
          }),
        };
      },
    )).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
  });

  it("does not spawn bun when offline local installation cannot be guaranteed", async () => {
    const artifact = "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz";
    const artifactBytes = npmTarballBytes({ name: "tool", version: "1.2.3" });
    const integrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
    let lookedUp = false;
    let spawned = false;
    let downloaded = false;
    await expect(installerInvocation(
      "bun",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
      { source: artifact, integrity },
      (root) => {
        const artifactPath = join(
          root,
          "home",
          ".cache",
          "canonfig",
          "npm-artifacts",
          "verified.tgz",
        );
        return {
          download: () => Effect.promise(async () => {
            downloaded = true;
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, artifactBytes);
            return {
              path: artifactPath,
              bytes: artifactBytes.byteLength,
              integrity,
              source: artifact,
            };
          }),
        };
      },
    )).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
    expect(downloaded).toBe(false);
  });

  it.each([
    "HTTPS://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
    "https://REGISTRY.NPMJS.ORG/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org:443/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/../tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz%23fragment",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz#fragment",
    "https://user:password@registry.npmjs.org/tool/-/tool-1.2.3.tgz",
  ])("rejects noncanonical npm sources before executable lookup: %s", async (source) => {
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "npm",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
      { source, integrity: "sha512-c2FtcGxl" },
    )).rejects.toMatchObject({ _tag: "InvalidExecutionPlanError" });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
  });

  const missingIntegritySource: RecipeSource =
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz";
  const unsupportedIntegritySource: RecipeSource = {
    source: "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
    integrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  it.each([
    ["missing", missingIntegritySource],
    ["unsupported", unsupportedIntegritySource],
  ] satisfies ReadonlyArray<readonly [string, RecipeSource]>)(
    "does not spawn for %s reviewed npm artifact integrity",
    async (_name, source) => {
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "npm",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
      source,
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
    });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
    },
  );

  it("rejects Cargo scripts-disabled recipes before lookup or spawn", async () => {
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "cargo",
      "tool",
      "1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
      message: "cargo recipe tool requires Human Action Required because Cargo has no disable-scripts mode",
    });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
  });

  it("rejects source recipes before executable lookup or spawn", async () => {
    let lookedUp = false;
    let spawned = false;
    await expect(installerInvocation(
      "source",
      "https://github.com/example/tool",
      "v1.2.3",
      () => {
        spawned = true;
      },
      () => {
        lookedUp = true;
      },
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
      message: "source recipe https://github.com/example/tool requires Human Action Required; no bounded source installer is available",
    });
    expect(lookedUp).toBe(false);
    expect(spawned).toBe(false);
  });

  it.each([
    ["npm", "@scope/tool", "latest"],
    ["pnpm", "@scope/tool", "^1.2.3"],
    ["bun", "@scope/tool", "1.2"],
    ["brew", "tool", "1.2/3"],
    ["homebrew", "tool", "1.2/3"],
    ["winget", "Example.Tool", "1.2/3"],
    ["uv", "tool", "1.2/3"],
    ["cargo", "tool", "latest"],
    ["apt", "tool", "1.2/3"],
    ["source", "tool", "../bad"],
  ] as const)(
    "rejects malformed %s versions before lookup or spawn",
    async (method, packageName, version) => {
      let lookedUp = false;
      let spawned = false;
      await expect(installerInvocation(
        method,
        packageName,
        version,
        () => {
          spawned = true;
        },
        () => {
          lookedUp = true;
        },
      )).rejects.toMatchObject({
        _tag: "InvalidExecutionPlanError",
      });
      expect(lookedUp).toBe(false);
      expect(spawned).toBe(false);
    },
  );

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s methods before lookup or spawn",
    async (version) => {
      let lookedUp = false;
      let spawned = false;
      await expect(installerInvocation(
        "unknown-installer",
        "tool",
        version,
        () => {
          spawned = true;
        },
        () => {
          lookedUp = true;
        },
      )).rejects.toMatchObject({
        _tag: "InvalidExecutionPlanError",
      });
      expect(lookedUp).toBe(false);
      expect(spawned).toBe(false);
    },
  );

  it.each([
    ["git URL", "git+https://github.com/example/tool.git#v1.2.3"],
    ["GitHub shorthand", "github:example/tool"],
    ["GitHub repository shorthand", "example/tool"],
    ["GitLab shorthand", "gitlab:example/tool"],
    ["Bitbucket shorthand", "bitbucket:example/tool"],
    ["git SSH URL", "git+ssh://git@github.com/example/tool.git"],
    ["hosted tarball", "https://github.com/example/tool/archive/v1.2.3.tgz"],
    ["npm alias", "alias@npm:real-tool"],
    ["scoped npm alias", "@scope/alias@npm:@scope/real-tool"],
    ["alias with remote", "alias@github:example/tool"],
    ["scoped alias with remote", "@scope/alias@git+https://github.com/example/tool.git"],
    ["credential-bearing remote", "https://user:pass@github.com/example/tool.tgz"],
    ["local file", "file:../tool"],
    ["linked package", "link:../tool"],
    ["workspace package", "workspace:*"],
    ["leading option", "--ignore-scripts"],
    ["separator variant", "tool --ignore-scripts"],
  ])("rejects npm %s dependency forms before spawn", async (_name, packageName) => {
    let descendantExecuted = false;
    await expect(installerInvocation(
      "npm",
      packageName,
      undefined,
      () => {
        descendantExecuted = true;
      },
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
    });
    expect(descendantExecuted).toBe(false);
  });

  it.each([
    ["dist-tag", "latest"],
    ["range", "^1.2.3"],
    ["range wildcard", "1.2.x"],
    ["URL", "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz"],
    ["Git URL", "git+https://github.com/example/tool.git#v1.2.3"],
    ["GitHub spec", "github:example/tool"],
    ["alias", "npm:real-tool"],
    ["file spec", "file:../tool"],
    ["workspace spec", "workspace:*"],
    ["link spec", "link:../tool"],
    ["encoded separator", "1.2.3%2F--ignore-scripts"],
    ["option", "--ignore-scripts"],
    ["separator", "1.2.3;--ignore-scripts"],
    ["control", "1.2.3\n--ignore-scripts"],
  ])("rejects npm %s versions before spawn", async (_name, version) => {
    let descendantExecuted = false;
    await expect(installerInvocation(
      "npm",
      "@scope/tool",
      version,
      () => {
        descendantExecuted = true;
      },
    )).rejects.toMatchObject({
      _tag: "InvalidExecutionPlanError",
    });
    expect(descendantExecuted).toBe(false);
  });

  it("never claims rollback for external installer actions", async () => {
    const root = temporaryDirectory();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const installer = join(bin, "apt-get");
    writeFileSync(installer, "#!/bin/sh\nexit 9\n");
    chmodSync(installer, 0o755);
    const base = fileFixture(root, "run-installer");
    const tool: PublishedResource = {
      id: decode(ResourceId)("tool"),
      kind: "tool",
      policy: "ensure",
      target: "ripgrep",
      dependsOn: [],
      blobs: [],
    };
    const desired: DesiredResource = {
      kind: "tool",
      toolId: "rg",
      recipes: [{
        platform: "linux",
        method: "apt",
        package: "ripgrep",
        version: "14.1.0",
      }],
      loginRequired: false,
    };
    const revision: PlanningProfileRevision = {
      ...base.revision,
      resources: [tool],
      desired: [{
        resource: tool.id,
        desired,
        verification: {
          method: "executable-present",
          executable: "rg",
        },
      }],
    };
    const plan = Effect.runSync(planSynchronization({
      revision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{ resource: tool.id, observed: { state: "absent" } }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [],
    }));
    const fixture: Fixture = {
      ...base,
      revision,
      input: {
        id: decode(RunId)("run-installer"),
        plan,
        revision,
        artifacts: [],
      },
    };

    const outcome = await seedAndRun(fixture);
    expect(outcome.outcome).toBe("Failed");
    expect(actionRows(fixture.database)[2]?.rollback_reference).toBeNull();
  });
});
