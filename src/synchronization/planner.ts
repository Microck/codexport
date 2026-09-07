import { Effect, Schema } from "effect";

import {
  ActionId,
  AgentTaskId,
  BlobId,
  ResourceId,
} from "../domain/brand.ts";
import {
  validateResourcePathConflicts,
  type PublishedResource,
} from "../domain/profile.ts";
import type { VerificationInput } from "../domain/profile.ts";
import { policyCompatibleWithKind } from "../domain/resource.ts";
import type {
  ActionDetail,
  AppliedResourceRecord,
  ObservedResourceState,
  PlannedAction,
} from "../domain/synchronization.ts";
import { canonicalJson, sha256Hex } from "../profile/profile-codec.ts";
import {
  DuplicatePlannerInputError,
  MissingBlobMetadataError,
  MissingDesiredResourceError,
  MissingObservedResourceError,
  PlannerDependencyCycleError,
  PlannerConflictingResourcePathError,
  PlannerInvalidRecipeError,
  PlannerInvalidResourcePathError,
  PlannerMissingDependencyError,
  PlannerPolicyKindMismatchError,
  PlannerTextCompositionError,
  PlannerResourceKindMismatchError,
  PlannerVerificationContentMismatchError,
  PlannerVerificationKindMismatchError,
  type SynchronizationPlanningError,
} from "./synchronization.errors.ts";
import {
  isMissingAutomaticRecipeVersion,
  recipeValidationError,
} from "../domain/recipe-versions.ts";
import {
  desiredDirectoryEntries,
  planRemoved,
  planResource,
  type ResourceActionDraft,
} from "./resource-plans.ts";
import type {
  AvailableBlob,
  DesiredResource,
  PlannedAgentTask,
  PlannedSynchronization,
  SynchronizationPlannerInput,
} from "./synchronization.types.ts";

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortedUnique = <Value extends string>(values: ReadonlyArray<Value>): ReadonlyArray<Value> =>
  [...new Set(values)].sort(compareText);

const actionId = (value: string) => Schema.decodeUnknownSync(ActionId)(value);
const agentTaskId = (value: string) => Schema.decodeUnknownSync(AgentTaskId)(value);

interface IndexedPlannerInput {
  readonly resources: ReadonlyMap<string, PublishedResource>;
  readonly desired: ReadonlyMap<string, DesiredResource>;
  readonly verification: ReadonlyMap<string, VerificationInput>;
  readonly observed: ReadonlyMap<string, ObservedResourceState>;
  readonly overlays: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly applied: ReadonlyMap<string, AppliedResourceRecord>;
  readonly blobs: ReadonlyMap<string, AvailableBlob>;
}

type IndexResult =
  | { readonly ok: true; readonly indexed: IndexedPlannerInput }
  | { readonly ok: false; readonly error: SynchronizationPlanningError };

const indexUnique = <Value>(
  collection: string,
  entries: ReadonlyArray<readonly [string, Value]>,
): ReadonlyMap<string, Value> | DuplicatePlannerInputError => {
  const indexed = new Map<string, Value>();
  for (const [id, value] of entries) {
    if (indexed.has(id)) return new DuplicatePlannerInputError({ collection, id });
    indexed.set(id, value);
  }
  return indexed;
};

/**
 * Indexes content-addressed blobs, collapsing legitimate repeats.
 *
 * A blob's id is the digest of its content, so two resources whose published
 * specifications are identical name one blob by design: sharing is the point of
 * a content-addressed store. Rejecting the repeat made every plan fail for a
 * profile that declared, for instance, two files with the same contents, and
 * the follower could never converge.
 *
 * A repeat that disagrees about its size is a different matter. Two different
 * contents cannot share a digest, so that is an integrity problem rather than
 * sharing, and it is still rejected.
 */
const indexBlobs = (
  entries: ReadonlyArray<AvailableBlob>,
): ReadonlyMap<string, AvailableBlob> | DuplicatePlannerInputError => {
  const indexed = new Map<string, AvailableBlob>();
  for (const blob of entries) {
    const existing = indexed.get(blob.id);
    if (existing !== undefined) {
      if (existing.bytes !== blob.bytes) {
        return new DuplicatePlannerInputError({
          collection: "revision.blobs",
          id: blob.id,
        });
      }
      continue;
    }
    indexed.set(blob.id, blob);
  }
  return indexed;
};

const isDuplicateInputError = (
  value: ReadonlyMap<string, unknown> | DuplicatePlannerInputError,
): value is DuplicatePlannerInputError => value instanceof DuplicatePlannerInputError;

const indexInput = (input: SynchronizationPlannerInput): IndexResult => {
  const resources = indexUnique(
    "revision.resources",
    input.revision.resources.map((resource) => [resource.id, resource] as const),
  );
  if (isDuplicateInputError(resources)) return { ok: false, error: resources };
  const desired = indexUnique(
    "revision.desired",
    input.revision.desired.map((entry) => [entry.resource, entry.desired] as const),
  );
  if (isDuplicateInputError(desired)) return { ok: false, error: desired };
  const verification = indexUnique(
    "revision.desired",
    input.revision.desired.map((entry) => [entry.resource, entry.verification] as const),
  );
  if (isDuplicateInputError(verification)) return { ok: false, error: verification };
  const observed = indexUnique(
    "observedState.resources",
    input.observedState.resources.map((entry) => [entry.resource, entry.observed] as const),
  );
  if (isDuplicateInputError(observed)) return { ok: false, error: observed };
  const overlays = indexUnique(
    "localOverlay",
    input.localOverlay.map((entry) => [entry.resource, entry.keys] as const),
  );
  if (isDuplicateInputError(overlays)) return { ok: false, error: overlays };
  const applied = indexUnique(
    "appliedResources",
    input.appliedResources.map((entry) => [entry.resource, entry] as const),
  );
  if (isDuplicateInputError(applied)) return { ok: false, error: applied };
  const blobs = indexBlobs(input.revision.blobs);
  if (isDuplicateInputError(blobs)) return { ok: false, error: blobs };
  return {
    ok: true,
    indexed: { resources, desired, verification, observed, overlays, applied, blobs },
  };
};

type ResourceOrderResult =
  | { readonly ok: true; readonly resources: ReadonlyArray<PublishedResource> }
  | { readonly ok: false; readonly error: SynchronizationPlanningError };

const verificationCompatibleWithDesired = (
  kind: PublishedResource["kind"],
  desired: DesiredResource,
  method: VerificationInput["method"],
): boolean => {
  if (kind === "file") {
    if (desired.kind !== "file") return false;
    return desired.symlinkTo === undefined
      ? method === "digest"
      : method === "symlink";
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

const orderResources = (
  resources: ReadonlyMap<string, PublishedResource>,
): ResourceOrderResult => {
  for (const resource of resources.values()) {
    for (const dependency of resource.dependsOn) {
      if (!resources.has(dependency)) {
        return {
          ok: false,
          error: new PlannerMissingDependencyError({
            resource: resource.id,
            dependency,
          }),
        };
      }
    }
  }

  const active: Array<string> = [];
  const complete = new Set<string>();
  const ordered: Array<PublishedResource> = [];
  const visit = (id: string): PlannerDependencyCycleError | undefined => {
    if (complete.has(id)) return undefined;
    const activeIndex = active.indexOf(id);
    if (activeIndex >= 0) {
      return new PlannerDependencyCycleError({
        cycle: [...active.slice(activeIndex), id],
      });
    }
    active.push(id);
    const resource = resources.get(id);
    if (resource !== undefined) {
      const dependencies = sortedUnique(resource.dependsOn);
      for (const dependency of dependencies) {
        const error = visit(dependency);
        if (error !== undefined) return error;
      }
      ordered.push(resource);
    }
    active.pop();
    complete.add(id);
    return undefined;
  };

  for (const id of [...resources.keys()].sort(compareText)) {
    const error = visit(id);
    if (error !== undefined) return { ok: false, error };
  }
  return { ok: true, resources: ordered };
};

const validateResourceInputs = (
  resources: ReadonlyArray<PublishedResource>,
  indexed: IndexedPlannerInput,
  platform: SynchronizationPlannerInput["observedState"]["platform"],
): SynchronizationPlanningError | undefined => {
  for (const resource of resources) {
    if (!policyCompatibleWithKind(resource.kind, resource.policy)) {
      return new PlannerPolicyKindMismatchError({
        resource: resource.id,
        kind: resource.kind,
        policy: resource.policy,
      });
    }
    const desired = indexed.desired.get(resource.id);
    if (desired === undefined) return new MissingDesiredResourceError({ resource: resource.id });
    if (desired.kind !== resource.kind) {
      return new PlannerResourceKindMismatchError({
        resource: resource.id,
        publishedKind: resource.kind,
        desiredKind: desired.kind,
      });
    }
    if (resource.policy === "append-local" && desired.kind === "file"
      && (desired.symlinkTo !== undefined || desired.executable || ((desired.mode ?? 0) & 0o111) !== 0)) {
      return new PlannerTextCompositionError({
        resource: resource.id,
        reason: "append-local requires a non-executable regular text file",
      });
    }
    const verification = indexed.verification.get(resource.id);
    if (
      verification === undefined
      || !verificationCompatibleWithDesired(resource.kind, desired, verification.method)
    ) {
      return new PlannerVerificationKindMismatchError({
        resource: resource.id,
        kind: resource.kind,
        method: verification?.method ?? "missing",
      });
    }
    if (
      verification !== undefined
      && desired.kind === "file"
      && (
        desired.symlinkTo === undefined
          && verification.method === "digest"
          && verification.digest !== desired.digest
        || desired.symlinkTo !== undefined
          && verification.method === "symlink"
          && verification.target !== desired.symlinkTo
      )
    ) {
      return new PlannerVerificationContentMismatchError({
        resource: resource.id,
        kind: resource.kind,
        method: verification.method,
        reason: desired.symlinkTo === undefined
          ? "digest verification does not match authored file content"
          : "symlink verification target does not match authored symlink target",
      });
    }
    if (desired.kind === "tool") {
      for (const recipe of desired.recipes) {
        const reason = recipeValidationError(recipe);
        if (reason !== undefined && !isMissingAutomaticRecipeVersion(recipe)) {
          return new PlannerInvalidRecipeError({
            resource: resource.id,
            method: recipe.method,
            package: recipe.package,
            reason,
          });
        }
      }
    }
    if (!indexed.observed.has(resource.id)) {
      return new MissingObservedResourceError({ resource: resource.id });
    }
  }
  const pathErrors = validateResourcePathConflicts(
    resources.map((resource) => {
      const desired = indexed.desired.get(resource.id);
      const entries = desired?.kind === "directory" || desired?.kind === "skill"
        ? desiredDirectoryEntries(desired).map((entry) => ({
          path: entry.path,
          kind: "objectKind" in entry && entry.objectKind === "directory"
            ? "directory" as const
            : "leaf" as const,
        }))
        : [];
      return {
        id: resource.id,
        kind: resource.kind,
        target: resource.target,
        entries,
      };
    }),
    platform,
  );
  const pathError = pathErrors[0];
  if (pathError?._tag === "InvalidTargetError") {
    return new PlannerInvalidResourcePathError({
      resource: pathError.id,
      path: pathError.target,
      reason: pathError.reason,
    });
  }
  if (pathError?._tag === "ConflictingResourceTargetError") {
    return new PlannerConflictingResourcePathError({
      resource: pathError.id,
      path: pathError.target,
      conflictsWith: pathError.conflictsWith,
      reason: pathError.reason,
    });
  }
  return undefined;
};

interface TransferPlan {
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly byBlob: ReadonlyMap<string, ActionId>;
  readonly requiredBlobs: ReadonlyArray<BlobId>;
}

type TransferResult =
  | { readonly ok: true; readonly transfer: TransferPlan }
  | { readonly ok: false; readonly error: MissingBlobMetadataError };

const planTransfers = (
  resources: ReadonlyArray<PublishedResource>,
  indexed: IndexedPlannerInput,
  availableBlobs: ReadonlySet<string>,
): TransferResult => {
  const blobOwners = new Map<string, string>();
  for (const resource of resources) {
    for (const blob of resource.blobs) {
      const owner = blobOwners.get(blob);
      if (owner === undefined || compareText(resource.id, owner) < 0) {
        blobOwners.set(blob, resource.id);
      }
    }
  }
  const required = [...blobOwners.keys()]
    .filter((blob) => !availableBlobs.has(blob))
    .sort(compareText);
  const actions: Array<PlannedAction> = [];
  const byBlob = new Map<string, ActionId>();
  for (const blob of required) {
    const metadata = indexed.blobs.get(blob);
    const owner = blobOwners.get(blob);
    if (metadata === undefined || owner === undefined) {
      return {
        ok: false,
        error: new MissingBlobMetadataError({
          resource: owner ?? "$unknown",
          blob,
        }),
      };
    }
    const id = actionId(`transfer:${blob}`);
    byBlob.set(blob, id);
    actions.push({
      id,
      resource: Schema.decodeUnknownSync(ResourceId)(owner),
      kind: "transfer-blob",
      detail: { kind: "transfer-blob", blob: metadata.id, bytes: metadata.bytes },
      before: [],
    });
  }
  return {
    ok: true,
    transfer: {
      actions,
      byBlob,
      requiredBlobs: required.map((blob) => Schema.decodeUnknownSync(BlobId)(blob)),
    },
  };
};

interface MaterializedDraft {
  readonly action: PlannedAction;
  readonly task?: PlannedAgentTask | undefined;
}

const materializeDraft = (
  draft: ResourceActionDraft,
  resource: PublishedResource,
  ordinal: number,
  prerequisites: ReadonlyArray<ActionId>,
): MaterializedDraft => {
  const id = actionId(`action:${resource.id}:${ordinal}:${draft.kind}`);
  if (draft.detail.kind === "agent-task") {
    const taskId = agentTaskId(`agent:${resource.id}:${ordinal}`);
    const task = draft.task;
    const detail: ActionDetail = {
      kind: "agent-task",
      taskId,
      summary: draft.detail.summary,
    };
    return {
      action: {
        id,
        resource: resource.id,
        kind: "agent-task",
        detail,
        before: sortedUnique(prerequisites),
      },
      task: task === undefined
        ? undefined
        : {
          ...task,
          id: taskId,
        },
    };
  }
  return {
    action: {
      id,
      resource: resource.id,
      kind: draft.detail.kind,
      detail: draft.detail,
      before: sortedUnique(prerequisites),
    },
  };
};

interface PlanBody {
  readonly revision: string;
  readonly follower: string;
  readonly requiredBlobs: ReadonlyArray<BlobId>;
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly agentTasks: ReadonlyArray<PlannedAgentTask>;
}

const encodePlan = (body: PlanBody): string => {
  const json = JSON.parse(JSON.stringify(body));
  return canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(json));
};

const buildPlan = (
  input: SynchronizationPlannerInput,
  indexed: IndexedPlannerInput,
  orderedResources: ReadonlyArray<PublishedResource>,
  transfer: TransferPlan,
): PlannedSynchronization => {
  const actions: Array<PlannedAction> = [...transfer.actions];
  const tasks: Array<PlannedAgentTask> = [];
  const terminalByResource = new Map<string, ActionId>();
  const removedResources = new Set(input.revision.removedResources ?? []);

  for (const resource of orderedResources) {
    const desired = indexed.desired.get(resource.id);
    const observed = indexed.observed.get(resource.id);
    if (desired === undefined || observed === undefined) continue;
    const context = {
      resource,
      desired,
      observed,
      overlayKeys: indexed.overlays.get(resource.id) ?? [],
      applied: indexed.applied.get(resource.id),
      platform: input.observedState.platform,
    };
    const drafts = removedResources.has(resource.id)
      ? planRemoved(context)
      : planResource(context);
    const resourcePrerequisites: Array<ActionId> = [];
    for (const dependency of sortedUnique(resource.dependsOn)) {
      const terminal = terminalByResource.get(dependency);
      if (terminal !== undefined) resourcePrerequisites.push(terminal);
    }
    for (const blob of sortedUnique(resource.blobs)) {
      const transferAction = transfer.byBlob.get(blob);
      if (transferAction !== undefined) resourcePrerequisites.push(transferAction);
    }
    let previous: ActionId | undefined;
    for (let ordinal = 0; ordinal < drafts.length; ordinal += 1) {
      const prerequisites = previous === undefined
        ? resourcePrerequisites
        : [...resourcePrerequisites, previous];
      const materialized = materializeDraft(
        drafts[ordinal],
        resource,
        ordinal,
        prerequisites,
      );
      actions.push(materialized.action);
      if (materialized.task !== undefined) tasks.push(materialized.task);
      previous = materialized.action.id;
    }
    if (previous !== undefined) terminalByResource.set(resource.id, previous);
  }

  const body: PlanBody = {
    revision: input.revision.id,
    follower: input.follower,
    requiredBlobs: transfer.requiredBlobs,
    actions,
    agentTasks: tasks,
  };
  const encoded = encodePlan(body);
  return {
    ...body,
    digest: sha256Hex(encoded),
    encoded,
  };
};

/** Pure planner entry point. Expected contract failures use the typed error channel. */
export const planSynchronization = (
  input: SynchronizationPlannerInput,
): Effect.Effect<PlannedSynchronization, SynchronizationPlanningError> =>
  Effect.suspend(() => {
    const indexResult = indexInput(input);
    if (!indexResult.ok) return Effect.fail(indexResult.error);
    const orderResult = orderResources(indexResult.indexed.resources);
    if (!orderResult.ok) return Effect.fail(orderResult.error);
    const validationError = validateResourceInputs(
      orderResult.resources,
      indexResult.indexed,
      input.observedState.platform,
    );
    if (validationError !== undefined) return Effect.fail(validationError);
    const transferResult = planTransfers(
      orderResult.resources,
      indexResult.indexed,
      new Set(input.observedState.availableBlobs),
    );
    if (!transferResult.ok) return Effect.fail(transferResult.error);
    return Effect.succeed(buildPlan(
      input,
      indexResult.indexed,
      orderResult.resources,
      transferResult.transfer,
    ));
  });
