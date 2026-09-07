import { Schema } from "effect";

import {
  ActionId,
  AgentTaskId,
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileRevisionId,
  ResourceId as ResourceIdSchema,
  RunId,
  Timestamp,
} from "./brand.ts";
import type { ResourceId } from "./brand.ts";
import {
  SyncScheduleSchema,
  type SyncSchedule,
} from "../schedule/schedule-manager.types.ts";
import {
  AutomaticRecipeMethod,
  BuildPolicy as BuildPolicySchema,
  RecipeIndexPolicy,
  type RecipeSource,
  type BuildPolicy,
} from "./resource.ts";

import {
  isMissingAutomaticRecipeVersion,
  RecipeSourceMetadata,
  recipeValidationError,
} from "./recipe-versions.ts";
/**
 * Synchronization domain types: plans, actions, outcomes, drift, agent tasks,
 * and human action records.
 */

/** One planned action in a Synchronization Plan. */
export interface PlannedAction {
  readonly id: ActionId;
  readonly resource: ResourceId;
  readonly kind: PlannedActionKind;
  readonly detail: ActionDetail;
  readonly before: ReadonlyArray<ActionId>;
}

export type PlannedActionKind =
  | "no-op"
  | "transfer-blob"
  | "write-file"
  | "write-config"
  | "mirror-directory"
  | "remove-resource"
  | "install-tool"
  | "verify-only"
  | "human-action"
  | "agent-task"
  | "drift-conflict";

export type ActionDetail =
  | { readonly kind: "no-op" }
  | { readonly kind: "transfer-blob"; readonly blob: string; readonly bytes: number }
  | {
    readonly kind: "write-file";
    readonly target: string;
    readonly digest: string;
    /** Normalized regular-file executable intent; absent for non-file writes. */
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    /** Source baseline retained by a persisted append-local action. */
    readonly previousSourceDigest?: string | undefined;
  }
  | {
    readonly kind: "write-config";
    readonly target: string;
    readonly keys: ReadonlyArray<string>;
    /**
     * Keys Canonfig owned that the revision no longer declares.
     *
     * A dropped key used to stay on the follower with its old value and the
     * plan read `no-op`, so only removing the whole resource ever removed a
     * key. These are pruned, and only when the file still holds exactly what
     * Canonfig wrote, so a local edit is never silently discarded.
     */
    readonly removes?: ReadonlyArray<string> | undefined;
  }
  | { readonly kind: "mirror-directory"; readonly target: string; readonly adds: ReadonlyArray<string>; readonly removes: ReadonlyArray<string> }
  | { readonly kind: "remove-resource"; readonly target: string; readonly paths: ReadonlyArray<string>; readonly keys: ReadonlyArray<string> }
  | { readonly kind: "install-tool"; readonly toolId: string; readonly method: AutomaticRecipeMethod; readonly package: string; readonly version?: string | undefined; readonly indexPolicy?: RecipeIndexPolicy | undefined; readonly source?: RecipeSource | undefined; readonly buildPolicy?: BuildPolicy | undefined }
  | { readonly kind: "verify-only"; readonly method: string }
  | { readonly kind: "human-action"; readonly reason: string; readonly instructions: string }
  | { readonly kind: "agent-task"; readonly taskId: AgentTaskId; readonly summary: string }
  | {
    readonly kind: "drift-conflict";
    readonly target: string;
    readonly desiredDigest: string;
    readonly observedDigest: string;
    readonly desiredExecutable?: boolean | undefined;
    readonly observedExecutable?: boolean | undefined;
    /**
     * Filesystem modes are part of convergence, so drift can be mode-only.
     * A conflict that reported digests alone left the operator comparing two
     * identical hashes with nothing to say the modes were the difference,
     * which is what happens when a managed tree is recreated by hand with
     * default shell modes.
     */
    readonly desiredMode?: number | undefined;
    readonly observedMode?: number | undefined;
  };

/** A full, deterministic Synchronization Plan for one follower against one revision. */
export interface SynchronizationPlan {
  readonly revision: string;
  readonly follower: string;
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly encoded: string;
  readonly digest?: ContentDigest | undefined;
}

/**
 * An explicit per-executable execution model. A task or harness can only
 * authorize behavior it can reason about: a direct leaf operation, or a
 * bounded script-file interpreter. Launchers that execute nested commands
 * cannot be authorized at all; they fail closed with Human Action Required.
 */
export interface ExecutableAuthorization {
  readonly executable: string;
  readonly behavior: "leaf" | "script-interpreter";
}

export interface AgentTask {
  readonly id: AgentTaskId;
  readonly summary: string;
  readonly desiredOutcome: string;
  readonly observedEvidence: ReadonlyArray<string>;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly allowedExecutables: ReadonlyArray<string>;
  readonly executableAuthorizations?: ReadonlyArray<ExecutableAuthorization> | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly forbidden: ReadonlyArray<"elevation" | "login" | "restart" | "reboot">;
  readonly timeLimitSeconds: number;
  readonly outputLimitBytes: number;
  readonly verification: { readonly command: ReadonlyArray<string>; readonly expectContains?: string | undefined };
}

/** Human Action Required record with exact recovery instructions. */
export interface HumanAction {
  readonly reason: string;
  readonly instructions: string;
  readonly resource?: ResourceId | undefined;
}

/** Run outcome union. */
export type SynchronizationOutcome =
  | { readonly outcome: "Converged"; readonly run: RunId; readonly verified: ReadonlyArray<ResourceId> }
  | { readonly outcome: "HumanActionRequired"; readonly run: RunId; readonly actions: ReadonlyArray<HumanAction> }
  | { readonly outcome: "FollowerDrift"; readonly run: RunId; readonly conflicts: ReadonlyArray<DriftConflict> }
  | { readonly outcome: "Failed"; readonly run: RunId; readonly reason: string }
  | { readonly outcome: "Interrupted"; readonly run: RunId; readonly completedActions: ReadonlyArray<ActionId> };

export interface DriftConflict {
  readonly resource: ResourceId;
  readonly target: string;
  readonly desiredDigest: string;
  readonly observedDigest: string;
  readonly lastAppliedDigest: string
  readonly desiredExecutable?: boolean | undefined;
  readonly observedExecutable?: boolean | undefined;
  readonly desiredMode?: number | undefined;
  readonly observedMode?: number | undefined;
}

/** Observed state of one resource target on the follower. */
export const ObservedObjectKind = Schema.Literals([
  "regular",
  "directory",
  "symlink",
  "reparse-point",
  "special",
]);
export type ObservedObjectKind = Schema.Schema.Type<typeof ObservedObjectKind>;

export type ObservedDirectoryFile =
  | {
    readonly path: string;
    readonly state: "absent";
  }
  | {
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly symlinkTo?: string | undefined;
  };

export type ObservedResourceState =
  | { readonly state: "absent" }
  | {
    readonly state: "present";
    readonly digest: string;
    /** Digest of the marked Source payload, independent of local additions. */
    readonly managedSourceDigest?: string | undefined;
    readonly executable: boolean;
    readonly mode?: number | undefined;
    /**
     * Actual final path kind. Optional for compatibility with observations
     * produced before no-follow object inspection was introduced.
     */
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly symlinkTo?: string | undefined;
  }
  | {
    readonly state: "directory";
    readonly objectKind?: ObservedObjectKind | undefined;
    readonly mode: number;
    readonly files: ReadonlyArray<ObservedDirectoryFile>;
  }
  | { readonly state: "unverifiable"; readonly reason: string };

/** Applied Resource Record: what Canonfig last wrote for one resource. */
export interface AppliedResourceRecord {
  readonly resource: ResourceId;
  readonly revision: string;
  readonly digest: string;
  readonly appliedAt: string;
  readonly kind?: "file" | "directory" | "config" | "skill" | "tool" | "credential" | undefined;
  readonly policy?: "replace" | "mirror-owned" | "merge" | "replace-if-unmodified" | "append-local" | "ensure" | "require-local" | undefined;
  readonly target?: string | undefined;
  readonly executable?: boolean | undefined;
  readonly mode?: number | undefined;
  readonly symlinkTo?: string | undefined;
  readonly ownedFiles?: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly executable?: boolean | undefined;
    readonly mode?: number | undefined;
    readonly objectKind?: "regular" | "directory" | "symlink" | undefined;
    readonly symlinkTo?: string | undefined;
  }> | undefined;
  readonly ownedKeys?: ReadonlyArray<string> | undefined;
  readonly configFormat?: "toml" | "json" | "yaml" | undefined;
}

export const PlannedActionKindSchema = Schema.Literals([
  "no-op",
  "transfer-blob",
  "write-file",
  "write-config",
  "mirror-directory",
  "remove-resource",
  "install-tool",
  "verify-only",
  "human-action",
  "agent-task",
  "drift-conflict",
]);

const InstallToolActionDetailSchema = Schema.Struct({
  kind: Schema.Literal("install-tool"),
  toolId: Schema.NonEmptyString,
  method: AutomaticRecipeMethod,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
  indexPolicy: Schema.optional(RecipeIndexPolicy),
  source: Schema.optional(Schema.Union([
    Schema.NonEmptyString,
    RecipeSourceMetadata,
  ])),
  buildPolicy: Schema.optional(BuildPolicySchema),
}).check(
  Schema.makeFilter((detail) => {
    const reason = recipeValidationError(detail);
    return reason === undefined && !isMissingAutomaticRecipeVersion(detail)
      ? undefined
      : {
        path: ["version"],
        issue: reason ?? `automatic installer ${detail.method} requires an exact version`,
      };
  }),
);

export const ActionDetailSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("no-op") }),
  Schema.Struct({
    kind: Schema.Literal("transfer-blob"),
    blob: BlobId,
    bytes: Schema.Natural,
  }),
  Schema.Struct({
    kind: Schema.Literal("write-file"),
    target: Schema.NonEmptyString,
    digest: ContentDigest,
    executable: Schema.optional(Schema.Boolean),
    mode: Schema.optional(Schema.Int),
    previousSourceDigest: Schema.optional(ContentDigest),
  }),
  Schema.Struct({
    kind: Schema.Literal("write-config"),
    target: Schema.NonEmptyString,
    keys: Schema.Array(Schema.NonEmptyString),
    removes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  }),
  Schema.Struct({
    kind: Schema.Literal("mirror-directory"),
    target: Schema.NonEmptyString,
    adds: Schema.Array(Schema.NonEmptyString),
    removes: Schema.Array(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-resource"),
    target: Schema.NonEmptyString,
    paths: Schema.Array(Schema.NonEmptyString),
    keys: Schema.Array(Schema.NonEmptyString),
  }),
  InstallToolActionDetailSchema,
  Schema.Struct({
    kind: Schema.Literal("verify-only"),
    method: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("human-action"),
    reason: Schema.NonEmptyString,
    instructions: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent-task"),
    taskId: AgentTaskId,
    summary: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("drift-conflict"),
    target: Schema.NonEmptyString,
    desiredDigest: ContentDigest,
    observedDigest: ContentDigest,
    desiredExecutable: Schema.optional(Schema.Boolean),
    observedExecutable: Schema.optional(Schema.Boolean),
    desiredMode: Schema.optional(Schema.Int),
    observedMode: Schema.optional(Schema.Int),
  }),
]);

export const PlannedActionSchema = Schema.Struct({
  id: ActionId,
  resource: ResourceIdSchema,
  kind: PlannedActionKindSchema,
  detail: ActionDetailSchema,
  before: Schema.Array(ActionId),
});

export const SynchronizationPlanSchema = Schema.Struct({
  revision: ProfileRevisionId,
  follower: FollowerId,
  actions: Schema.Array(PlannedActionSchema),
  encoded: Schema.String,
  digest: Schema.optional(ContentDigest),
});

export const ForbiddenAgentCapabilitySchema = Schema.Literals([
  "elevation",
  "login",
  "restart",
  "reboot",
]);

export const ExecutableAuthorizationSchema = Schema.Struct({
  executable: Schema.NonEmptyString,
  behavior: Schema.Literals(["leaf", "script-interpreter"]),
});

export const AgentTaskSchema = Schema.Struct({
  id: AgentTaskId,
  summary: Schema.NonEmptyString,
  desiredOutcome: Schema.NonEmptyString,
  observedEvidence: Schema.Array(Schema.String),
  allowedPaths: Schema.Array(Schema.NonEmptyString),
  allowedExecutables: Schema.Array(Schema.NonEmptyString),
  executableAuthorizations: Schema.optional(Schema.Array(ExecutableAuthorizationSchema)),
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
  forbidden: Schema.Array(ForbiddenAgentCapabilitySchema),
  timeLimitSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  outputLimitBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  verification: Schema.Struct({
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
});

export const HumanActionSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
  resource: Schema.optional(ResourceIdSchema),
});

export const HumanActionRequiredSchema = Schema.Struct({
  outcome: Schema.Literal("HumanActionRequired"),
  run: RunId,
  actions: Schema.Array(HumanActionSchema),
});
export type HumanActionRequired = Schema.Schema.Type<typeof HumanActionRequiredSchema>;

export const DriftConflictSchema = Schema.Struct({
  resource: ResourceIdSchema,
  target: Schema.NonEmptyString,
  desiredDigest: ContentDigest,
  observedDigest: ContentDigest,
  lastAppliedDigest: ContentDigest,
  desiredExecutable: Schema.optional(Schema.Boolean),
  observedExecutable: Schema.optional(Schema.Boolean),
  desiredMode: Schema.optional(Schema.Int),
  observedMode: Schema.optional(Schema.Int),
});

export const SynchronizationOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("Converged"),
    run: RunId,
    verified: Schema.Array(ResourceIdSchema),
  }),
  HumanActionRequiredSchema,
  Schema.Struct({
    outcome: Schema.Literal("FollowerDrift"),
    run: RunId,
    conflicts: Schema.Array(DriftConflictSchema),
  }),
  Schema.Struct({
    outcome: Schema.Literal("Failed"),
    run: RunId,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    outcome: Schema.Literal("Interrupted"),
    run: RunId,
    completedActions: Schema.Array(ActionId),
  }),
]);

export const ObservedResourceStateSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({
    state: Schema.Literal("present"),
    digest: ContentDigest,
    managedSourceDigest: Schema.optional(ContentDigest),
    executable: Schema.Boolean,
    mode: Schema.optional(Schema.Int),
    objectKind: Schema.optional(ObservedObjectKind),
    symlinkTo: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    state: Schema.Literal("directory"),
    objectKind: Schema.optional(ObservedObjectKind),
    mode: Schema.Int,
    files: Schema.Array(Schema.Union([
      Schema.Struct({
        path: Schema.NonEmptyString,
        state: Schema.Literal("absent"),
      }),
      Schema.Struct({
        path: Schema.NonEmptyString,
        digest: ContentDigest,
        executable: Schema.optional(Schema.Boolean),
        mode: Schema.optional(Schema.Int),
        objectKind: Schema.optional(ObservedObjectKind),
        symlinkTo: Schema.optional(Schema.NonEmptyString),
      }),
    ])),
  }),
  Schema.Struct({
    state: Schema.Literal("unverifiable"),
    reason: Schema.NonEmptyString,
  }),
]);

export const AppliedResourceRecordSchema = Schema.Struct({
  resource: ResourceIdSchema,
  revision: ProfileRevisionId,
  digest: ContentDigest,
  appliedAt: Timestamp,
  kind: Schema.optional(Schema.Literals([
    "file",
    "directory",
    "config",
    "skill",
    "tool",
    "credential",
  ])),
  policy: Schema.optional(Schema.Literals([
    "replace",
    "mirror-owned",
    "merge",
    "replace-if-unmodified",
    "append-local",
    "ensure",
    "require-local",
  ])),
  target: Schema.optional(Schema.NonEmptyString),
  executable: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Int),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
  ownedFiles: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.NonEmptyString,
    digest: ContentDigest,
    executable: Schema.optional(Schema.Boolean),
    mode: Schema.optional(Schema.Int),
    objectKind: Schema.optional(Schema.Literals(["regular", "directory", "symlink"])),
    symlinkTo: Schema.optional(Schema.NonEmptyString),
  }))),
  ownedKeys: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  configFormat: Schema.optional(Schema.Literals(["toml", "json", "yaml"])),
});

/** Runtime schema aliases share names with their corresponding domain types. */
export const PlannedActionKind = PlannedActionKindSchema;
export const ActionDetail = ActionDetailSchema;
export const PlannedAction = PlannedActionSchema;
export const SynchronizationPlan = SynchronizationPlanSchema;
export const AgentTask = AgentTaskSchema;
export const HumanAction = HumanActionSchema;
export const HumanActionRequired = HumanActionRequiredSchema;
export const DriftConflict = DriftConflictSchema;
export const SynchronizationOutcome = SynchronizationOutcomeSchema;
export const ObservedResourceState = ObservedResourceStateSchema;
export const AppliedResourceRecord = AppliedResourceRecordSchema;

export class DuplicateActionError extends Schema.TaggedError<DuplicateActionError>()(
  "DuplicateActionError",
  { id: Schema.String },
) {}

export class MissingActionReferenceError extends Schema.TaggedError<MissingActionReferenceError>()(
  "MissingActionReferenceError",
  { id: Schema.String, before: Schema.String },
) {}

export class ActionCycleError extends Schema.TaggedError<ActionCycleError>()(
  "ActionCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class ActionKindMismatchError extends Schema.TaggedError<ActionKindMismatchError>()(
  "ActionKindMismatchError",
  { id: Schema.String, kind: Schema.String, detailKind: Schema.String },
) {}

export type SynchronizationPlanValidationError =
  | DuplicateActionError
  | MissingActionReferenceError
  | ActionCycleError
  | ActionKindMismatchError;

/** Validate action references, detail compatibility, and action graph acyclicity. */
export const validateSynchronizationPlan = (
  plan: SynchronizationPlan,
): ReadonlyArray<SynchronizationPlanValidationError> => {
  const errors: Array<SynchronizationPlanValidationError> = [];
  const actionIds = new Set<string>();
  for (const action of plan.actions) {
    if (actionIds.has(action.id)) errors.push(new DuplicateActionError({ id: action.id }));
    actionIds.add(action.id);
    if (action.kind !== action.detail.kind) {
      errors.push(new ActionKindMismatchError({
        id: action.id,
        kind: action.kind,
        detailKind: action.detail.kind,
      }));
    }
  }
  for (const action of plan.actions) {
    for (const before of action.before) {
      if (!actionIds.has(before)) {
        errors.push(new MissingActionReferenceError({ id: action.id, before }));
      }
    }
  }
  const cycle = findActionCycle(plan.actions);
  if (cycle !== null) errors.push(new ActionCycleError({ cycle }));
  return errors;
};

export const findActionCycle = (
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<string> | null => {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const action of actions) graph.set(action.id, action.before);
  const active: Array<string> = [];
  const complete = new Set<string>();
  const visit = (id: string): ReadonlyArray<string> | null => {
    if (complete.has(id)) return null;
    const index = active.indexOf(id);
    if (index >= 0) return [...active.slice(index), id];
    active.push(id);
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    active.pop();
    complete.add(id);
    return null;
  };
  for (const action of actions) {
    const cycle = visit(action.id);
    if (cycle !== null) return cycle;
  }
  return null;
};

/** Exit codes for the CLI, mapped from outcomes. */
export const ExitCode = {
  success: 0,
  invalidInput: 2,
  drift: 3,
  humanAction: 4,
  interrupted: 5,
  operationalFailure: 1,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Agent policy schema re-exported for the profile authoring boundary. */
export { AgentPolicy } from "./identity.ts";
