import { Clock, Effect, Option, Schema } from "effect";

import {
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  ResourceId,
  type ActionId,
} from "../domain/brand.ts";
import type { PublishedResource } from "../domain/profile.ts";
import type {
  AppliedResourceRecord,
  DriftConflict,
  HumanAction,
  PlannedAction,
  SynchronizationOutcome,
} from "../domain/synchronization.ts";
import type { MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import {
  desiredDirectoryEntries,
  desiredResourceDigest,
} from "./resource-plans.ts";
import {
  prepareResourceAction,
  verifyResource,
  type PreparedResourceAction,
  type ResourceExecutionContext,
} from "./resource-executors.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import type { ScheduleManagerError } from "../schedule/schedule-manager.errors.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type { VerificationEvidence } from "../state/state-repository.types.ts";
import {
  InvalidExecutionPlanError,
  MissingExecutionResourceError,
  type SynchronizationExecutionInputError,
} from "./synchronization.errors.ts";
import type {
  SynchronizationExecutionLimits,
  SynchronizationRunInput,
} from "./synchronization.types.ts";

export const defaultSynchronizationExecutionLimits: SynchronizationExecutionLimits = {
  maximumFileBytes: 16 * 1024 * 1024,
  processTimeoutMilliseconds: 10 * 60 * 1000,
  maximumProcessOutputBytes: 1024 * 1024,
  verificationConcurrency: 4,
};

export interface SynchronizationExecutionResult {
  readonly outcome: SynchronizationOutcome;
  readonly appliedResources: ReadonlyArray<AppliedResourceRecord>;
  readonly removedResources: ReadonlyArray<ResourceId>;
  readonly failedRollbacks: ReadonlyArray<ActionId>;
}

export interface ActionState {
  readonly action: PlannedAction;
  readonly context: ResourceExecutionContext;
}

const now = (): Effect.Effect<string> =>
  Effect.map(Clock.currentTimeMillis, (milliseconds) =>
    new Date(milliseconds).toISOString()
  );

const redact = (
  value:
    | Error
    | MachineStateError
    | ScheduleManagerError
    | StateRepositoryError
    | SynchronizationExecutionInputError,
  secrets: ReadonlyArray<string>,
): string => {
  let message = value instanceof Error
    ? value.message || value.constructor.name
    : String(value);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.slice(0, 2048);
};

export const executionLimits = (
  input: SynchronizationRunInput,
): SynchronizationExecutionLimits => ({
  ...defaultSynchronizationExecutionLimits,
  ...input.limits,
});

/**
 * Remove only the rollback files derived from this immutable run/action set.
 * The exact paths make cleanup idempotent and prevent a terminal run from
 * touching another run's material. Cleanup is intentionally separate from
 * repository completion so a cleanup failure cannot erase the primary
 * terminal outcome. Failed inverses keep their own snapshots for manual
 * recovery; unrelated snapshots are still cleaned up.
 */
export const cleanupRollbackSnapshots = (
  run: SynchronizationRunInput["id"],
  actions: ReadonlyArray<ActionId>,
  failedRollbacks: ReadonlyArray<ActionId>,
): Effect.Effect<void, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const directory = yield* machine.normalizePath({
      path: `canonfig/rollback/${run}`,
      base: directories.cache,
    });
    const retained = new Set(failedRollbacks);
    const disposable = new Set<string>(actions.filter((action) => !retained.has(action)).map(sha256Hex));
    const references = [...disposable].flatMap((action) => [
      `${action}.json`,
      `${action}.schedule.json`,
    ]);
    const entries = yield* machine.listDirectory(directory);
    for (const entry of entries) {
      const ownedBackup = /^([a-f0-9]{64})\.json\.[a-f0-9]{64}\.bin$/u.exec(entry.path);
      if (ownedBackup?.[1] !== undefined && disposable.has(ownedBackup[1])) {
        references.push(entry.path);
      }
    }
    for (const reference of references) {
      const path = yield* machine.normalizePath({
        path: reference,
        base: directory,
      });
      yield* machine.removeFile({ path }).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message)
            ? Effect.void
            : Effect.fail(error)
        ),
      );
    }
    if (retained.size > 0) return;
    yield* machine.removeEmptyDirectory({ path: directory }).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message)
          ? Effect.void
          : Effect.fail(error)
      ),
    );
  });

const validateLimits = (
  limits: SynchronizationExecutionLimits,
): Effect.Effect<void, InvalidExecutionPlanError> => {
  if (
    !Number.isSafeInteger(limits.maximumFileBytes)
    || limits.maximumFileBytes <= 0
    || !Number.isSafeInteger(limits.processTimeoutMilliseconds)
    || limits.processTimeoutMilliseconds <= 0
    || !Number.isSafeInteger(limits.maximumProcessOutputBytes)
    || limits.maximumProcessOutputBytes < 0
    || !Number.isSafeInteger(limits.verificationConcurrency)
    || limits.verificationConcurrency <= 0
  ) {
    return Effect.fail(new InvalidExecutionPlanError({
      message: "execution limits must be positive safe integers",
    }));
  }
  return Effect.void;
};

const verificationCompatibleWithDesired = (
  kind: SynchronizationRunInput["revision"]["resources"][number]["kind"],
  desired: SynchronizationRunInput["revision"]["desired"][number]["desired"],
  method: SynchronizationRunInput["revision"]["desired"][number]["verification"]["method"],
): boolean => {
  if (kind === "file") {
    return desired.kind === "file"
      && (desired.symlinkTo === undefined ? method === "digest" : method === "symlink");
  }
  switch (kind) {
    case "directory":
    case "config":
    case "skill":
      return method === "digest" || method === "command";
    case "tool":
      return method === "executable-present" || method === "command";
    case "credential":
      return method === "credential-present" || method === "command";
  }
};

export const executionContexts = (
  input: SynchronizationRunInput,
  limits: SynchronizationExecutionLimits,
): Effect.Effect<ReadonlyArray<ActionState>, SynchronizationExecutionInputError> =>
  Effect.gen(function*() {
    yield* validateLimits(limits);
    const encodedBody = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
      JSON.parse(JSON.stringify({
        revision: input.plan.revision,
        follower: input.plan.follower,
        requiredBlobs: input.plan.requiredBlobs,
        actions: input.plan.actions,
        agentTasks: input.plan.agentTasks,
      })),
    ));
    if (
      input.plan.revision !== input.revision.id
      || input.plan.follower.length === 0
      || input.plan.digest !== sha256Hex(input.plan.encoded)
      || input.plan.encoded !== encodedBody
    ) {
      return yield* new InvalidExecutionPlanError({
        message: "plan identity or digest does not match its hydrated content",
      });
    }
    const resources = new Map(input.revision.resources.map((resource) => [
      resource.id,
      resource,
    ]));
    const desired = new Map(input.revision.desired.map((entry) => [
      entry.resource,
      entry,
    ]));
    const artifacts = new Map(input.artifacts.map((entry) => [
      entry.digest,
      entry,
    ]));
    const seen = new Set<string>();
    const completed = new Set<string>();
    const ordered: Array<ActionState> = [];
    const remaining = [...input.plan.actions];
    while (remaining.length > 0) {
      const index = remaining.findIndex((action) =>
        action.before.every((dependency) => completed.has(dependency))
      );
      if (index < 0) {
        return yield* new InvalidExecutionPlanError({
          message: "plan actions are cyclic or reference an unknown prerequisite",
        });
      }
      const action = remaining.splice(index, 1)[0]!;
      if (seen.has(action.id) || action.kind !== action.detail.kind) {
        return yield* new InvalidExecutionPlanError({
          message: `invalid or duplicate action ${action.id}`,
        });
      }
      const resource = resources.get(action.resource);
      const desiredEntry = desired.get(action.resource);
      if (resource === undefined || desiredEntry === undefined) {
        return yield* new MissingExecutionResourceError({
          resource: action.resource,
        });
      }
      if (
        !verificationCompatibleWithDesired(
          resource.kind,
          desiredEntry.desired,
          desiredEntry.verification.method,
        )
      ) {
        return yield* new InvalidExecutionPlanError({
          message:
            `verification method ${desiredEntry.verification.method} is incompatible with ${resource.kind} resource ${resource.id}`,
        });
      }
      if (
        action.detail.kind === "write-file"
        && (
          desiredEntry.desired.kind === "file"
            ? action.detail.executable !== desiredEntry.desired.executable
              || action.detail.mode !== desiredEntry.desired.mode
            : action.detail.executable !== undefined || action.detail.mode !== undefined
        )
      ) {
        return yield* new InvalidExecutionPlanError({
          message: `write-file executable intent does not match ${resource.id}`,
        });
      }
      seen.add(action.id);
      completed.add(action.id);
      ordered.push({
        action,
        context: {
          run: input.id,
          action,
          resource,
          desired: desiredEntry.desired,
          verification: desiredEntry.verification,
          artifacts,
          limits,
        },
      });
    }
    return ordered;
  });

const verificationEvidence = (
  result: {
    readonly passed: boolean;
    readonly method: string;
    readonly observedDigest?: string | undefined;
    readonly exitCode?: number | undefined;
  },
): VerificationEvidence => {
  const base = {
    status: result.passed ? "passed" as const : "failed" as const,
    method: result.method,
  };
  const withDigest = result.observedDigest === undefined
    ? base
    : {
      ...base,
      observedDigest: Schema.decodeUnknownSync(ContentDigest)(result.observedDigest),
    };
  return result.exitCode === undefined
    ? withDigest
    : { ...withDigest, exitCode: result.exitCode };
};

const journal = (
  run: SynchronizationRunInput["id"],
  action: ActionId,
  state: "running" | "succeeded" | "failed" | "skipped",
  verification?: VerificationEvidence | undefined,
  rollbackReference?: string | undefined,
  attempt = 1,
  appliedResource?: AppliedResourceRecord | undefined,
  removedResource?: ResourceId | undefined,
  removedResourceRecord?: AppliedResourceRecord | undefined,
) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const recordedAt = yield* now();
    const base = {
      run,
      action,
      state,
      recordedAt,
      attempt,
    };
    yield* repository.journalAction({
      ...base,
      verification,
      rollbackReference,
      appliedResource,
      removedResource,
      removedResourceRecord,
    });
  });

const rollbackPrepared = (
  prepared: PreparedResourceAction | undefined,
) => prepared?.rollback ?? Effect.void;

export const ownedFilesFor = (
  desired: SynchronizationRunInput["revision"]["desired"][number]["desired"],
): AppliedResourceRecord["ownedFiles"] =>
  desired.kind === "directory" || desired.kind === "skill"
    ? desiredDirectoryEntries(desired).map((entry) => ({
      path: entry.path,
      digest: entry.digest,
      executable: entry.executable,
      mode: entry.mode,
      objectKind: ("objectKind" in entry ? entry.objectKind : undefined)
        ?? ("symlinkTo" in entry && entry.symlinkTo !== undefined ? "symlink" : "regular"),
      symlinkTo: "symlinkTo" in entry ? entry.symlinkTo : undefined,
    }))
    : undefined;

const appliedResourceFor = (
  input: SynchronizationRunInput,
  state: ActionState,
  appliedAt: string,
): AppliedResourceRecord | undefined => {
  const desired = state.context.desired;
  const digest = desiredResourceDigest(desired);
  if (digest === undefined) return undefined;
  return {
    resource: state.action.resource,
    revision: input.revision.id,
    digest,
    appliedAt,
    kind: state.context.resource.kind,
    policy: state.context.resource.policy,
    target: state.context.resource.target,
    executable: desired.kind === "file" ? desired.executable : undefined,
    mode: desired.kind === "file" || desired.kind === "directory" || desired.kind === "skill"
      ? desired.mode
      : undefined,
    symlinkTo: desired.kind === "file" ? desired.symlinkTo : undefined,
    ownedFiles: ownedFilesFor(desired),
    ownedKeys: desired.kind === "config" ? desired.keys : undefined,
    configFormat: desired.kind === "config" ? desired.format : undefined,
  };
};

export interface ActionResult {
  readonly kind: "verified" | "human" | "drift" | "failed";
  readonly resource?: ResourceId | undefined;
  readonly human?: HumanAction | undefined;
  readonly drift?: DriftConflict | undefined;
  readonly reason?: string | undefined;
  /** Runtime inverse retained until physical and ownership changes are terminal. */
  readonly rollback?: Effect.Effect<void, unknown, MachineState> | undefined;
  readonly rollbackReference?: string | undefined;
  /** Physical rollback failed, so terminal cleanup must preserve its snapshot. */
  readonly rollbackFailed?: boolean | undefined;
}

export const driftResult = (
  input: SynchronizationRunInput,
  state: ActionState,
): ActionResult => {
  const detail = state.action.detail;
  if (detail.kind !== "drift-conflict") {
    return { kind: "failed", reason: "invalid drift action" };
  }
  const previous = input.appliedResources?.find((record) =>
    record.resource === state.action.resource
  );
  return {
    kind: "drift",
    drift: {
      resource: state.action.resource,
      target: detail.target,
      desiredDigest: detail.desiredDigest,
      observedDigest: detail.observedDigest,
      lastAppliedDigest: previous?.digest ?? detail.desiredDigest,
      desiredExecutable: detail.desiredExecutable,
      observedExecutable: detail.observedExecutable,
      // Carried through so a mode-only conflict says which modes differ
      // instead of showing two identical digests.
      desiredMode: detail.desiredMode,
      observedMode: detail.observedMode,
    },
  };
};


const agentActionResult = (
  input: SynchronizationRunInput,
  state: ActionState,
  attempt = 1,
): Effect.Effect<ActionResult, never, StateRepository | MachineState> =>
  Effect.gen(function*() {
    const detail = state.action.detail;
    if (detail.kind !== "agent-task") {
      return { kind: "failed", reason: "invalid agent action" } satisfies ActionResult;
    }
    const task = input.plan.agentTasks.find((candidate) =>
      candidate.id === detail.taskId
    );
    const agent = input.agent;
    const resolution = input.agentResolution;
    if (
      task === undefined
      || agent?.policy !== "agent-apply"
      || agent.harness === undefined
      || resolution === undefined
    ) {
      yield* journal(
        input.id,
        state.action.id,
        "skipped",
        undefined,
        undefined,
        attempt,
      );
      return {
        kind: "human",
        human: {
          reason: `Bounded agent task requires an apply-authorized harness: ${detail.summary}`,
          instructions:
            "Configure an agent-apply harness, or resolve the task manually, then rerun synchronization.",
          resource: state.action.resource,
        },
      } satisfies ActionResult;
    }

    yield* journal(
      input.id,
      state.action.id,
      "running",
      undefined,
      undefined,
      attempt,
    );
    const outcome = yield* resolution.resolve({
      policy: agent.policy,
      task,
      harness: agent.harness,
      scheduled: agent.scheduled,
      signal: agent.signal,
    });
    if (outcome.outcome !== "applied") {
      yield* journal(
        input.id,
        state.action.id,
        "skipped",
        undefined,
        undefined,
        attempt,
      );
      return {
        kind: "human",
        human: {
          reason: `Agent did not apply the requested task: ${detail.summary}`,
          instructions:
            "Review the agent proposal or complete the task manually, then rerun synchronization.",
          resource: state.action.resource,
        },
      } satisfies ActionResult;
    }

    const verification = yield* verifyResource(state.context);
    const evidence = verificationEvidence(verification);
    if (!verification.passed) {
      yield* journal(
        input.id,
        state.action.id,
        "failed",
        evidence,
        undefined,
        attempt,
      );
      return {
        kind: "failed",
        reason: `verification failed for agent task ${state.action.resource}`,
      } satisfies ActionResult;
    }
    yield* journal(
      input.id,
      state.action.id,
      "succeeded",
      evidence,
      undefined,
      attempt,
    );
    return {
      kind: "verified",
      resource: state.action.resource,
    } satisfies ActionResult;
  }).pipe(
    Effect.onInterrupt(() =>
      journal(
        input.id,
        state.action.id,
        "failed",
        { status: "not-run", method: "interrupted" },
        undefined,
        attempt,
      ).pipe(Effect.ignore)
    ),
    Effect.catch((error) =>
      journal(
        input.id,
        state.action.id,
        "failed",
        { status: "not-run", method: "action-failed" },
        undefined,
        attempt,
      ).pipe(
        Effect.ignore,
        // A refusal by the bounds, a timeout, an output-limit overrun or
        // unusable output is work a person has to finish, like every other
        // "a person must do this" case. It used to end the run Failed and roll
        // back every action before it, which punished the rest of the profile
        // for the harness declining one task, and the harness declining is a
        // normal outcome rather than a broken run.
        Effect.andThen(Effect.succeed({
          kind: "human",
          human: {
            reason: `The configured agent harness could not resolve the task: ${
              redact(error, input.knownSecrets ?? [])
            }`,
            instructions:
              "Resolve the task manually or adjust the agent harness bounds, then run synchronization again.",
            resource: state.action.resource,
          },
        } satisfies ActionResult)),
      )
    ),
  );

export const executeSynchronizationAction = (
  input: SynchronizationRunInput,
  state: ActionState,
  attempt = 1,
): Effect.Effect<ActionResult, never, StateRepository | MachineState> =>
  Effect.gen(function*() {
    const detail = state.action.detail;
    if (detail.kind === "human-action") {
      yield* journal(input.id, state.action.id, "skipped", undefined, undefined, attempt);
      return {
        kind: "human",
        human: {
          reason: detail.reason,
          instructions: detail.instructions,
          resource: state.action.resource,
        },
      } satisfies ActionResult;
    }
    if (detail.kind === "agent-task") {
      return yield* agentActionResult(input, state, attempt);
    }
    if (detail.kind === "drift-conflict") {
      const result = driftResult(input, state);
      if (result.drift !== undefined) {
        const repository = yield* StateRepository;
        yield* repository.recordDrift({
          run: input.id,
          conflict: result.drift,
          recordedAt: yield* now(),
        });
      }
      yield* journal(input.id, state.action.id, "skipped", undefined, undefined, attempt);
      return result;
    }

    let prepared: PreparedResourceAction | undefined;
    const work = Effect.gen(function*() {
      prepared = yield* prepareResourceAction(state.context);
      yield* journal(
        input.id,
        state.action.id,
        "running",
        undefined,
        prepared.rollbackReference,
        attempt,
      );
      yield* prepared.execute;
      if (detail.kind === "transfer-blob") {
        yield* journal(
          input.id,
          state.action.id,
          "succeeded",
          { status: "passed", method: "sha256-and-size" },
          prepared.rollbackReference,
          attempt,
        );
        return {
          kind: "verified",
          rollback: prepared.rollback,
          rollbackReference: prepared.rollbackReference,
        } satisfies ActionResult;
      }
      if (detail.kind === "remove-resource") {
        const removedResourceRecord = input.appliedResources?.find((record) =>
          record.resource === state.action.resource
        );
        yield* journal(
          input.id,
          state.action.id,
          "succeeded",
          { status: "passed", method: "owned-resource-removed" },
          prepared.rollbackReference,
          attempt,
          undefined,
          state.action.resource,
          removedResourceRecord,
        );
        return {
          kind: "verified",
          resource: state.action.resource,
          rollback: prepared.rollback ?? Effect.void,
          rollbackReference: prepared.rollbackReference,
        } satisfies ActionResult;
      }
      const verification = yield* verifyResource(state.context);
      const evidence = verificationEvidence(verification);
      if (!verification.passed) {
        yield* rollbackPrepared(prepared);
        yield* journal(
          input.id,
          state.action.id,
          "failed",
          evidence,
          prepared.rollbackReference,
          attempt,
        );
        return {
          kind: "failed",
          reason: `verification failed for resource ${state.action.resource}`,
        } satisfies ActionResult;
      }
      const appliedResource = appliedResourceFor(input, state, yield* now());
      const previousAppliedResource = input.appliedResources?.find((record) =>
        record.resource === state.action.resource
      );
      yield* journal(
        input.id,
        state.action.id,
        "succeeded",
        evidence,
        prepared.rollbackReference,
        attempt,
        appliedResource,
        undefined,
        previousAppliedResource,
      );
      return {
        kind: "verified",
        resource: state.action.resource,
        rollback: prepared.rollback
          ?? (appliedResource === undefined ? undefined : Effect.void),
        rollbackReference: prepared.rollbackReference,
      } satisfies ActionResult;
    }).pipe(
      Effect.onInterrupt(() =>
        rollbackPrepared(prepared).pipe(
          Effect.andThen(journal(
            input.id,
            state.action.id,
            "failed",
            { status: "not-run", method: "interrupted" },
            prepared?.rollbackReference,
            attempt,
          )),
          Effect.ignore,
        )
      ),
    );
    return yield* work.pipe(
      Effect.catch((error) =>
        rollbackPrepared(prepared).pipe(
          Effect.match({
            onSuccess: (): ActionResult => ({
              kind: "failed", reason: redact(error, input.knownSecrets ?? []),
            }),
            onFailure: (rollbackError): ActionResult => ({
              kind: "failed", reason: redact(rollbackError, input.knownSecrets ?? []),
              rollbackFailed: true, rollbackReference: prepared?.rollbackReference,
            }),
          }),
          Effect.flatMap((failure) => journal(
            input.id, state.action.id, "failed",
            { status: "not-run", method: "action-failed" },
            prepared?.rollbackReference, attempt,
          ).pipe(
            Effect.as(failure),
            Effect.catch((journalError) => Effect.succeed({
              ...failure, reason: redact(journalError, input.knownSecrets ?? []),
            })),
          )),
        )
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "failed",
        reason: redact(error, input.knownSecrets ?? []),
      } satisfies ActionResult)
    ),
  );

const completeSkipped = (
  input: SynchronizationRunInput,
  states: ReadonlyArray<ActionState>,
): Effect.Effect<void, never, StateRepository> =>
  Effect.forEach(
    states,
    (state) => journal(input.id, state.action.id, "skipped").pipe(Effect.ignore),
    { discard: true },
  );

/** Execute one already-recorded plan. The caller owns startRun ordering. */
export const executeSynchronizationPlan = (
  input: SynchronizationRunInput,
): Effect.Effect<
  SynchronizationExecutionResult,
  SynchronizationExecutionInputError,
  StateRepository | MachineState
> =>
  Effect.gen(function*() {
    const states = yield* executionContexts(input, executionLimits(input));
    const completedActions: Array<ActionId> = [];
    const verified = new Set<ResourceId>();
    const applied: Array<AppliedResourceRecord> = [];
    const human: Array<HumanAction> = [];
    const drift: Array<DriftConflict> = [];
    const removedResources = new Set<ResourceId>();
    const failedRollbacks: Array<ActionId> = [];
    const completedRollbacks: Array<{
      readonly action: ActionId;
      readonly resource?: ResourceId | undefined;
      readonly rollback: Effect.Effect<void, unknown, MachineState>;
      readonly reference?: string | undefined;
    }> = [];
    let failedReason: string | undefined;

    const runActions = Effect.gen(function*() {
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index]!;
        const result = yield* executeSynchronizationAction(input, state);
        if (result.rollbackFailed) failedRollbacks.push(state.action.id);
        completedActions.push(state.action.id);
        if (result.kind === "verified" && result.rollback !== undefined) {
          completedRollbacks.push({
            action: state.action.id,
            resource: result.resource,
            rollback: result.rollback,
            reference: result.rollbackReference,
          });
        }
        if (result.resource !== undefined) verified.add(result.resource);
        if (
          result.resource !== undefined
          && input.revision.removedResources?.includes(result.resource) === true
        ) {
          removedResources.add(result.resource);
        }
        if (result.human !== undefined) human.push(result.human);
        if (result.drift !== undefined) drift.push(result.drift);
        if (result.reason !== undefined) failedReason = result.reason;
        if (result.kind !== "verified") {
          if (result.kind === "failed") {
            for (const completed of completedRollbacks.reverse()) {
              const previousApplied = completed.resource === undefined
                ? undefined
                : input.appliedResources?.find((record) =>
                  record.resource === completed.resource
                );
              yield* completed.rollback.pipe(
                Effect.tapError(() => Effect.sync(() => {
                  failedRollbacks.push(completed.action);
                })),
                Effect.andThen(journal(
                  input.id,
                  completed.action,
                  "failed",
                  { status: "not-run", method: "run-rolled-back" },
                  completed.reference,
                  1,
                  previousApplied,
                  completed.resource !== undefined && previousApplied === undefined
                    ? completed.resource
                    : undefined,
                )),
                Effect.catch((error) => {
                  failedReason = `${failedReason ?? "synchronization failed"}; rollback failed for ${completed.action}: ${redact(
                    error instanceof Error ? error : new Error(String(error)),
                    input.knownSecrets ?? [],
                  )}`;
                  return Effect.void;
                }),
              );
            }
          }
          yield* completeSkipped(input, states.slice(index + 1));
          break;
        }
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function*() {
          const repository = yield* StateRepository;
          const outcome: SynchronizationOutcome = {
            outcome: "Interrupted",
            run: input.id,
            completedActions,
          };
          yield* repository.completeRun({
            run: input.id,
            completedAt: yield* now(),
            outcome,
            appliedResources: [],
            removedResources: [],
          });
        }).pipe(Effect.ignore)
      ),
    );
    yield* runActions;

    const outcome: SynchronizationOutcome = failedReason !== undefined
      ? { outcome: "Failed", run: input.id, reason: failedReason }
      : drift.length > 0
      ? { outcome: "FollowerDrift", run: input.id, conflicts: drift }
      : human.length > 0
      ? { outcome: "HumanActionRequired", run: input.id, actions: human }
      : {
        outcome: "Converged",
        run: input.id,
        verified: [...verified].sort(),
      };

    if (outcome.outcome === "Converged") {
      const appliedAt = yield* now();
      const desiredByResource = new Map(input.revision.desired.map((entry) => [
        entry.resource,
        entry.desired,
      ]));
      const resourceById = new Map(input.revision.resources.map((resource) => [
        resource.id,
        resource,
      ]));
      for (const resource of outcome.verified) {
        if (removedResources.has(resource)) continue;
        const desired = desiredByResource.get(resource);
        const digest = desired === undefined ? undefined : desiredResourceDigest(desired);
        if (digest !== undefined) {
          const ownedFiles = desired === undefined ? undefined : ownedFilesFor(desired);
          applied.push({
            resource,
            revision: input.revision.id,
            digest,
            appliedAt,
            kind: resourceById.get(resource)?.kind,
            policy: resourceById.get(resource)?.policy,
            target: resourceById.get(resource)?.target,
            executable: desired?.kind === "file" ? desired.executable : undefined,
            mode: desired?.kind === "file"
                || desired?.kind === "directory"
                || desired?.kind === "skill"
              ? desired.mode
              : undefined,
            symlinkTo: desired?.kind === "file" ? desired.symlinkTo : undefined,
            ownedFiles,
            ownedKeys: desired?.kind === "config" ? desired.keys : undefined,
            configFormat: desired?.kind === "config" ? desired.format : undefined,
          });
        }
      }
    }
    return {
      outcome,
      failedRollbacks,
      appliedResources: applied,
      removedResources: outcome.outcome === "Converged"
        ? [...removedResources].sort()
        : [],
    };
  });

export const executionFollower = (input: SynchronizationRunInput) =>
  Schema.decodeUnknownEffect(FollowerId)(input.plan.follower).pipe(
    Effect.mapError((error) =>
      new InvalidExecutionPlanError({ message: String(error) })
    ),
  );

export const executionRevision = (input: SynchronizationRunInput) =>
  Schema.decodeUnknownEffect(ProfileRevisionId)(input.plan.revision).pipe(
    Effect.mapError((error) =>
      new InvalidExecutionPlanError({ message: String(error) })
    ),
  );
