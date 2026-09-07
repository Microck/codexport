import { Schema } from "effect";

import type { ScheduleManagerError } from "../schedule/schedule-manager.errors.ts";

export class DuplicatePlannerInputError extends Schema.TaggedError<DuplicatePlannerInputError>()(
  "DuplicatePlannerInputError",
  {
    collection: Schema.String,
    id: Schema.String,
  },
) {}

export class MissingDesiredResourceError extends Schema.TaggedError<MissingDesiredResourceError>()(
  "MissingDesiredResourceError",
  { resource: Schema.String },
) {}

export class MissingObservedResourceError extends Schema.TaggedError<MissingObservedResourceError>()(
  "MissingObservedResourceError",
  { resource: Schema.String },
) {}

export class PlannerResourceKindMismatchError extends Schema.TaggedError<PlannerResourceKindMismatchError>()(
  "PlannerResourceKindMismatchError",
  {
    resource: Schema.String,
    publishedKind: Schema.String,
    desiredKind: Schema.String,
  },
) {}

export class PlannerPolicyKindMismatchError extends Schema.TaggedError<PlannerPolicyKindMismatchError>()(
  "PlannerPolicyKindMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    policy: Schema.String,
  },
) {}

export class PlannerVerificationKindMismatchError extends Schema.TaggedError<PlannerVerificationKindMismatchError>()(
  "PlannerVerificationKindMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    method: Schema.String,
  },
) {}

export class PlannerTextCompositionError extends Schema.TaggedError<PlannerTextCompositionError>()(
  "PlannerTextCompositionError",
  { resource: Schema.String, reason: Schema.String },
) {}

export class PlannerVerificationContentMismatchError extends Schema.TaggedError<PlannerVerificationContentMismatchError>()(
  "PlannerVerificationContentMismatchError",
  {
    resource: Schema.String,
    kind: Schema.String,
    method: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerInvalidRecipeError extends Schema.TaggedError<PlannerInvalidRecipeError>()(
  "PlannerInvalidRecipeError",
  {
    resource: Schema.String,
    method: Schema.String,
    package: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerInvalidResourcePathError extends Schema.TaggedError<PlannerInvalidResourcePathError>()(
  "PlannerInvalidResourcePathError",
  {
    resource: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerConflictingResourcePathError extends Schema.TaggedError<PlannerConflictingResourcePathError>()(
  "PlannerConflictingResourcePathError",
  {
    resource: Schema.String,
    path: Schema.String,
    conflictsWith: Schema.String,
    reason: Schema.String,
  },
) {}

export class PlannerMissingDependencyError extends Schema.TaggedError<PlannerMissingDependencyError>()(
  "PlannerMissingDependencyError",
  {
    resource: Schema.String,
    dependency: Schema.String,
  },
) {}

export class PlannerDependencyCycleError extends Schema.TaggedError<PlannerDependencyCycleError>()(
  "PlannerDependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class MissingBlobMetadataError extends Schema.TaggedError<MissingBlobMetadataError>()(
  "MissingBlobMetadataError",
  {
    resource: Schema.String,
    blob: Schema.String,
  },
) {}

export class InvalidObservedStateError extends Schema.TaggedError<InvalidObservedStateError>()(
  "InvalidObservedStateError",
  {
    resource: Schema.String,
    kind: Schema.String,
    observedState: Schema.String,
  },
) {}

export class InvalidExecutionPlanError extends Schema.TaggedError<InvalidExecutionPlanError>()(
  "InvalidExecutionPlanError",
  { message: Schema.String },
) {}

export class MissingExecutionResourceError extends Schema.TaggedError<MissingExecutionResourceError>()(
  "MissingExecutionResourceError",
  { resource: Schema.String },
) {}

export class MissingArtifactError extends Schema.TaggedError<MissingArtifactError>()(
  "MissingArtifactError",
  { digest: Schema.String },
) {}

export class InvalidArtifactError extends Schema.TaggedError<InvalidArtifactError>()(
  "InvalidArtifactError",
  {
    digest: Schema.String,
    message: Schema.String,
  },
) {}

export class ActionExecutionError extends Schema.TaggedError<ActionExecutionError>()(
  "ActionExecutionError",
  {
    action: Schema.String,
    message: Schema.String,
  },
) {}

export class RecoveryRunNotFoundError extends Schema.TaggedError<RecoveryRunNotFoundError>()(
  "RecoveryRunNotFoundError",
  { follower: Schema.String },
) {}

export class RecoveryIntegrityError extends Schema.TaggedError<RecoveryIntegrityError>()(
  "RecoveryIntegrityError",
  {
    run: Schema.String,
    message: Schema.String,
  },
) {}

export class RollbackCleanupError extends Schema.TaggedError<RollbackCleanupError>()(
  "RollbackCleanupError",
  {
    run: Schema.String,
    outcome: Schema.String,
    message: Schema.String,
  },
) {}

export type SynchronizationPlanningError =
  | DuplicatePlannerInputError
  | MissingDesiredResourceError
  | MissingObservedResourceError
  | PlannerResourceKindMismatchError
  | PlannerPolicyKindMismatchError
  | PlannerTextCompositionError
  | PlannerVerificationKindMismatchError
  | PlannerVerificationContentMismatchError
  | PlannerInvalidRecipeError
  | PlannerInvalidResourcePathError
  | PlannerConflictingResourcePathError
  | PlannerMissingDependencyError
  | PlannerDependencyCycleError
  | MissingBlobMetadataError
  | InvalidObservedStateError;

export type SynchronizationExecutionInputError =
  | InvalidExecutionPlanError
  | MissingExecutionResourceError
  | MissingArtifactError
  | InvalidArtifactError
  | ActionExecutionError
  | RollbackCleanupError
  | ScheduleManagerError;

export type SynchronizationRecoveryError =
  | RecoveryRunNotFoundError
  | RecoveryIntegrityError
  | SynchronizationExecutionInputError;
