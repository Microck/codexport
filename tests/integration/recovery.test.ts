import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActionId,
  AgentTaskId,
  ContentDigest,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
} from "../../src/domain/brand.ts";
import { FollowerIdentity } from "../../src/domain/identity.ts";
import type {
  ProfileRevision,
  PublishedResource,
} from "../../src/domain/profile.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  canonicalJson,
  sha256BytesHex,
  sha256Hex,
} from "../../src/profile/profile-codec.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import {
  SyncScheduleSchema,
  type SyncSchedule,
} from "../../src/schedule/schedule-manager.types.ts";
import { RepositoryDecodeError } from "../../src/state/state-repository.errors.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import type { JournalActionInput } from "../../src/state/state-repository.types.ts";
import { planSynchronization } from "../../src/synchronization/planner.ts";
import { RecoveryIntegrityError } from "../../src/synchronization/synchronization.errors.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";
import { Synchronization } from "../../src/synchronization/synchronization.service.ts";
import type {
  DesiredResource,
  PlanningProfileRevision,
  SynchronizationArtifact,
  SynchronizationRecoveryInput,
} from "../../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
};

const follower = decode(FollowerIdentity)({
  id: "follower-recovery",
  name: "Recovery follower",
  groups: [],
  revoked: false,
  credentialReference: "secure-store://recovery",
  enrolledAt: "2026-08-15T00:00:00Z",
});

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly target: string;
  readonly artifact: SynchronizationArtifact;
  readonly revision: PlanningProfileRevision;
  readonly recovery: SynchronizationRecoveryInput;
}

type TestRollbackPayload =
  | { readonly path: string; readonly state: "absent" }
  | { readonly path: string; readonly state: "directory"; readonly mode: number }
  | {
    readonly path: string;
    readonly state: "regular";
    readonly content: Uint8Array;
    readonly mode: number;
  }
  | { readonly path: string; readonly state: "symlink"; readonly target: string };

const fixture = (
  root: string,
  options: {
    readonly kind?: "file" | "tool";
    readonly version?: string | undefined;
  } = {},
): Fixture => {
  const kind = options.kind ?? "file";
  const target = kind === "file" ? join(root, "home", "settings.json") : "rg";
  const content = new TextEncoder().encode("canonical content");
  const digest = sha256BytesHex(content);
  const resource: PublishedResource = kind === "file"
    ? {
      id: decode(ResourceId)("settings"),
      kind: "file",
      policy: "replace",
      target,
      dependsOn: [],
      blobs: [],
    }
    : {
      id: decode(ResourceId)("tool"),
      kind: "tool",
      policy: "ensure",
      target,
      dependsOn: [],
      blobs: [],
    };
  const baseRevision: ProfileRevision = {
    id: decode(ProfileRevisionId)("revision-recovery"),
    profileId: decode(ProfileId)("profile-recovery"),
    sequence: 1,
    canonicalBytes: "{}",
    digest,
    signature: "test-signature",
    publishedAt: "2026-08-15T00:00:00Z",
    resources: [resource],
    groups: [],
  };
  const desired: DesiredResource = kind === "file"
    ? { kind: "file", digest, executable: false }
    : {
      kind: "tool",
      toolId: "rg",
      recipes: [{
        platform: "linux",
        method: "apt",
        package: "ripgrep",
        version: options.version ?? "14.1.0",
      }],
      loginRequired: false,
    };
  const revision: PlanningProfileRevision = {
    ...baseRevision,
    desired: [{
      resource: resource.id,
      desired,
      verification: kind === "file"
        ? { method: "digest", digest }
        : { method: "executable-present", executable: "rg" },
    }],
    blobs: [],
  };
  const artifact = { digest, content };
  return {
    root,
    database: join(root, "state.sqlite"),
    target,
    artifact,
    revision,
    recovery: {
      follower: follower.id,
      revision,
      artifacts: kind === "file" ? [artifact] : [],
    },
  };
};

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

const decorateMachine = (
  root: string,
  transform: (service: MachineState["Service"]) => MachineState["Service"],
) =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, transform),
  ).pipe(Layer.provide(machineLayer(root)));

const applicationLayer = (
  value: Fixture,
  machine = machineLayer(value.root),
) => SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(value.database)),
    Layer.provideMerge(machine),
  );

const inMemoryScheduleManager = (initial?: SyncSchedule) => {
  let current: SyncSchedule | undefined = initial;
  const selectedSchedule = (input?: { readonly schedule?: SyncSchedule }) =>
    input?.schedule ?? { kind: "daily" as const, localTime: "00:00" };
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
      serviceName: "recovery-test",
      service: "",
      schedule: "",
    },
  });
  const update = (input?: { readonly schedule?: SyncSchedule }) => {
    const schedule = selectedSchedule(input);
    current = schedule;
    return Effect.succeed({
      change: "updated" as const,
      status: status(schedule),
    });
  };
  const manager = ScheduleManager.of({
    install: update,
    update,
    inspect: (input) => Effect.succeed(status(selectedSchedule(input))),
    status: (input) => Effect.succeed(status(selectedSchedule(input))),
    snapshot: () => Effect.succeed(current === undefined
      ? {
        state: "absent" as const,
        platform: "linux" as const,
        mechanism: "systemd-user-timer" as const,
        serviceName: "recovery-test",
      }
      : {
        state: "present" as const,
        platform: "linux" as const,
        mechanism: "systemd-user-timer" as const,
        serviceName: "recovery-test",
        enabled: true,
        servicePresent: true,
        schedulePresent: true,
        schedule: JSON.stringify(current),
      }),
    restore: (_input, snapshot) => Effect.sync(() => {
      current = snapshot.state === "absent"
        ? undefined
        : Schema.decodeUnknownSync(SyncScheduleSchema)(
          JSON.parse(snapshot.schedule ?? "{}"),
        );
    }),
    remove: () => Effect.sync(() => {
      current = undefined;
      return { change: "removed" as const };
    }),
  });
  return { manager, current: () => current };
};

const persistedPlan = (value: Fixture) => {
  const desired = value.revision.desired[0]!.desired;
  const planned = Effect.runSync(planSynchronization({
    revision: value.revision,
    follower: follower.id,
    observedState: {
      platform: "linux",
      resources: [{
        resource: value.revision.resources[0]!.id,
        observed: { state: "absent" },
      }],
      availableBlobs: [],
    },
    localOverlay: [],
    appliedResources: [],
  }));
  if (desired.kind !== "file" || value.revision.resources.length !== 1) return planned;
  return planned;
};

const seed = (
  value: Fixture,
  plan = persistedPlan(value),
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.registerFollower({ follower });
      yield* repository.publishRevision({ revision: value.revision });
      yield* repository.startRun({
        id: decode(RunId)("run-recovery"),
        follower: follower.id,
        revision: value.revision.id,
        plan,
        startedAt: "2026-08-15T00:01:00Z",
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const journal = (
  value: Fixture,
  action: string,
  state: "running" | "succeeded" | "failed" | "skipped",
  rollbackReference?: string,
  ownership: Pick<
    JournalActionInput,
    "appliedResource" | "removedResource" | "removedResourceRecord"
  > = {},
  attempt = 1,
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.journalAction({
        run: decode(RunId)("run-recovery"),
        action: decode(ActionId)(action),
        state,
        recordedAt: "2026-08-15T00:02:00Z",
        attempt,
        verification: state === "succeeded"
          ? { status: "passed" as const, method: "sha256" }
          : undefined,
        rollbackReference,
        ...ownership,
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const interruptRun = (value: Fixture) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* StateRepository;
      yield* repository.completeRun({
        run: decode(RunId)("run-recovery"),
        completedAt: "2026-08-15T00:03:00Z",
        outcome: {
          outcome: "Interrupted",
          run: decode(RunId)("run-recovery"),
          completedActions: [],
        },
        appliedResources: [],
      });
    }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
  );

const rollbackReference = (
  value: Fixture,
  action: string,
  previous: string,
): string => {
  return writeRollbackPayload(value, action, {
    path: value.target,
    state: "regular",
    content: Buffer.from(previous),
    mode: 0o600,
  });
};

const writeRollbackPayload = (
  value: Fixture,
  action: string,
  payload: TestRollbackPayload,
): string => {
  const path = join(
    value.root,
    "home",
    ".cache",
    "canonfig",
    "rollback",
    "run-recovery",
    `${sha256Hex(action)}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  if (payload.state === "regular") {
    const { content, ...metadata } = payload;
    writeFileSync(`${path}.${sha256Hex(payload.path)}.bin`, content, { mode: 0o600 });
    writeFileSync(path, JSON.stringify([{ ...metadata, digest: sha256BytesHex(content) }]));
  } else {
    writeFileSync(path, JSON.stringify([payload]));
  }
  return path;
};

const writeScheduleRollbackPayload = (
  value: Fixture,
  action: string,
  schedule: SyncSchedule,
): string => {
  const path = join(
    value.root,
    "home",
    ".cache",
    "canonfig",
    "rollback",
    "run-recovery",
    `${sha256Hex(action)}.schedule.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    state: "present",
    platform: "linux",
    mechanism: "systemd-user-timer",
    serviceName: "recovery-test",
    enabled: true,
    servicePresent: true,
    schedulePresent: true,
    schedule: JSON.stringify(schedule),
  }));
  return path;
};

const recover = (
  value: Fixture,
  machine = machineLayer(value.root),
  scheduleManager?: ScheduleManager["Service"],
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const synchronization = yield* Synchronization;
      return yield* synchronization.recover(value.recovery);
    }).pipe(
      scheduleManager === undefined
        ? (effect) => effect
        : Effect.provideService(ScheduleManager, scheduleManager),
      Effect.provide(applicationLayer(value, machine)),
    ),
  );

const runRows = (value: Fixture) => {
  const database = new DatabaseSync(value.database, { readOnly: true });
  const rows = database.prepare(`
    SELECT action_id, state, attempt, rollback_reference
    FROM action_journal
    ORDER BY sequence
  `).all();
  database.close();
  return rows;
};

describe("synchronization crash recovery", () => {
  it.each([
    ["before mutation", "pending", false],
    ["during write/replace", "running", true],
    ["after mutation before journal completion", "running", true],
    ["after completion before run finalization", "succeeded", true],
  ] as const)(
    "recovers an interruption %s",
    async (_label, state, mutated) => {
      const value = fixture(temporaryDirectory());
      const plan = persistedPlan(value);
      await seed(value, plan);
      const action = plan.actions[0]!;
      mkdirSync(dirname(value.target), { recursive: true });
      writeFileSync(value.target, mutated ? "partial content" : "original");
      if (state !== "pending") {
        const reference = rollbackReference(value, action.id, "original");
        await journal(value, action.id, "running", reference);
        if (state === "succeeded") {
          writeFileSync(value.target, value.artifact.content);
          await journal(value, action.id, "succeeded", reference);
        }
      }

      let targetWrites = 0;
      const machine = decorateMachine(value.root, (service) => ({
        ...service,
        atomicWrite: (input) => {
          if (input.path.absolute === value.target) targetWrites += 1;
          return service.atomicWrite(input);
        },
      }));
      const outcome = await recover(value, machine);

      expect(outcome.outcome, JSON.stringify(outcome)).toBe("Converged");
      expect(await readFile(value.target, "utf8")).toBe("canonical content");
      expect(targetWrites).toBe(state === "succeeded" ? 0 : mutated ? 2 : 1);
    },
  );

  it("resumes actions in stable order without repeating verified terminals", async () => {
    const value = fixture(temporaryDirectory());
    const base = persistedPlan(value);
    const first = base.actions[0]!;
    const second = {
      ...first,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [first.id],
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [first, second],
      agentTasks: base.agentTasks,
    };
    const encoded = canonicalJson(
      Schema.decodeUnknownSync(Schema.MutableJson)(body),
    );
    const plan = {
      ...base,
      actions: [first, second],
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    await journal(value, first.id, "running");
    await journal(value, first.id, "succeeded");

    const outcome = await recover(value);
    const rows = runRows(value);

    expect(outcome.outcome).toBe("Converged");
    expect(rows.map((row) => [row.action_id, row.state])).toEqual([
      [first.id, "pending"],
      [second.id, "pending"],
      [first.id, "running"],
      [first.id, "succeeded"],
      [second.id, "running"],
      [second.id, "succeeded"],
    ]);
  });

  it("rolls back a reverified action when a later resumed action fails", async () => {
    const value = fixture(temporaryDirectory());
    const base = persistedPlan(value);
    const first = base.actions[0]!;
    const second = {
      ...first,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [first.id],
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [first, second],
      agentTasks: base.agentTasks,
    };
    const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
    const plan = {
      ...base,
      actions: [first, second],
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    chmodSync(value.target, 0o600);
    const resource = value.revision.resources[0]!;
    const previousApplied = {
      resource: resource.id,
      revision: value.revision.id,
      digest: decode(ContentDigest)(sha256Hex("previous")),
      appliedAt: "2026-08-15T00:00:59Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: value.target,
      executable: false,
      mode: 0o600,
    };
    const currentApplied = {
      ...previousApplied,
      digest: decode(ContentDigest)(value.artifact.digest),
      appliedAt: "2026-08-15T00:02:00Z",
    };
    const reference = writeRollbackPayload(value, first.id, {
      path: value.target,
      state: "regular",
      content: Buffer.from("previous"),
      mode: 0o600,
    });
    await journal(value, first.id, "running", reference);
    await journal(value, first.id, "succeeded", reference, {
      appliedResource: currentApplied,
      removedResourceRecord: previousApplied,
    });

    let targetWrites = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== value.target) return service.atomicWrite(input);
        targetWrites += 1;
        return targetWrites === 1
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test recovery write",
            path: input.path.absolute,
            message: "injected later-action failure",
          })
          : service.atomicWrite(input);
      },
    }));

    const outcome = await recover(value, machine);

    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(value.target, "utf8")).toBe("previous");
    expect(targetWrites).toBe(3);
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(applied).toEqual([previousApplied]);
  });

  it("rolls back ownership for a completed no-op without rollback material", async () => {
    const value = fixture(temporaryDirectory());
    const base = persistedPlan(value);
    const first = base.actions[0]!;
    const second = {
      ...first,
      id: decode(ActionId)("action:settings:second:write-file"),
      before: [first.id],
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [first, second],
      agentTasks: base.agentTasks,
    };
    const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
    const plan = {
      ...base,
      actions: body.actions,
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    const resource = value.revision.resources[0]!;
    const currentApplied = {
      resource: resource.id,
      revision: value.revision.id,
      digest: decode(ContentDigest)(value.artifact.digest),
      appliedAt: "2026-08-15T00:02:00Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: value.target,
      executable: false,
    };
    await journal(value, first.id, "running");
    await journal(value, first.id, "succeeded", undefined, {
      appliedResource: currentApplied,
    });

    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => input.path.absolute === value.target
        ? Effect.fail({
          _tag: "MachineFilesystemError",
          operation: "test later recovery action",
          path: input.path.absolute,
          message: "injected later-action failure",
        })
        : service.atomicWrite(input),
    }));

    const outcome = await recover(value, machine);

    expect(outcome.outcome).toBe("Failed");
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(applied).toEqual([]);
  });

  it("preserves ownership that a completed agent action did not change", async () => {
    const value = fixture(temporaryDirectory());
    const base = persistedPlan(value);
    const resource = value.revision.resources[0]!;
    const agentAction = {
      id: decode(ActionId)("action:settings:agent-task"),
      resource: resource.id,
      kind: "agent-task" as const,
      detail: {
        kind: "agent-task" as const,
        taskId: decode(AgentTaskId)("agent:settings:1"),
        summary: "Verify settings",
      },
      before: [],
    };
    const agentTask = {
      id: agentAction.detail.taskId,
      resource: resource.id,
      summary: "Verify settings",
      desiredOutcome: "Keep canonical settings",
      observedEvidence: ["Settings already match"],
      allowedPaths: [value.target],
      allowedExecutables: [],
      executableAuthorizations: [],
      allowedOrigins: [],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 30,
      outputLimitBytes: 4096,
      verification: { command: [] },
    };
    const later = {
      ...base.actions[0]!,
      id: decode(ActionId)("action:settings:later-write"),
      before: [agentAction.id],
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [agentAction, later],
      agentTasks: [agentTask],
    };
    const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
    const plan = {
      ...base,
      actions: body.actions,
      agentTasks: body.agentTasks,
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    const previousApplied = {
      resource: resource.id,
      revision: value.revision.id,
      digest: decode(ContentDigest)(value.artifact.digest),
      appliedAt: "2026-08-15T00:00:59Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: value.target,
      executable: false,
    };
    const database = new DatabaseSync(value.database);
    database.prepare(`
      INSERT INTO applied_resources (
        follower_id, resource_id, revision_id, digest, applied_at,
        kind, policy, target, executable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      follower.id,
      previousApplied.resource,
      previousApplied.revision,
      previousApplied.digest,
      previousApplied.appliedAt,
      previousApplied.kind,
      previousApplied.policy,
      previousApplied.target,
      0,
    );
    database.close();
    await journal(value, agentAction.id, "running");
    await journal(value, agentAction.id, "succeeded");

    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => input.path.absolute === value.target
        ? Effect.fail({
          _tag: "MachineFilesystemError",
          operation: "test later recovery action",
          path: input.path.absolute,
          message: "injected later-action failure",
        })
        : service.atomicWrite(input),
    }));

    const outcome = await recover(value, machine);

    expect(outcome.outcome).toBe("Failed");
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(applied).toEqual([previousApplied]);
  });

  it("restores ownership when replaying a completed action fails", async () => {
    const value = fixture(temporaryDirectory());
    const plan = persistedPlan(value);
    const action = plan.actions[0]!;
    const resource = value.revision.resources[0]!;
    const previousApplied = {
      resource: resource.id,
      revision: value.revision.id,
      digest: decode(ContentDigest)(sha256Hex("previous")),
      appliedAt: "2026-08-15T00:00:59Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: value.target,
      executable: false,
      mode: 0o600,
    };
    const currentApplied = {
      ...previousApplied,
      digest: decode(ContentDigest)(value.artifact.digest),
      appliedAt: "2026-08-15T00:02:00Z",
    };
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    const reference = writeRollbackPayload(value, action.id, {
      path: value.target,
      state: "regular",
      content: Buffer.from("previous"),
      mode: 0o600,
    });
    await journal(value, action.id, "running", reference);
    await journal(value, action.id, "succeeded", reference, {
      appliedResource: currentApplied,
      removedResourceRecord: previousApplied,
    });
    writeFileSync(value.target, "drifted after the recorded success");

    let targetWrites = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== value.target) return service.atomicWrite(input);
        targetWrites += 1;
        return targetWrites === 2
          ? Effect.fail({
            _tag: "MachineFilesystemError",
            operation: "test recovery replay",
            path: input.path.absolute,
            message: "injected replay failure",
          })
          : service.atomicWrite(input);
      },
    }));

    const outcome = await recover(value, machine);

    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(value.target, "utf8")).toBe("previous");
    expect(targetWrites).toBe(3);
    const applied = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(applied).toEqual([previousApplied]);
  });

  it("accepts a completed rollback after an earlier action succeeded", async () => {
    const value = fixture(temporaryDirectory());
    const plan = persistedPlan(value);
    const action = plan.actions[0]!;
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, "previous");
    const reference = rollbackReference(value, action.id, "previous");
    await journal(value, action.id, "running", reference);
    await journal(value, action.id, "succeeded", reference);
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: action.id,
          state: "failed",
          recordedAt: "2026-08-15T00:02:01Z",
          attempt: 1,
          verification: { status: "not-run", method: "run-rolled-back" },
          rollbackReference: reference,
        })
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );

    const outcome = await recover(value);

    expect(outcome.outcome).toBe("Converged");
    expect(await readFile(value.target, "utf8")).toBe("canonical content");
  });

  it("accepts an interrupted recovery after rollback and retry", async () => {
    const value = fixture(temporaryDirectory());
    const plan = persistedPlan(value);
    const action = plan.actions[0]!;
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    const reference = rollbackReference(value, action.id, "previous");
    await journal(value, action.id, "running", reference, {}, 1);
    await journal(value, action.id, "succeeded", reference, {}, 1);
    await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: action.id,
          state: "failed",
          recordedAt: "2026-08-15T00:02:01Z",
          attempt: 2,
          verification: { status: "not-run", method: "run-rolled-back" },
          rollbackReference: reference,
        })
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    await journal(value, action.id, "running", reference, {}, 3);
    await journal(value, action.id, "succeeded", reference, {}, 3);
    await interruptRun(value);

    const outcome = await recover(value);

    expect(outcome.outcome).toBe("Converged");
    expect(await readFile(value.target, "utf8")).toBe("canonical content");
  });

  it("preserves executable execution-model metadata across persisted plan hydration", async () => {
    const value = fixture(temporaryDirectory(), { kind: "tool" });
    const base = persistedPlan(value);
    const agentAction = {
      id: decode(ActionId)("action:tool:1:agent-task"),
      resource: value.revision.resources[0]!.id,
      kind: "agent-task" as const,
      detail: {
        kind: "agent-task" as const,
        taskId: decode(AgentTaskId)("agent:tool:1"),
        summary: "Resolve tool",
      },
      before: [],
    };
    const agentTask = {
      id: decode(AgentTaskId)("agent:tool:1"),
      resource: value.revision.resources[0]!.id,
      summary: "Resolve tool",
      desiredOutcome: "Make the tool available",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["~/.canonfig/tool"],
      allowedExecutables: ["custom-tool"],
      executableAuthorizations: [{
        executable: "custom-tool",
        behavior: "leaf" as const,
      }],
      allowedOrigins: [],
      forbidden: ["elevation", "login", "restart", "reboot"] as const,
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
      verification: { command: ["custom-tool", "--version"] },
    };
    const body = {
      revision: base.revision,
      follower: base.follower,
      requiredBlobs: base.requiredBlobs,
      actions: [agentAction],
      agentTasks: [agentTask],
    };
    const encoded = canonicalJson(
      Schema.decodeUnknownSync(Schema.MutableJson)(body),
    );
    const plan = {
      ...base,
      actions: body.actions,
      agentTasks: [agentTask],
      encoded,
      digest: sha256Hex(encoded),
    };
    await seed(value, plan);

    // Recovery hydrates the persisted plan; the agent task action routes to
    // Human Action Required without losing its recorded execution models.
    const outcome = await recover(value);
    expect(outcome.outcome).toBe("HumanActionRequired");
    if (outcome.outcome !== "HumanActionRequired") return;
    expect(outcome.actions).toHaveLength(1);
    const database = new DatabaseSync(value.database, { readOnly: true });
    const row = database.prepare(
      "SELECT plan_json FROM synchronization_runs WHERE id = ?",
    ).get("run-recovery");
    database.close();
    const persisted = JSON.parse(String(row?.plan_json));
    expect(persisted.agentTasks[0].executableAuthorizations).toEqual([{
      executable: "custom-tool",
      behavior: "leaf",
    }]);
  });

  it("fails safely on malformed persisted plan data", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    const database = new DatabaseSync(value.database);
    database.prepare(
      "UPDATE synchronization_runs SET plan_json = ? WHERE id = ?",
    ).run('{"actions":', "run-recovery");
    database.close();

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const synchronization = yield* Synchronization;
        return yield* Effect.flip(synchronization.recover(value.recovery));
      }).pipe(Effect.provide(applicationLayer(value))),
    );
    expect(error).toBeInstanceOf(RepositoryDecodeError);
  });

  it("rejects a hydrated revision that does not match the recorded revision", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    const mismatched = {
      ...value.recovery,
      revision: {
        ...value.revision,
        signature: "different-signature",
      },
    };

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const synchronization = yield* Synchronization;
        return yield* Effect.flip(synchronization.recover(mismatched));
      }).pipe(Effect.provide(applicationLayer(value))),
    );
    expect(error).toBeInstanceOf(RecoveryIntegrityError);
  });

  it("independently verifies an uncertain installer without rerunning it", async () => {
    const value = fixture(temporaryDirectory(), {
      kind: "tool",
      version: "14.1.0",
    });
    const plan = persistedPlan(value);
    expect(plan.actions[0]?.detail).toMatchObject({ version: "14.1.0" });
    await seed(value, plan);
    await journal(value, plan.actions[0]!.id, "running");
    const bin = join(value.root, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, "rg");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    let processes = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      runProcess: (input) => {
        processes += 1;
        return service.runProcess(input);
      },
    }));

    const outcome = await recover(value, machine);
    expect(outcome.outcome).toBe("Converged");
    expect(processes).toBe(0);
    expect(runRows(value).at(-1)?.rollback_reference).toBeNull();
  });

  it("requires human action when uncertain installer evidence stays ambiguous", async () => {
    const value = fixture(temporaryDirectory(), { kind: "tool" });
    const plan = persistedPlan(value);
    await seed(value, plan);
    await journal(value, plan.actions[0]!.id, "running");
    const bin = join(value.root, "bin");
    mkdirSync(bin, { recursive: true });
    const installer = join(bin, "apt-get");
    writeFileSync(installer, "#!/bin/sh\nexit 0\n");
    chmodSync(installer, 0o755);
    let processes = 0;
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      runProcess: (input) => {
        processes += 1;
        return service.runProcess(input);
      },
    }));

    const outcome = await recover(value, machine);
    expect(outcome.outcome).toBe("HumanActionRequired");
    expect(processes).toBe(0);
    expect(runRows(value).at(-1)?.state).toBe("skipped");
    expect(runRows(value).at(-1)?.rollback_reference).toBeNull();
  });

  it("restores owned-file rollback material before retrying an interrupted mutation", async () => {
    const value = fixture(temporaryDirectory());
    const plan = persistedPlan(value);
    await seed(value, plan);
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, "corrupt partial write");
    const reference = rollbackReference(value, plan.actions[0]!.id, "previous");
    await journal(value, plan.actions[0]!.id, "running", reference);
    await interruptRun(value);
    const writes: Array<string> = [];
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) =>
        service.atomicWrite(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (input.path.absolute === value.target) {
                writes.push(readFileSync(value.target, "utf8"));
              }
            })
          ),
        ),
    }));

    await recover(value, machine);
    expect(writes).toEqual(["previous", "canonical content"]);
  });

  it("does not resurrect a removed resource after restart recovery", async () => {
    const value = fixture(temporaryDirectory());
    const resource = value.revision.resources[0]!;
    const removedRevision: PlanningProfileRevision = {
      ...value.revision,
      id: decode(ProfileRevisionId)("revision-recovery-removed"),
      sequence: 2,
      canonicalBytes: "{\"removed\":true}",
      digest: decode(ContentDigest)(sha256Hex("{\"removed\":true}")),
      resources: [resource],
      removedResources: [resource.id],
    };
    const plan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "present",
            digest: decode(ContentDigest)(value.artifact.digest),
            executable: false,
            mode: 0o600,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [{
        resource: resource.id,
        revision: value.revision.id,
        digest: decode(ContentDigest)(value.artifact.digest),
        appliedAt: "2026-08-15T00:00:59Z",
        kind: "file",
        policy: "replace",
        target: value.target,
        executable: false,
      }],
    }));
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    chmodSync(value.target, 0o600);
    const reference = writeRollbackPayload(value, plan.actions[0]!.id, {
      path: value.target,
      state: "regular",
      content: value.artifact.content,
      mode: 0o600,
    });

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.registerFollower({ follower });
        yield* repository.publishRevision({ revision: value.revision });
        yield* repository.publishRevision({
          revision: { ...removedRevision, resources: [] },
        });
        const applied = {
          resource: resource.id,
          revision: value.revision.id,
          digest: decode(ContentDigest)(value.artifact.digest),
          appliedAt: "2026-08-15T00:00:59Z",
          kind: "file" as const,
          policy: "replace" as const,
          target: value.target,
          executable: false,
        };
        const database = new DatabaseSync(value.database);
        database.prepare(`
          INSERT INTO applied_resources (
            follower_id, resource_id, revision_id, digest, applied_at,
            kind, policy, target, executable
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          follower.id,
          applied.resource,
          applied.revision,
          applied.digest,
          applied.appliedAt,
          applied.kind,
          applied.policy,
          applied.target,
          0,
        );
        database.close();
        yield* repository.startRun({
          id: decode(RunId)("run-recovery"),
          follower: follower.id,
          revision: removedRevision.id,
          plan,
          startedAt: "2026-08-15T00:01:00Z",
        });
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: plan.actions[0]!.id,
          state: "running",
          recordedAt: "2026-08-15T00:01:01Z",
          attempt: 1,
          rollbackReference: reference,
        });
        rmSync(value.target);
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: plan.actions[0]!.id,
          state: "succeeded",
          recordedAt: "2026-08-15T00:01:02Z",
          attempt: 1,
          verification: {
            status: "passed",
            method: "owned-resource-removed",
          },
          rollbackReference: reference,
          removedResource: resource.id,
          removedResourceRecord: applied,
        });
        const synchronization = yield* Synchronization;
        return yield* synchronization.recover({
          follower: follower.id,
          revision: removedRevision,
          artifacts: [value.artifact],
        });
      }).pipe(Effect.provide(applicationLayer(value))),
    );

    expect(outcome.outcome).toBe("Converged");
    await expect(readFile(value.target)).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(loaded).toEqual([]);
  });

  it("restores a completed removal when a later recovered action fails", async () => {
    const value = fixture(temporaryDirectory());
    const resource = value.revision.resources[0]!;
    const removedRevision: PlanningProfileRevision = {
      ...value.revision,
      id: decode(ProfileRevisionId)("revision-recovery-removal-rollback"),
      sequence: 2,
      canonicalBytes: "{\"removed\":true}",
      digest: decode(ContentDigest)(sha256Hex("{\"removed\":true}")),
      removedResources: [resource.id],
    };
    const applied = {
      resource: resource.id,
      revision: value.revision.id,
      digest: decode(ContentDigest)(value.artifact.digest),
      appliedAt: "2026-08-15T00:00:59Z",
      kind: "file" as const,
      policy: "replace" as const,
      target: value.target,
      executable: false,
      mode: 0o600,
    };
    const removalPlan = Effect.runSync(planSynchronization({
      revision: removedRevision,
      follower: follower.id,
      observedState: {
        platform: "linux",
        resources: [{
          resource: resource.id,
          observed: {
            state: "present",
            digest: decode(ContentDigest)(value.artifact.digest),
            executable: false,
            mode: 0o600,
          },
        }],
        availableBlobs: [],
      },
      localOverlay: [],
      appliedResources: [applied],
    }));
    const removal = removalPlan.actions[0]!;
    // Any action that fails after the removal will do. This used to be a
    // schedule-default action; a write whose artifact is absent fails the same
    // way without depending on a resource kind.
    const failing = {
      id: decode(ActionId)("action:removed-file:1:transfer-blob"),
      resource: resource.id,
      kind: "transfer-blob" as const,
      detail: {
        kind: "transfer-blob" as const,
        blob: "f".repeat(64),
        bytes: 1,
      },
      before: [removal.id],
    };
    const body = {
      revision: removalPlan.revision,
      follower: removalPlan.follower,
      requiredBlobs: removalPlan.requiredBlobs,
      actions: [removal, failing],
      agentTasks: removalPlan.agentTasks,
    };
    const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(body));
    const plan = {
      ...removalPlan,
      actions: body.actions,
      encoded,
      digest: sha256Hex(encoded),
    };
    mkdirSync(dirname(value.target), { recursive: true });
    writeFileSync(value.target, value.artifact.content);
    chmodSync(value.target, 0o600);
    const reference = writeRollbackPayload(value, removal.id, {
      path: value.target,
      state: "regular",
      content: value.artifact.content,
      mode: 0o600,
    });

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* StateRepository;
        yield* repository.registerFollower({ follower });
        yield* repository.publishRevision({ revision: value.revision });
        yield* repository.publishRevision({
          revision: { ...removedRevision, resources: [] },
        });
        const database = new DatabaseSync(value.database);
        database.prepare(`
          INSERT INTO applied_resources (
            follower_id, resource_id, revision_id, digest, applied_at,
            kind, policy, target, executable, mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          follower.id,
          applied.resource,
          applied.revision,
          applied.digest,
          applied.appliedAt,
          applied.kind,
          applied.policy,
          applied.target,
          0,
          applied.mode,
        );
        database.close();
        yield* repository.startRun({
          id: decode(RunId)("run-recovery"),
          follower: follower.id,
          revision: removedRevision.id,
          plan,
          startedAt: "2026-08-15T00:01:00Z",
        });
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: removal.id,
          state: "running",
          recordedAt: "2026-08-15T00:01:01Z",
          attempt: 1,
          rollbackReference: reference,
        });
        rmSync(value.target);
        yield* repository.journalAction({
          run: decode(RunId)("run-recovery"),
          action: removal.id,
          state: "succeeded",
          recordedAt: "2026-08-15T00:01:02Z",
          attempt: 1,
          verification: { status: "passed", method: "owned-resource-removed" },
          rollbackReference: reference,
          removedResource: resource.id,
          removedResourceRecord: applied,
        });
      }).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    const removedValue: Fixture = {
      ...value,
      revision: removedRevision,
      recovery: {
        follower: follower.id,
        revision: removedRevision,
        artifacts: [value.artifact],
      },
    };

    const outcome = await recover(removedValue);

    expect(outcome.outcome).toBe("Failed");
    expect(await readFile(value.target, "utf8")).toBe("canonical content");
    const loaded = await Effect.runPromise(
      Effect.flatMap(StateRepository, (repository) =>
        repository.loadAppliedResources(follower.id)
      ).pipe(Effect.provide(stateRepositoryLayer(value.database))),
    );
    expect(loaded).toEqual([applied]);
  });

  it.each([
    [
      "absent",
      (value: Fixture) => ({ path: value.target, state: "absent" }),
      (_value: Fixture) => ["remove", "write:canonical content:384"],
    ],
    [
      "directory",
      (value: Fixture) => ({
        path: value.target,
        state: "directory",
        mode: 0o750,
      }),
      (_value: Fixture) => ["remove", "directory:488", "write:canonical content:384"],
    ],
    [
      "regular",
      (value: Fixture) => ({
        path: value.target,
        state: "regular",
        content: Buffer.from("regular"),
        mode: 0o600,
      }),
      (_value: Fixture) => ["write:regular:384", "write:canonical content:384"],
    ],
    [
      "executable",
      (value: Fixture) => ({
        path: value.target,
        state: "regular",
        content: Buffer.from("executable"),
        mode: 0o700,
      }),
      (_value: Fixture) => ["write:executable:448", "write:canonical content:384"],
    ],
    [
      "symlink",
      (value: Fixture) => ({
        path: value.target,
        state: "symlink",
        target: join(value.root, "original-target"),
      }),
      (value: Fixture) => [
        `symlink:${join(value.root, "original-target")}`,
        "write:canonical content:384",
      ],
    ],
  ] as const)(
    "restores persisted %s state before retrying",
    async (_state, payload, expectedOperations) => {
      const value = fixture(temporaryDirectory());
      const plan = persistedPlan(value);
      await seed(value, plan);
      mkdirSync(dirname(value.target), { recursive: true });
      writeFileSync(value.target, "corrupt partial write");
      const reference = writeRollbackPayload(value, plan.actions[0]!.id, payload(value));
      await journal(value, plan.actions[0]!.id, "running", reference);
      const operations: Array<string> = [];
      const machine = decorateMachine(value.root, (service) => ({
        ...service,
        atomicWrite: (input) => {
          return service.atomicWrite(input).pipe(Effect.tap(() => Effect.sync(() => {
            if (input.path.absolute === value.target) {
              operations.push(`write:${readFileSync(value.target, "utf8")}:${String(input.mode)}`);
            }
          })));
        },
        removeFile: (input) => {
          if (input.path.absolute === value.target) operations.push("remove");
          return service.removeFile(input);
        },
        ensureDirectory: (input) => {
          if (input.path.absolute === value.target) {
            operations.push(`directory:${String(input.mode)}`);
          }
          return service.ensureDirectory(input);
        },
        replaceSymlink: (input) => {
          if (input.path.absolute === value.target) {
            operations.push(`symlink:${input.target}`);
          }
          return service.replaceSymlink(input);
        },
      }));

      const outcome = await recover(value, machine);

      expect(outcome.outcome, JSON.stringify(outcome)).toBe("Converged");
      expect(operations).toEqual(expectedOperations(value));
    },
  );

  it("preserves Interrupted when cancellation reaches resumed mutation", async () => {
    const value = fixture(temporaryDirectory());
    await seed(value);
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const machine = decorateMachine(value.root, (service) => ({
      ...service,
      atomicWrite: (input) => {
        if (input.path.absolute !== value.target) return service.atomicWrite(input);
        notifyStarted?.();
        return Effect.never;
      },
    }));
    const program = Effect.gen(function*() {
      const synchronization = yield* Synchronization;
      return yield* synchronization.recover(value.recovery);
    }).pipe(Effect.provide(applicationLayer(value, machine)));
    const fiber = Effect.runFork(program);
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const database = new DatabaseSync(value.database, { readOnly: true });
    const row = database.prepare(
      "SELECT status FROM synchronization_runs WHERE id = ?",
    ).get("run-recovery");
    database.close();
    expect(row?.status).toBe("Interrupted");
  });
});
