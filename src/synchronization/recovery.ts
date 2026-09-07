import { Clock, Effect, Option, Schema } from "effect";

import {
  AgentTaskId,
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  ResourceId,
  type ActionId,
} from "../domain/brand.ts";
import type {
  AppliedResourceRecord,
  DriftConflict,
  HumanAction,
  PlannedAction,
  SynchronizationOutcome,
} from "../domain/synchronization.ts";
import {
  ExecutableAuthorizationSchema,
  PlannedAction as PlannedActionSchema,
} from "../domain/synchronization.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import type { StateRepositoryError } from "../state/state-repository.errors.ts";
import type {
  ActionJournalRecord,
  RecoveryState,
  VerificationEvidence,
} from "../state/state-repository.types.ts";
import {
  executionContexts,
  executionLimits,
  executeSynchronizationAction,
  ownedFilesFor,
  type ActionResult,
  type SynchronizationExecutionResult,
} from "./executor.ts";
import { desiredResourceDigest } from "./resource-plans.ts";
import {
  restoreRollbackReference,
  verifyResource,
  type ResourceExecutionContext,
  type ResourceVerification,
} from "./resource-executors.ts";
import { restoreScheduleRollbackReference } from "./schedule-rollbacks.ts";
import {
  RecoveryIntegrityError,
  RecoveryRunNotFoundError,
  type SynchronizationRecoveryError,
} from "./synchronization.errors.ts";
import type {
  PlannedSynchronization,
  SynchronizationRecoveryInput,
  SynchronizationRunInput,
} from "./synchronization.types.ts";

const PersistedPlanBody = Schema.Struct({
  revision: ProfileRevisionId,
  follower: FollowerId,
  requiredBlobs: Schema.Array(BlobId),
  actions: Schema.Array(PlannedActionSchema),
  agentTasks: Schema.Array(Schema.Struct({
    id: AgentTaskId,
    resource: ResourceId,
    summary: Schema.NonEmptyString,
    desiredOutcome: Schema.NonEmptyString,
    observedEvidence: Schema.Array(Schema.String),
    allowedPaths: Schema.Array(Schema.String),
    allowedExecutables: Schema.Array(Schema.String),
    executableAuthorizations: Schema.optional(
      Schema.Array(ExecutableAuthorizationSchema),
    ),
    allowedOrigins: Schema.Array(Schema.String),
    forbidden: Schema.Array(Schema.Literals([
      "elevation",
      "login",
      "restart",
      "reboot",
    ])),
    timeLimitSeconds: Schema.Int,
    outputLimitBytes: Schema.Int,
    verification: Schema.Struct({
      command: Schema.Array(Schema.String),
    }),
  })),
});

const now = Effect.map(
  Clock.currentTimeMillis,
  (milliseconds) => new Date(milliseconds).toISOString(),
);

const integrityError = (
  recovery: RecoveryState,
  message: string,
): RecoveryIntegrityError =>
  new RecoveryIntegrityError({ run: recovery.run.id, message });

const hydratePlan = (
  recovery: RecoveryState,
): Effect.Effect<PlannedSynchronization, RecoveryIntegrityError> =>
  Effect.gen(function*() {
    const decoded = yield* Effect.try({
      try: () => JSON.parse(recovery.run.plan.encoded),
      catch: (error) => integrityError(recovery, `persisted plan encoding is malformed: ${String(error)}`),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PersistedPlanBody)),
      Effect.mapError((error) =>
        error instanceof RecoveryIntegrityError
          ? error
          : integrityError(recovery, `persisted plan encoding is invalid: ${String(error)}`)
      ),
    );
    const canonical = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(decoded));
    const computedDigest = Schema.decodeUnknownSync(ContentDigest)(
      sha256Hex(recovery.run.plan.encoded),
    );
    if (
      canonical !== recovery.run.plan.encoded
      || recovery.run.plan.digest !== computedDigest
      || decoded.revision !== recovery.run.revision
      || decoded.follower !== recovery.run.follower
      || JSON.stringify(decoded.actions) !== JSON.stringify(recovery.run.plan.actions)
    ) {
      return yield* integrityError(
        recovery,
        "persisted plan identity or actions do not match its canonical encoding",
      );
    }
    return {
      ...recovery.run.plan,
      digest: computedDigest,
      requiredBlobs: decoded.requiredBlobs,
      agentTasks: decoded.agentTasks,
    };
  });

const validateJournal = (
  recovery: RecoveryState,
  actions: ReadonlyArray<PlannedAction>,
): Effect.Effect<ReadonlyMap<string, ActionJournalRecord>, RecoveryIntegrityError> =>
  Effect.gen(function*() {
    const planned = new Set(actions.map((action) => action.id));
    const events = new Map<string, Array<ActionJournalRecord>>();
    for (let index = 0; index < recovery.actions.length; index += 1) {
      const event = recovery.actions[index]!;
      if (event.ordinal !== index || !planned.has(event.action)) {
        return yield* integrityError(recovery, "action journal order or action identity is invalid");
      }
      const actionEvents = events.get(event.action) ?? [];
      actionEvents.push(event);
      events.set(event.action, actionEvents);
    }
    const latest = new Map<string, ActionJournalRecord>();
    for (const action of actions) {
      const actionEvents = events.get(action.id);
      if (
        actionEvents === undefined
        || actionEvents[0]?.state !== "pending"
        || actionEvents[0]?.attempt !== 0
        || actionEvents.filter((event) => event.state === "pending").length !== 1
      ) {
        return yield* integrityError(
          recovery,
          `action ${action.id} does not have one valid initial journal event`,
        );
      }
      const attempts = new Map<number, Array<ActionJournalRecord>>();
      let previousAttempt = 0;
      for (const event of actionEvents.slice(1)) {
        if (event.attempt < 1 || event.attempt < previousAttempt) {
          return yield* integrityError(
            recovery,
            `action ${action.id} has invalid attempt ordering`,
          );
        }
        previousAttempt = event.attempt;
        const attemptEvents = attempts.get(event.attempt) ?? [];
        attemptEvents.push(event);
        attempts.set(event.attempt, attemptEvents);
      }
      for (const [attempt, attemptEvents] of attempts) {
        const terminal = attemptEvents.findIndex((event) =>
          event.state === "succeeded" || event.state === "skipped"
        );
        const laterEvents = terminal < 0 ? [] : attemptEvents.slice(terminal + 1);
        const completedRollback = attemptEvents[terminal]?.state === "succeeded"
          && laterEvents.length === 1
          && laterEvents[0]?.state === "failed"
          && laterEvents[0]?.verification?.status === "not-run"
          && laterEvents[0]?.verification?.method === "run-rolled-back";
        if (terminal >= 0 && terminal !== attemptEvents.length - 1 && !completedRollback) {
          return yield* integrityError(
            recovery,
            `terminal action ${action.id} attempt ${String(attempt)} has later journal events`,
          );
        }
      }
      const last = actionEvents.at(-1)!;
      if (
        last.state === "succeeded"
        && last.verification?.status !== "passed"
      ) {
        return yield* integrityError(
          recovery,
          `succeeded action ${action.id} lacks passing verification evidence`,
        );
      }
      latest.set(action.id, last);
    }
    return latest;
  });

const baseRevision = (revision: SynchronizationRecoveryInput["revision"]) => ({
  id: revision.id,
  profileId: revision.profileId,
  sequence: revision.sequence,
  canonicalBytes: revision.canonicalBytes,
  digest: revision.digest,
  signature: revision.signature,
  publishedAt: revision.publishedAt,
  resources: revision.resources
    .filter((resource) => !revision.removedResources?.includes(resource.id))
    .map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    policy: resource.policy,
    target: resource.target,
    groups: resource.groups,
    dependsOn: resource.dependsOn,
    blobs: resource.blobs,
    })),
  groups: revision.groups,
  scheduleDefault: revision.scheduleDefault,
});

const evidence = (verification: ResourceVerification): VerificationEvidence => {
  const base = {
    status: verification.passed ? "passed" as const : "failed" as const,
    method: verification.method,
  };
  const withDigest = verification.observedDigest === undefined
    ? base
    : {
      ...base,
      observedDigest: Schema.decodeUnknownSync(ContentDigest)(
        verification.observedDigest,
      ),
    };
  return verification.exitCode === undefined
    ? withDigest
    : { ...withDigest, exitCode: verification.exitCode };
};

const appendJournal = (
  run: SynchronizationRunInput["id"],
  action: PlannedAction,
  state: "running" | "succeeded" | "failed" | "skipped",
  attempt: number,
  verification?: VerificationEvidence,
  rollbackReference?: string,
  appliedResource?: AppliedResourceRecord,
  removedResource?: ResourceId,
) =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const base = {
      run,
      action: action.id,
      state,
      recordedAt: yield* now,
      attempt,
    };
    yield* repository.journalAction({
      ...base,
      verification,
      rollbackReference,
      appliedResource,
      removedResource,
    });
  });

const latestRollbackReference = (
  events: ReadonlyArray<ActionJournalRecord>,
  action: ActionJournalRecord["action"],
): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.action === action && event.rollbackReference !== undefined) {
      return event.rollbackReference;
    }
  }
  return undefined;
};

const restoreResourceRollbackReference = (
  context: ResourceExecutionContext,
  reference: string,
) => restoreRollbackReference(context, reference);

const preservedOutcome = (
  input: SynchronizationRunInput,
  action: PlannedAction,
): ActionResult => {
  const detail = action.detail;
  if (detail.kind === "human-action") {
    return {
      kind: "human",
      human: {
        reason: detail.reason,
        instructions: detail.instructions,
        resource: action.resource,
      },
    };
  }
  if (detail.kind === "agent-task") {
    return {
      kind: "human",
      human: {
        reason: `Bounded agent task requires resolution: ${detail.summary}`,
        instructions:
          `Resolve task ${detail.taskId} under the configured agent policy, then rerun synchronization.`,
        resource: action.resource,
      },
    };
  }
  if (detail.kind === "drift-conflict") {
    const previous = input.appliedResources?.find((record) =>
      record.resource === action.resource
    );
    return {
      kind: "drift",
      drift: {
        resource: action.resource,
        target: detail.target,
        desiredDigest: detail.desiredDigest,
        observedDigest: detail.observedDigest,
        lastAppliedDigest: previous?.digest ?? detail.desiredDigest,
      },
    };
  }
  return { kind: "failed", reason: `invalid skipped action ${action.id}` };
};

const uncertainInstaller = (
  input: SynchronizationRunInput,
  state: Parameters<typeof verifyResource>[0],
  action: PlannedAction,
  attempt: number,
): Effect.Effect<ActionResult, never, StateRepository | MachineState> =>
  verifyResource(state).pipe(
    Effect.flatMap((verification): Effect.Effect<
      ActionResult,
      StateRepositoryError,
      StateRepository
    > => {
      const observed = evidence(verification);
      if (verification.passed) {
        return appendJournal(
          input.id,
          action,
          "succeeded",
          attempt,
          observed,
        ).pipe(Effect.as({
          kind: "verified",
          resource: action.resource,
        } satisfies ActionResult));
      }
      return appendJournal(
        input.id,
        action,
        "skipped",
        attempt,
        observed,
      ).pipe(Effect.as({
        kind: "human",
        human: {
          reason: `Installer state is uncertain for ${action.resource}`,
          instructions:
            "Verify or complete the external installation manually, then rerun recovery.",
          resource: action.resource,
        },
      } satisfies ActionResult));
    }),
    Effect.catch(() =>
      Effect.succeed({
        kind: "human",
        human: {
          reason: `Installer state is uncertain for ${action.resource}`,
          instructions:
            "Verify or complete the external installation manually, then rerun recovery.",
          resource: action.resource,
        },
      } satisfies ActionResult)
    ),
  );

/**
 * Resume one active run from repository evidence. The persisted plan remains
 * authoritative; hydrated revision content and artifacts are integrity inputs.
 */
export const recoverSynchronizationPlan = (
  recoveryInput: SynchronizationRecoveryInput,
): Effect.Effect<
  SynchronizationExecutionResult,
  SynchronizationRecoveryError | StateRepositoryError,
  StateRepository | MachineState
> =>
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const recovery = yield* repository.loadRecovery(recoveryInput.follower);
    if (recovery === undefined) {
      return yield* new RecoveryRunNotFoundError({
        follower: recoveryInput.follower,
      });
    }
    const plan = yield* hydratePlan(recovery);
    const persistedRevision = yield* repository.getRevision(recovery.run.revision);
    if (
      recoveryInput.revision.id !== recovery.run.revision
      || JSON.stringify(baseRevision(recoveryInput.revision))
        !== JSON.stringify(persistedRevision)
    ) {
      return yield* integrityError(
        recovery,
        "hydrated revision does not match the persisted run revision",
      );
    }
    const latest = yield* validateJournal(recovery, plan.actions);
    const recoveryAppliedResources = [
      ...new Map([
        ...recovery.appliedResources,
        ...recovery.removedResources,
      ].map((record) => [record.resource, record] as const)).values(),
    ];
    const input: SynchronizationRunInput = {
      id: recovery.run.id,
      plan,
      revision: recoveryInput.revision,
      appliedResources: recoveryAppliedResources,
      artifacts: recoveryInput.artifacts,
      knownSecrets: recoveryInput.knownSecrets,
      limits: recoveryInput.limits,
      agent: recoveryInput.agent,
      agentResolution: recoveryInput.agentResolution,
    };
    const states = yield* executionContexts(input, executionLimits(input));
    const verified = new Set<ResourceId>();
    const removedResources = new Set<ResourceId>();
    const failedRollbacks: Array<ActionId> = [];
    const human: Array<HumanAction> = [];
    const drift: Array<DriftConflict> = recovery.drift.map((entry) => entry.conflict);
    const completedRollbacks: Array<{
      readonly action: PlannedAction;
      readonly attempt: number;
      readonly rollback: Effect.Effect<void, unknown, MachineState>;
      readonly reference?: string | undefined;
      readonly resource?: ResourceId | undefined;
      readonly previousApplied?: AppliedResourceRecord | undefined;
    }> = [];
    let failedReason: string | undefined;

    for (const state of states) {
      const last = latest.get(state.action.id)!;
      const attempt = Math.max(1, last.attempt + 1);
      let result: ActionResult;
      let rollbackOwnership: {
        readonly resource: ResourceId;
        readonly previousApplied?: AppliedResourceRecord | undefined;
      } | undefined;
      if (last.state === "skipped") {
        result = preservedOutcome(input, state.action);
      } else if (
        last.state === "succeeded"
        && state.action.detail.kind === "transfer-blob"
      ) {
        result = { kind: "verified" };
      } else if (
        state.action.detail.kind === "install-tool"
        && last.state !== "pending"
      ) {
        result = yield* uncertainInstaller(
          input,
          state.context,
          state.action,
          attempt,
        );
      } else if (
        state.action.detail.kind === "remove-resource"
        && last.state === "succeeded"
      ) {
        if (last.rollbackReference === undefined) {
          return yield* integrityError(
            recovery,
            `completed removal ${state.action.id} lacks rollback material`,
          );
        }
        yield* restoreResourceRollbackReference(
          state.context,
          last.rollbackReference,
        ).pipe(
          Effect.mapError((error) =>
            integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
          ),
        );
        rollbackOwnership = {
          resource: state.action.resource,
          previousApplied: last.removedResource,
        };
        result = yield* executeSynchronizationAction(input, state, attempt);
      } else if (last.state === "succeeded") {
        const verification = yield* verifyResource(state.context).pipe(
          Effect.mapError((error) =>
            integrityError(recovery, `cannot reverify ${state.action.id}: ${String(error)}`)
          ),
        );
        if (verification.passed) {
          const rollback = last.rollbackReference === undefined
            ? undefined
            : restoreResourceRollbackReference(
              state.context,
              last.rollbackReference,
            );
          result = {
            kind: "verified",
            resource: state.action.resource,
            // Agent successes only verify external work. Ordinary successes
            // with a digest also replaced the ownership record atomically.
            rollback: rollback
              ?? (
                state.action.detail.kind !== "agent-task"
                  && desiredResourceDigest(state.context.desired) !== undefined
                  ? Effect.void
                  : undefined
              ),
            rollbackReference: last.rollbackReference,
          };
          rollbackOwnership = {
            resource: state.action.resource,
            previousApplied: last.removedResource,
          };
        } else if (last.rollbackReference !== undefined) {
          rollbackOwnership = {
            resource: state.action.resource,
            previousApplied: last.removedResource,
          };
          yield* restoreResourceRollbackReference(
            state.context,
            last.rollbackReference,
          ).pipe(
            Effect.mapError((error) =>
              integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
            ),
          );
          result = yield* executeSynchronizationAction(input, state, attempt);
        } else {
          result = {
            kind: "failed",
            reason: `previously completed action ${state.action.id} no longer verifies`,
          };
        }
      } else {
        const rollbackReference = latestRollbackReference(
          recovery.actions,
          state.action.id,
        );
        if (
          (last.state === "running" || last.state === "failed")
          && rollbackReference !== undefined
        ) {
          yield* restoreResourceRollbackReference(
            state.context,
            rollbackReference,
          ).pipe(
            Effect.mapError((error) =>
              integrityError(recovery, `cannot restore ${state.action.id}: ${String(error)}`)
            ),
          );
        }
        result = yield* executeSynchronizationAction(input, state, attempt);
      }
      if (result.rollbackFailed) failedRollbacks.push(state.action.id);
      if (result.kind === "verified" && result.rollback !== undefined) {
        if (result.resource !== undefined && rollbackOwnership === undefined) {
          rollbackOwnership = {
            resource: result.resource,
            previousApplied: input.appliedResources?.find((record) =>
              record.resource === result.resource
            ),
          };
        }
        completedRollbacks.push({
          action: state.action,
          attempt,
          rollback: result.rollback,
          reference: result.rollbackReference,
          resource: rollbackOwnership?.resource,
          previousApplied: rollbackOwnership?.previousApplied,
        });
      } else if (result.kind === "failed" && !result.rollbackFailed && rollbackOwnership !== undefined) {
        yield* appendJournal(
          input.id,
          state.action,
          "failed",
          attempt,
          { status: "not-run", method: "run-rolled-back" },
          result.rollbackReference,
          rollbackOwnership.previousApplied,
          rollbackOwnership.previousApplied === undefined
            ? rollbackOwnership.resource
            : undefined,
        );
      }
      if (result.resource !== undefined) verified.add(result.resource);
      if (
        result.resource !== undefined
        && recoveryInput.revision.removedResources?.includes(result.resource) === true
      ) {
        removedResources.add(result.resource);
      }
      if (result.human !== undefined) human.push(result.human);
      if (
        result.drift !== undefined
        && !drift.some((entry) => entry.resource === result.drift?.resource)
      ) {
        drift.push(result.drift);
      }
      if (result.reason !== undefined) failedReason = result.reason;
      if (result.kind !== "verified") {
        if (result.kind === "failed") {
          for (const completed of completedRollbacks.reverse()) {
            yield* completed.rollback.pipe(
              Effect.tapError(() => Effect.sync(() => {
                failedRollbacks.push(completed.action.id);
              })),
              Effect.andThen(appendJournal(
                input.id,
                completed.action,
                "failed",
                completed.attempt,
                { status: "not-run", method: "run-rolled-back" },
                completed.reference,
                completed.previousApplied,
                completed.previousApplied === undefined
                  ? completed.resource
                  : undefined,
              )),
              Effect.catch((error) => {
                failedReason = `${failedReason ?? "synchronization recovery failed"}; rollback failed for ${completed.action.id}: ${String(error)}`;
                return Effect.void;
              }),
            );
          }
        }
        break;
      }
    }

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
    const appliedResources: Array<AppliedResourceRecord> = [];
    if (outcome.outcome === "Converged") {
      const appliedAt = yield* now;
      const desired = new Map(recoveryInput.revision.desired.map((entry) => [
        entry.resource,
        entry.desired,
      ]));
      const resourceById = new Map(recoveryInput.revision.resources.map((resource) => [
        resource.id,
        resource,
      ]));
      for (const resource of outcome.verified) {
        if (removedResources.has(resource)) continue;
        const value = desired.get(resource);
        const digest = value === undefined
          ? undefined
          : desiredResourceDigest(value);
        if (digest !== undefined) {
          const ownedFiles = value === undefined ? undefined : ownedFilesFor(value);
          appliedResources.push({
            resource,
            revision: recoveryInput.revision.id,
            digest,
            appliedAt,
            kind: resourceById.get(resource)?.kind,
            policy: resourceById.get(resource)?.policy,
            target: resourceById.get(resource)?.target,
            executable: value?.kind === "file" ? value.executable : undefined,
            mode: value?.kind === "file"
                || value?.kind === "directory"
                || value?.kind === "skill"
              ? value.mode
              : undefined,
            symlinkTo: value?.kind === "file" ? value.symlinkTo : undefined,
            ownedFiles,
            ownedKeys: value?.kind === "config" ? value.keys : undefined,
            configFormat: value?.kind === "config" ? value.format : undefined,
          });
        }
      }
    }
    return {
      outcome,
      failedRollbacks,
      appliedResources,
      removedResources: outcome.outcome === "Converged"
        ? [...removedResources].sort()
        : [],
    };
  });
