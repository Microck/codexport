import { Schema } from "effect";
import { sourceTextIssue } from "./text-composition.ts";

import type {
  ContentDigest,
  CredentialReference,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
} from "./brand.ts";
import {
  defaultPolicyForKind,
  ApplyPolicy as ApplyPolicySchema,
  BuildPolicy as BuildPolicySchema,
  FilesystemMode as FilesystemModeSchema,
  ResourceKind as ResourceKindSchema,
  AgentInstallBounds,
  ToolRecipeRef,
  policyCompatibleWithKind,
  type Platform,
  type RecipeMethod,
  type RecipeIndexPolicy,
  type RecipeSource,
  type ResourceKind,
  type ApplyPolicy,
} from "./resource.ts";
import {
  canonicalRecipeIndexUrl,
  recipeValidationError,
} from "./recipe-versions.ts";
import {
  BlobId,
  ContentDigest as ContentDigestSchema,
  CredentialReference as CredentialReferenceSchema,
  GroupName,
  ProfileId as ProfileIdSchema,
  ProfileRevisionId as ProfileRevisionIdSchema,
  ResourceId as ResourceIdSchema,
  SourceSignature,
  Timestamp,
  ToolId,
} from "./brand.ts";
import {
  canonicalJson,
  decodeJsonc,
  digestOf,
  sha256Hex,
  type JsonValue,
} from "../profile/profile-codec.ts";

/**
 * Machine Profile authoring and published types, plus validation decisions:
 * unique ids, dependency existence, acyclic dependency graph, valid targets,
 * and policy-kind compatibility. These are pure functions over decoded data.
 */

/** Authoring-time Machine Profile (parsed from profile.jsonc). */
export interface MachineProfile {
  readonly id: ProfileId;
  readonly version: number;
  readonly name: string;
  readonly groups: ReadonlyArray<ProfileGroup>;
  readonly resources: ReadonlyArray<ProfileResourceInput>;
  /**
   * The cadence a follower inherits when it has not chosen its own.
   *
   * Optional: a profile may decline to schedule anything. A default used to be
   * filled in when none was authored, so every follower got one whether or not
   * the operator wanted scheduled synchronization, and a host with no working
   * user scheduler could never converge.
   */
  readonly scheduleDefault?: ScheduleDefault | undefined;
}

export interface ProfileGroup {
  readonly name: string;
  readonly description?: string | undefined;
}

/**
 * The cadence a Follower Machine inherits from its Machine Profile.
 *
 * Deliberately narrower than what a follower may set for itself. A profile is
 * applied by every follower, so it may only declare what every backend can
 * render: daily or weekly, in the follower's own timezone. A `custom`
 * expression or a named timezone published here was accepted and then refused
 * at apply by launchd and Windows Task Scheduler, so those followers ended up
 * with no scheduled synchronization and, before the reconciliation moved out
 * of the resource transaction, could not converge at all.
 *
 * A follower that wants a backend-specific calendar or a named timezone sets
 * one locally with `canonfig schedule set`, where it is that machine's
 * business and only that machine has to be able to render it.
 */
export type ScheduleDefault =
  | { readonly type: "daily"; readonly at: string; readonly timezone: "local" }
  | { readonly type: "weekly"; readonly days: ReadonlyArray<string>; readonly at: string; readonly timezone: "local" };

/** A resource as authored (before content addressing). */
export interface ProfileResourceInput {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly policy?: ApplyPolicy | undefined;
  readonly target: string;
  readonly groups?: ReadonlyArray<string> | undefined;
  readonly dependsOn?: ReadonlyArray<string> | undefined;
  readonly spec: ResourceSpecInput;
  readonly verify: VerificationInput;
}

export type ResourceSpecInput =
  | { readonly kind: "file"; readonly content: string; readonly executable?: boolean | undefined; readonly mode?: number | undefined; readonly symlinkTo?: string | undefined }
  | { readonly kind: "directory"; readonly mode?: number | undefined; readonly directories?: ReadonlyArray<{ readonly path: string; readonly mode: number }>; readonly files: ReadonlyArray<{ readonly path: string; readonly content: string; readonly executable?: boolean | undefined; readonly mode?: number | undefined; readonly symlinkTo?: string | undefined }> }
  | { readonly kind: "config"; readonly format: "toml" | "json" | "yaml"; readonly keys: ReadonlyArray<{ readonly path: string; readonly value: string | number | boolean | ReadonlyArray<string> }> }
  | { readonly kind: "skill"; readonly name: string; readonly mode?: number | undefined; readonly directories?: ReadonlyArray<{ readonly path: string; readonly mode: number }>; readonly files: ReadonlyArray<{ readonly path: string; readonly content: string; readonly executable?: boolean | undefined; readonly mode?: number | undefined; readonly symlinkTo?: string | undefined }> }
  | { readonly kind: "tool"; readonly toolId: string; readonly recipes: ReadonlyArray<{ readonly platform: Platform; readonly method: RecipeMethod; readonly package: string; readonly version?: string | undefined; readonly indexPolicy?: RecipeIndexPolicy | undefined; readonly buildPolicy?: Schema.Schema.Type<typeof BuildPolicySchema> | undefined; readonly source?: RecipeSource | undefined }>; readonly login?: { readonly required: boolean; readonly howTo?: string | undefined } | undefined; readonly agentInstall?: { readonly paths: ReadonlyArray<string>; readonly origins?: ReadonlyArray<string> | undefined } | undefined }
  | { readonly kind: "credential"; readonly reference: string };

export type VerificationInput =
  | { readonly method: "digest"; readonly digest: string }
  | { readonly method: "command"; readonly command: ReadonlyArray<string>; readonly expectContains?: string | undefined }
  | { readonly method: "executable-present"; readonly executable: string }
  | { readonly method: "credential-present"; readonly reference: string }
  | { readonly method: "symlink"; readonly target: string };

/** An immutable, authenticated publication of a Machine Profile. */
export interface ProfileRevision {
  readonly id: ProfileRevisionId;
  readonly profileId: ProfileId;
  readonly sequence: number;
  readonly canonicalBytes: string;
  readonly digest: string;
  readonly signature: string;
  readonly publishedAt: string;
  readonly resources: ReadonlyArray<PublishedResource>;
  readonly groups: ReadonlyArray<ProfileGroup>;
  /** Optional for revisions written before schedule defaults were transported. */
  readonly scheduleDefault?: ScheduleDefault | undefined;
}

export interface PublishedResource {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  readonly policy: ApplyPolicy;
  readonly target: string;
  readonly groups?: ReadonlyArray<string> | undefined;
  readonly dependsOn: ReadonlyArray<ResourceId>;
  readonly blobs: ReadonlyArray<string>;
}

/** A candidate Machine Profile change from discovery or an agent. */
export interface ProfileChangeProposal {
  readonly createdAt: string;
  readonly reason: string;
  readonly additions: ReadonlyArray<ProfileResourceInput>;
  readonly modifications: ReadonlyArray<ProfileResourceInput>;
  readonly removals: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<DiscoveryEvidenceRecord>;
}

export interface DiscoveryEvidenceRecord {
  readonly source: string;
  readonly line: number;
  readonly excerpt: string;
  readonly kind: "invocation" | "config" | "hook" | "mcp" | "package-metadata" | "prose";
}

export interface CredentialDescriptor {
  readonly reference: CredentialReference;
  readonly description: string;
  readonly loginRequired: boolean;
}

const ConfigValueInputSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

const AuthoringFileSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  content: Schema.String,
  executable: Schema.optional(Schema.Boolean),
  mode: Schema.optional(FilesystemModeSchema),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});

const AuthoringDirectoryFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  content: Schema.String,
  executable: Schema.optional(Schema.Boolean),
  mode: Schema.optional(FilesystemModeSchema),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});

const AuthoringDirectorySchema = Schema.Struct({
  path: Schema.NonEmptyString,
  mode: FilesystemModeSchema,
});

const AuthoringLoginSchema = Schema.Union([
  Schema.Struct({ required: Schema.Literal(false) }),
  Schema.Struct({
    required: Schema.Literal(true),
    howTo: Schema.NonEmptyString,
  }),
]);

export const ResourceSpecInputSchema = Schema.Union([
  AuthoringFileSchema,
  Schema.Struct({
    kind: Schema.Literal("directory"),
    mode: Schema.optional(FilesystemModeSchema),
    directories: Schema.optional(Schema.Array(AuthoringDirectorySchema)),
    files: Schema.Array(AuthoringDirectoryFileSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("config"),
    format: Schema.Literals(["toml", "json", "yaml"]),
    keys: Schema.Array(Schema.Struct({
      path: Schema.NonEmptyString,
      value: ConfigValueInputSchema,
    })),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: Schema.NonEmptyString,
    mode: Schema.optional(FilesystemModeSchema),
    directories: Schema.optional(Schema.Array(AuthoringDirectorySchema)),
    files: Schema.Array(AuthoringDirectoryFileSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    toolId: ToolId,
    recipes: Schema.Array(ToolRecipeRef),
    login: Schema.optional(AuthoringLoginSchema),
    agentInstall: Schema.optional(AgentInstallBounds),
  }),
  Schema.Struct({
    kind: Schema.Literal("credential"),
    reference: CredentialReferenceSchema,
  }),
]);

export const VerificationInputSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("digest"), digest: ContentDigestSchema }),
  Schema.Struct({
    method: Schema.Literal("command"),
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("executable-present"),
    executable: Schema.NonEmptyString,
  }),
  Schema.Struct({
    method: Schema.Literal("credential-present"),
    reference: CredentialReferenceSchema,
  }),
  Schema.Struct({ method: Schema.Literal("symlink"), target: Schema.NonEmptyString }),
]);

const verificationAllowedForSpec = (
  kind: ResourceKind,
  spec: ResourceSpecInput,
  method: VerificationInput["method"],
): boolean => {
  if (spec.kind !== kind) return verificationAllowed(kind, method);
  if (spec.kind === "file") {
    return spec.symlinkTo === undefined
      ? method === "digest"
      : method === "symlink";
  }
  return verificationAllowed(kind, method);
};

const appendLocalIssue = (resource: Pick<ProfileResourceInput, "policy" | "spec">): string | undefined => {
  if (resource.policy !== "append-local" || resource.spec.kind !== "file") return undefined;
  const spec = resource.spec;
  return spec.symlinkTo !== undefined || spec.executable === true || ((spec.mode ?? 0) & 0o111) !== 0
    ? "append-local requires a non-executable regular text file"
    : sourceTextIssue(spec.content);
};

const verificationContentIssue = (
  resource: Pick<ProfileResourceInput, "kind" | "spec" | "verify">,
): string | undefined => {
  if (resource.kind !== "file" || resource.spec.kind !== "file") return undefined;
  if (resource.spec.symlinkTo === undefined) {
    return resource.verify.method === "digest"
      && resource.verify.digest !== sha256Hex(resource.spec.content)
      ? "digest verification does not match authored file content"
      : undefined;
  }
  return resource.verify.method === "symlink"
    && resource.verify.target !== resource.spec.symlinkTo
    ? "symlink verification target does not match authored symlink target"
    : undefined;
};

export const ProfileResourceInputSchema = Schema.Struct({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  policy: Schema.optional(ApplyPolicySchema),
  target: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(GroupName)),
  dependsOn: Schema.optional(Schema.Array(ResourceIdSchema)),
  spec: ResourceSpecInputSchema,
  verify: VerificationInputSchema,
}).check(
  Schema.makeFilter((resource) => {
    const policy = resource.policy ?? defaultPolicyForKind[resource.kind];
    if (!policyCompatibleWithKind(resource.kind, policy)) {
      return {
        path: ["policy"],
        issue: `policy ${policy} is not compatible with resource kind ${resource.kind}`,
      };
    }
    const verificationIssue = verificationContentIssue(resource);
    if (verificationIssue !== undefined) {
      return {
        path: ["verify"],
        issue: verificationIssue,
      };
    }
    const compositionIssue = appendLocalIssue(resource);
    return compositionIssue === undefined ? undefined : { path: ["spec"], issue: compositionIssue };
  }),
);

export const ProfileGroupSchema = Schema.Struct({
  name: GroupName,
  description: Schema.optional(Schema.NonEmptyString),
});

export const ScheduleDefaultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("daily"),
    at: Schema.NonEmptyString,
    timezone: Schema.Literal("local"),
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    days: Schema.Array(Schema.NonEmptyString),
    at: Schema.NonEmptyString,
    timezone: Schema.Literal("local"),
  }),
]);

/** Strict schema for the normalized v2 authoring contract. */
export const MachineProfileSchema = Schema.Struct({
  id: ProfileIdSchema,
  version: Schema.Literal(2),
  name: Schema.NonEmptyString,
  groups: Schema.Array(ProfileGroupSchema),
  resources: Schema.Array(ProfileResourceInputSchema),
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
});

/** Authoring schema permits only documented fields and fills omissions in normalization. */
export const MachineProfileAuthoringSchema = Schema.Struct({
  id: ProfileIdSchema,
  version: Schema.optional(Schema.Literal(2)),
  name: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(ProfileGroupSchema)),
  resources: Schema.optional(Schema.Array(ProfileResourceInputSchema)),
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
});

export const PublishedResourceSchema = Schema.Struct({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  policy: ApplyPolicySchema,
  target: Schema.NonEmptyString,
  groups: Schema.optional(Schema.Array(GroupName)),
  dependsOn: Schema.Array(ResourceIdSchema),
  blobs: Schema.Array(BlobId),
});

export const ProfileRevisionSchema = Schema.Struct({
  id: ProfileRevisionIdSchema,
  profileId: ProfileIdSchema,
  sequence: Schema.Natural,
  canonicalBytes: Schema.String,
  digest: ContentDigestSchema,
  signature: SourceSignature,
  publishedAt: Timestamp,
  resources: Schema.Array(PublishedResourceSchema),
  groups: Schema.Array(ProfileGroupSchema),
  scheduleDefault: Schema.optional(ScheduleDefaultSchema),
});

export const DiscoveryEvidenceRecordSchema = Schema.Struct({
  source: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  excerpt: Schema.String,
  kind: Schema.Literals([
    "invocation",
    "config",
    "hook",
    "mcp",
    "package-metadata",
    "prose",
  ]),
});

export const ProfileChangeProposalSchema = Schema.Struct({
  createdAt: Timestamp,
  reason: Schema.NonEmptyString,
  additions: Schema.Array(ProfileResourceInputSchema),
  modifications: Schema.Array(ProfileResourceInputSchema),
  removals: Schema.Array(ResourceIdSchema),
  evidence: Schema.Array(DiscoveryEvidenceRecordSchema),
});

export const CredentialDescriptorSchema = Schema.Struct({
  reference: CredentialReferenceSchema,
  description: Schema.NonEmptyString,
  loginRequired: Schema.Boolean,
});

/** Runtime schema aliases share names with their corresponding domain types. */
export const ResourceSpecInput = ResourceSpecInputSchema;
export const VerificationInput = VerificationInputSchema;
export const ProfileResourceInput = ProfileResourceInputSchema;
export const ProfileGroup = ProfileGroupSchema;
export const ScheduleDefault = ScheduleDefaultSchema;
export const MachineProfile = MachineProfileSchema;
export const PublishedResource = PublishedResourceSchema;
export const ProfileRevision = ProfileRevisionSchema;
export const DiscoveryEvidenceRecord = DiscoveryEvidenceRecordSchema;
export const ProfileChangeProposal = ProfileChangeProposalSchema;
export const CredentialDescriptor = CredentialDescriptorSchema;

/**
 * Validation failures as tagged errors.
 */
export class DuplicateResourceError extends Schema.TaggedError<DuplicateResourceError>()(
  "DuplicateResourceError",
  { id: Schema.String },
) {}

export class MissingDependencyError extends Schema.TaggedError<MissingDependencyError>()(
  "MissingDependencyError",
  { id: Schema.String, dependsOn: Schema.String },
) {}

export class DependencyCycleError extends Schema.TaggedError<DependencyCycleError>()(
  "DependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {}

export class PolicyKindMismatchError extends Schema.TaggedError<PolicyKindMismatchError>()(
  "PolicyKindMismatchError",
  { id: Schema.String, kind: Schema.String, policy: Schema.String },
) {}

export class InvalidTargetError extends Schema.TaggedError<InvalidTargetError>()(
  "InvalidTargetError",
  { id: Schema.String, target: Schema.String, reason: Schema.String },
) {}

export class ConflictingResourceTargetError extends Schema.TaggedError<ConflictingResourceTargetError>()(
  "ConflictingResourceTargetError",
  {
    id: Schema.String,
    target: Schema.String,
    conflictsWith: Schema.String,
    reason: Schema.String,
  },
) {}

/** A normalized filesystem claim used by profile and planner boundaries. */
export interface ResourcePathResource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly target: string;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly kind: "directory" | "leaf";
  }>;
}

export class InvalidScheduleError extends Schema.TaggedError<InvalidScheduleError>()(
  "InvalidScheduleError",
  { id: Schema.String, reason: Schema.String },
) {}

export class DuplicateGroupError extends Schema.TaggedError<DuplicateGroupError>()(
  "DuplicateGroupError",
  { name: Schema.String },
) {}

export class MissingGroupReferenceError extends Schema.TaggedError<MissingGroupReferenceError>()(
  "MissingGroupReferenceError",
  { id: Schema.String, group: Schema.String },
) {}

export class ResourceSpecKindMismatchError extends Schema.TaggedError<ResourceSpecKindMismatchError>()(
  "ResourceSpecKindMismatchError",
  { id: Schema.String, kind: Schema.String, specKind: Schema.String },
) {}

export class VerificationKindMismatchError extends Schema.TaggedError<VerificationKindMismatchError>()(
  "VerificationKindMismatchError",
  { id: Schema.String, kind: Schema.String, method: Schema.String },
) {}

export class VerificationContentMismatchError extends Schema.TaggedError<VerificationContentMismatchError>()(
  "VerificationContentMismatchError",
  { id: Schema.String, method: Schema.String, reason: Schema.String },
) {}

export class UnmanageableFilesystemModeError extends Schema.TaggedError<UnmanageableFilesystemModeError>()(
  "UnmanageableFilesystemModeError",
  { id: Schema.String, path: Schema.String, mode: Schema.Int, reason: Schema.String },
) {}

export class InvalidBuildPolicyError extends Schema.TaggedError<InvalidBuildPolicyError>()(
  "InvalidBuildPolicyError",
  { id: Schema.String, reason: Schema.String },
) {}

export class InvalidRecipeError extends Schema.TaggedError<InvalidRecipeError>()(
  "InvalidRecipeError",
  { id: Schema.String, reason: Schema.String },
) {}

export class InvalidTextCompositionError extends Schema.TaggedError<InvalidTextCompositionError>()(
  "InvalidTextCompositionError",
  { id: Schema.String, reason: Schema.String },
) {}

export type ProfileValidationError =
  | DuplicateResourceError
  | MissingDependencyError
  | DependencyCycleError
  | PolicyKindMismatchError
  | InvalidTargetError
  | ConflictingResourceTargetError
  | InvalidScheduleError
  | DuplicateGroupError
  | MissingGroupReferenceError
  | ResourceSpecKindMismatchError
  | VerificationKindMismatchError
  | VerificationContentMismatchError
  | UnmanageableFilesystemModeError
  | InvalidBuildPolicyError
  | InvalidTextCompositionError
  | InvalidRecipeError;

/** Aggregate contract failure preserving all precise tagged graph errors. */
export class ProfileContractError extends Error {
  readonly errors: ReadonlyArray<ProfileValidationError>;

  constructor(errors: ReadonlyArray<ProfileValidationError>) {
    super(errors.map((error) => error._tag).join(", "));
    this.name = "ProfileContractError";
    this.errors = errors;
  }
}

export const validateMachineProfile = (
  profile: MachineProfile,
  platform: Platform = "windows",
): ReadonlyArray<ProfileValidationError> => {
  const errors: Array<ProfileValidationError> = [];
  const groups = new Set<string>();
  for (const group of profile.groups) {
    if (groups.has(group.name)) {
      errors.push(new DuplicateGroupError({ name: group.name }));
    }
    groups.add(group.name);
  }
  errors.push(...validateProfileResources(profile.resources, groups, platform));
  const scheduleError = profile.scheduleDefault === undefined
    ? null
    : validateScheduleDefault(profile.scheduleDefault);
  if (scheduleError !== null) errors.push(scheduleError);
  return errors;
};

/** Validate resource graph: returns every violation, not just the first. */
export const validateProfileResources = (
  resources: ReadonlyArray<ProfileResourceInput>,
  declaredGroups?: ReadonlySet<string>,
  platform: Platform = "windows",
): ReadonlyArray<ProfileValidationError> => {
  const errors: Array<ProfileValidationError> = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource.id)) {
      errors.push(new DuplicateResourceError({ id: resource.id }));
    }
    seen.add(resource.id);
  }
  const byId = new Map(resources.map((resource) => [resource.id, resource] as const));
  for (const resource of resources) {
    if (resource.spec.kind !== resource.kind) {
      errors.push(new ResourceSpecKindMismatchError({
        id: resource.id,
        kind: resource.kind,
        specKind: resource.spec.kind,
      }));
    }
    for (const dep of resource.dependsOn ?? []) {
      if (!byId.has(dep)) {
        errors.push(new MissingDependencyError({ id: resource.id, dependsOn: dep }));
      }
    }
    if (declaredGroups !== undefined) {
      for (const group of resource.groups ?? []) {
        if (!declaredGroups.has(group)) {
          errors.push(new MissingGroupReferenceError({ id: resource.id, group }));
        }
      }
    }
    const kind = resource.kind;
    const policy = resource.policy ?? defaultPolicy(kind);
    if (!policyAllowed(kind, policy)) {
      errors.push(new PolicyKindMismatchError({ id: resource.id, kind, policy }));
    }
    errors.push(...validateRecipes(resource));
    const compositionIssue = appendLocalIssue(resource);
    if (compositionIssue !== undefined) {
      errors.push(new InvalidTextCompositionError({ id: resource.id, reason: compositionIssue }));
    }
    errors.push(...validateVerificationContent(resource));
    errors.push(...validateFilesystemModes(resource));
    errors.push(...validateBuildPolicies(resource));
    if (!verificationAllowedForSpec(resource.kind, resource.spec, resource.verify.method)) {
      errors.push(new VerificationKindMismatchError({
        id: resource.id,
        kind: resource.kind,
        method: resource.verify.method,
      }));
    }
  }
  errors.push(...validateResourceTargetConflicts(resources, platform));
  const cycle = findDependencyCycle(resources);
  if (cycle !== null) errors.push(new DependencyCycleError({ cycle }));
  return errors;
};

const validateFilesystemModes = (
  resource: ProfileResourceInput,
): ReadonlyArray<UnmanageableFilesystemModeError> => {
  const errors: Array<UnmanageableFilesystemModeError> = [];
  const regularFile = (path: string, mode: number): void => {
    if ((mode & 0o400) !== 0) return;
    errors.push(new UnmanageableFilesystemModeError({
      id: resource.id,
      path,
      mode,
      reason: "managed regular files must remain owner-readable for digest verification",
    }));
  };
  const directory = (path: string, mode: number): void => {
    if ((mode & 0o500) === 0o500) return;
    errors.push(new UnmanageableFilesystemModeError({
      id: resource.id,
      path,
      mode,
      reason: "managed directories must remain owner-readable and owner-traversable for tree verification",
    }));
  };

  switch (resource.spec.kind) {
    case "file":
      if (resource.spec.symlinkTo === undefined) {
        regularFile(resource.target, resource.spec.mode ?? (resource.spec.executable === true ? 0o700 : 0o600));
      }
      break;
    case "directory":
    case "skill":
      directory(resource.target, resource.spec.mode ?? 0o700);
      for (const entry of resource.spec.directories ?? []) directory(entry.path, entry.mode);
      for (const file of resource.spec.files) {
        if (file.symlinkTo === undefined) {
          regularFile(file.path, file.mode ?? (file.executable === true ? 0o700 : 0o600));
        }
      }
      break;
    case "config":
    case "tool":
    case "credential":
      break;
  }
  return errors;
};

const validateRecipes = (
  resource: ProfileResourceInput,
): ReadonlyArray<InvalidRecipeError> => {
  if (resource.spec.kind !== "tool") return [];
  return resource.spec.recipes.flatMap((recipe) => {
    const reason = recipeValidationError(recipe);
    return reason === undefined
      ? []
      : [new InvalidRecipeError({
        id: resource.id,
        reason: `recipe ${recipe.method}/${recipe.package}: ${reason}`,
      })];
  });
};

const validateVerificationContent = (
  resource: ProfileResourceInput,
): ReadonlyArray<VerificationContentMismatchError> => {
  const reason = verificationContentIssue(resource);
  return reason !== undefined
    ? [new VerificationContentMismatchError({
      id: resource.id,
      method: resource.verify.method,
      reason,
    })]
    : [];
};

const validateBuildPolicies = (
  resource: ProfileResourceInput,
): ReadonlyArray<InvalidBuildPolicyError> => {
  if (resource.spec.kind !== "tool") return [];
  const errors: Array<InvalidBuildPolicyError> = [];
  for (const recipe of resource.spec.recipes) {
    const policy = recipe.buildPolicy ?? { mode: "scripts-disabled" as const };
    if (policy.mode === "scripts-disabled") continue;
    if (!Number.isFinite(Date.parse(policy.reviewedAt))) {
      errors.push(new InvalidBuildPolicyError({
        id: resource.id,
        reason: `recipe ${recipe.method}/${recipe.package} has an invalid review timestamp`,
      }));
    }
    if (
      policy.executables.length === 0
      || policy.paths.length === 0
      || policy.steps.length === 0
    ) {
      errors.push(new InvalidBuildPolicyError({
        id: resource.id,
        reason: `recipe ${recipe.method}/${recipe.package} requires executable, path, and build-step bounds`,
      }));
    }
    if (!policy.capabilities.includes("execute")) {
      errors.push(new InvalidBuildPolicyError({
        id: resource.id,
        reason: `recipe ${recipe.method}/${recipe.package} must explicitly allow execute`,
      }));
    }
    if (policy.steps.some((step) => !policy.executables.includes(step.executable))) {
      errors.push(new InvalidBuildPolicyError({
        id: resource.id,
        reason: `recipe ${recipe.method}/${recipe.package} has an unbounded build executable`,
      }));
    }
    for (const origin of policy.origins) {
      try {
        const url = new URL(origin);
        if (url.protocol !== "https:" || url.origin !== origin) {
          errors.push(new InvalidBuildPolicyError({
            id: resource.id,
            reason: `recipe ${recipe.method}/${recipe.package} has a non-exact HTTPS origin`,
          }));
        }
      } catch {
        errors.push(new InvalidBuildPolicyError({
          id: resource.id,
          reason: `recipe ${recipe.method}/${recipe.package} has an invalid origin`,
        }));
      }
    }
  }
  return errors;
};

const defaultPolicy = (kind: ResourceKind): ApplyPolicy => {
  return defaultPolicyForKind[kind];
};

const policyAllowed = (kind: ResourceKind, policy: ApplyPolicy): boolean => {
  return policyCompatibleWithKind(kind, policy);
};

const verificationAllowed = (
  kind: ResourceKind,
  method: VerificationInput["method"],
): boolean => {
  switch (kind) {
    case "file":
      return method === "digest" || method === "symlink" || method === "command";
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

const invalidTargetReason = (target: string): string | undefined => {
  if (target.trim().length === 0) {
    return "empty target";
  }
  if (target.includes("\0")) {
    return "null byte in target";
  }
  const pathSegments = target.replaceAll("\\", "/").split("/");
  if (pathSegments.some((segment) => segment === "..")) {
    return "parent traversal in target";
  }
  if (/[*?[\]]/u.test(target)) {
    return "glob in target";
  }
  return undefined;
};

interface ResourceTargetClaim {
  readonly resource: ResourcePathResource;
  readonly path: string;
  readonly namespace: "filesystem" | "schedule";
  readonly rawPath: string;
  readonly isRoot: boolean;
  readonly isDirectory: boolean;
}

const normalizedTargetPath = (value: string, platform: Platform = "windows"): string => {
  const slashSeparated = value.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):(?=\/|$)/u.exec(slashSeparated);
  const prefix = drive === null
    ? slashSeparated.startsWith("/")
      ? "/"
      : ""
    : `${drive[1]!.toLowerCase()}:`;
  const body = drive === null
    ? slashSeparated
    : slashSeparated.slice(2);
  const segments: Array<string> = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment.normalize("NFC"));
  }
  const normalized = segments.join("/");
  const normalizedValue = prefix === "/"
    ? normalized.length === 0 ? "/" : `/${normalized}`
    : prefix.length > 0
    ? normalized.length === 0 ? `${prefix}/` : `${prefix}/${normalized}`
    : normalized.length === 0 ? "." : normalized;
  return platform === "windows" ? normalizedValue.toLowerCase() : normalizedValue;
};

const invalidRelativeTargetReason = (
  path: string,
  platform: Platform,
): string | undefined => {
  if (path.trim().length === 0) return "empty managed file path";
  if (path.includes("\0")) return "null byte in managed file path";
  if (
    path.startsWith("/")
    || path.startsWith("\\")
    || /^[A-Za-z]:/u.test(path)
  ) {
    return "managed file path must be relative to its resource target";
  }
  if (path.replaceAll("\\", "/").split("/").some((segment) => segment === "..")) {
    return "parent traversal in managed file path";
  }
  if (path.includes("\\")) return "alternate path separator in managed file path";
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    return "managed file path is not canonical";
  }
  if (path.normalize("NFC") !== path) {
    return "managed file path is not canonical";
  }
  if (platform === "windows") {
    for (const segment of segments) {
      if (/[<>:"|?*]/u.test(segment)) {
        return "reserved character in managed file path";
      }
      if (segment.endsWith(".") || segment.endsWith(" ")) {
        return "trailing dot or space in managed file path";
      }
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
        return "reserved Windows name in managed file path";
      }
    }
  }
  if (/[*?[\]]/u.test(path)) return "glob in managed file path";
  return undefined;
};

interface CanonicalResourcePathClaim {
  readonly resource: ResourcePathResource;
  readonly rawPath: string;
  readonly path: string;
  readonly isDirectory: boolean;
}

interface CanonicalResourcePathClaimsResult {
  readonly claims: ReadonlyArray<CanonicalResourcePathClaim>;
  readonly errors: ReadonlyArray<InvalidTargetError>;
}

const resourceEntries = (
  resource: ProfileResourceInput,
): ResourcePathResource["entries"] => {
  if (resource.spec.kind !== "directory" && resource.spec.kind !== "skill") return [];
  return [
    ...resource.spec.files.map((file) => ({
      path: file.path,
      kind: "leaf" as const,
    })),
    ...(resource.spec.directories ?? []).map((directory) => ({
      path: directory.path,
      kind: "directory" as const,
    })),
  ];
};

const canonicalResourcePathClaims = (
  resource: ResourcePathResource,
  platform: Platform,
): CanonicalResourcePathClaimsResult => {
  const claims: Array<CanonicalResourcePathClaim> = [];
  const errors: Array<InvalidTargetError> = [];
  for (const entry of [...resource.entries].sort((left, right) =>
    compareText(left.path, right.path)
  )) {
    const rawPath = entry.path;
    const reason = invalidRelativeTargetReason(rawPath, platform);
    if (reason !== undefined) {
      errors.push(new InvalidTargetError({
        id: resource.id,
        target: rawPath,
        reason,
      }));
      continue;
    }
    claims.push({
      resource,
      rawPath,
      path: normalizedTargetPath(`${resource.target}/${rawPath}`, platform),
      isDirectory: entry.kind === "directory",
    });
  }
  return { claims, errors };
};

/**
 * Validate filesystem claims at a profile or planner boundary. The resource
 * target itself is the explicitly represented directory ancestry. Each
 * declared entry states whether it is another directory or a leaf.
 */
export const validateResourcePathConflicts = (
  resources: ReadonlyArray<ResourcePathResource>,
  platform: Platform = "windows",
): ReadonlyArray<ProfileValidationError> => {
  const errors: Array<ProfileValidationError> = [];
  const orderedResources = [...resources].sort((left, right) =>
    compareText(left.id, right.id)
  );
  const claimsByResource = new Map<string, ReadonlyArray<CanonicalResourcePathClaim>>();
  for (const resource of orderedResources) {
    const targetReason = invalidTargetReason(resource.target);
    if (targetReason !== undefined) {
      errors.push(new InvalidTargetError({
        id: resource.id,
        target: resource.target,
        reason: targetReason,
      }));
    }
    const result = canonicalResourcePathClaims(resource, platform);
    errors.push(...result.errors);
    claimsByResource.set(resource.id, result.claims);
  }
  const claims = orderedResources
    .flatMap((resource) => {
      if (
        resource.kind !== "file"
        && resource.kind !== "directory"
        && resource.kind !== "config"
        && resource.kind !== "skill"
      ) return [];
      const root: ResourceTargetClaim = {
        resource,
        path: normalizedTargetPath(resource.target, platform),
        rawPath: resource.target,
        namespace: "filesystem",
        isRoot: true,
        isDirectory: resource.kind === "directory" || resource.kind === "skill",
      };
      return [
        root,
        ...(claimsByResource.get(resource.id) ?? []).map((claim) => ({
          resource,
          path: claim.path,
          rawPath: claim.rawPath,
          namespace: "filesystem" as const,
          isRoot: false,
          isDirectory: claim.isDirectory,
        })),
      ];
    })
    .sort((left, right) =>
      compareText(left.resource.id, right.resource.id)
      || compareText(left.path, right.path)
      || compareText(left.rawPath, right.rawPath)
    );
  const overlaps = (left: string, right: string): boolean =>
    left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index]!;
    for (let otherIndex = index + 1; otherIndex < claims.length; otherIndex += 1) {
      const other = claims[otherIndex]!;
      if (
        claim.namespace !== other.namespace
        || !overlaps(claim.path, other.path)
      ) {
        continue;
      }
      if (claim.resource.id === other.resource.id) {
        if (claim.isRoot || other.isRoot) continue;
        if (claim.rawPath === other.rawPath) {
          errors.push(new ConflictingResourceTargetError({
            id: claim.resource.id,
            target: claim.rawPath,
            conflictsWith: other.resource.id,
            reason: `managed path ${claim.path} is declared more than once`,
          }));
        } else {
          const ancestor = claim.path.startsWith(`${other.path}/`)
            ? other
            : other.path.startsWith(`${claim.path}/`)
            ? claim
            : undefined;
          if (ancestor?.isDirectory === true) continue;
          errors.push(new ConflictingResourceTargetError({
            id: claim.resource.id,
            target: claim.rawPath,
            conflictsWith: other.resource.id,
            reason: `managed path ${claim.path} overlaps managed path ${other.path}`,
          }));
        }
        continue;
      }
      const duplicate = errors.some((error) =>
        error._tag === "ConflictingResourceTargetError"
        && error.id === claim.resource.id
        && error.conflictsWith === other.resource.id
      );
      if (!duplicate) {
        errors.push(new ConflictingResourceTargetError({
          id: claim.resource.id,
          target: claim.resource.target,
          conflictsWith: other.resource.id,
          reason: `target ${claim.path} overlaps target ${other.path}`,
        }));
      }
    }
  }
  return errors;
};

const pathClaimsResource = (
  resource: ProfileResourceInput,
): ResourcePathResource => ({
  id: resource.id,
  kind: resource.kind,
  target: resource.target,
  entries: resourceEntries(resource),
});

const validateResourceTargetConflicts = (
  resources: ReadonlyArray<ProfileResourceInput>,
  platform: Platform,
): ReadonlyArray<ProfileValidationError> =>
  validateResourcePathConflicts(
    resources.map(pathClaimsResource),
    platform,
  );

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/u;
const dayNames = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const validateScheduleDefault = (
  schedule: ScheduleDefault,
): InvalidScheduleError | null => {
  if (schedule.type === "daily" && !timePattern.test(schedule.at)) {
    return new InvalidScheduleError({
      id: "$scheduleDefault",
      reason: `invalid daily time ${schedule.at}`,
    });
  }
  if (schedule.type === "weekly") {
    if (!timePattern.test(schedule.at)) {
      return new InvalidScheduleError({
        id: "$scheduleDefault",
        reason: `invalid weekly time ${schedule.at}`,
      });
    }
    if (schedule.days.length === 0) {
      return new InvalidScheduleError({
        id: "$scheduleDefault",
        reason: "weekly schedule needs at least one day",
      });
    }
    for (const day of schedule.days) {
      if (!dayNames.has(day)) {
        return new InvalidScheduleError({
          id: "$scheduleDefault",
          reason: `unknown day ${day}`,
        });
      }
    }
  }
  return null;
};


/** Detect a dependency cycle; returns one cycle path or null. */
export const findDependencyCycle = (
  resources: ReadonlyArray<ProfileResourceInput>,
): ReadonlyArray<string> | null => {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const resource of resources) {
    graph.set(resource.id, resource.dependsOn ?? []);
  }
  const visiting: Array<string> = [];
  const visited = new Set<string>();
  const dfs = (node: string): ReadonlyArray<string> | null => {
    if (visited.has(node)) return null;
    const index = visiting.indexOf(node);
    if (index >= 0) return [...visiting.slice(index), node];
    visiting.push(node);
    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      const found = dfs(dep);
      if (found !== null) return found;
    }
    visiting.pop();
    visited.add(node);
    return null;
  };
  for (const resource of resources) {
    const found = dfs(resource.id);
    if (found !== null) return found;
  }
  return null;
};

/** Topological order of resource ids; deterministic (stable input order, deps first). */
export const topologicalOrder = (
  resources: ReadonlyArray<ProfileResourceInput>,
): ReadonlyArray<string> => {
  const byId = new Map(resources.map((r) => [r.id, r] as const));
  const ordered: Array<string> = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (emitted.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const resource = byId.get(id);
    if (resource !== undefined) {
      for (const dep of resource.dependsOn ?? []) visit(dep);
    }
    visiting.delete(id);
    emitted.add(id);
    ordered.push(id);
  };
  for (const resource of resources) visit(resource.id);
  return ordered;
};

type MachineProfileAuthoring = Schema.Schema.Type<typeof MachineProfileAuthoringSchema>;

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareText);

type ManagedFileInput = Extract<
  ResourceSpecInput,
  { readonly kind: "directory" }
>["files"][number];

const normalizeManagedFile = (file: ManagedFileInput) => {
  if (file.symlinkTo !== undefined) {
    return {
      path: file.path,
      content: file.content,
      mode: 0,
      executable: false,
      symlinkTo: file.symlinkTo,
    };
  }
  const mode = file.mode ?? (file.executable === true ? 0o700 : 0o600);
  return {
    path: file.path,
    content: file.content,
    mode,
    executable: (mode & 0o100) !== 0,
  };
};

const normalizeResourceSpec = (spec: ResourceSpecInput): ResourceSpecInput => {
  switch (spec.kind) {
    case "file": {
      if (spec.symlinkTo !== undefined) {
        return {
          kind: spec.kind,
          content: spec.content,
          mode: 0,
          executable: false,
          symlinkTo: spec.symlinkTo,
        };
      }
      const mode = spec.mode ?? (spec.executable === true ? 0o700 : 0o600);
      return {
        kind: spec.kind,
        content: spec.content,
        mode,
        executable: (mode & 0o100) !== 0,
      };
    }
    case "directory":
      return {
        kind: spec.kind,
        mode: spec.mode ?? 0o700,
        directories: [...(spec.directories ?? [])]
          .sort((left, right) => compareText(left.path, right.path)),
        files: spec.files
          .map(normalizeManagedFile)
          .sort((left, right) => compareText(left.path, right.path)),
      };
    case "config":
      return {
        kind: spec.kind,
        format: spec.format,
        keys: [...spec.keys].sort((left, right) => compareText(left.path, right.path)),
      };
    case "skill":
      return {
        kind: spec.kind,
        name: spec.name,
        mode: spec.mode ?? 0o700,
        directories: [...(spec.directories ?? [])]
          .sort((left, right) => compareText(left.path, right.path)),
        files: spec.files
          .map(normalizeManagedFile)
          .sort((left, right) => compareText(left.path, right.path)),
      };
    case "tool":
      return {
        kind: spec.kind,
        toolId: spec.toolId,
        recipes: [...spec.recipes].sort((left, right) =>
          compareText(
            `${left.platform}\0${left.method}\0${left.package}\0${left.version ?? ""}\0${JSON.stringify(left.indexPolicy)}\0${JSON.stringify(left.source)}`,
            `${right.platform}\0${right.method}\0${right.package}\0${right.version ?? ""}\0${JSON.stringify(right.indexPolicy)}\0${JSON.stringify(right.source)}`,
          )
        ).map((recipe) => {
          const indexPolicy = recipe.indexPolicy === undefined
            ? undefined
            : {
              ...recipe.indexPolicy,
              url: canonicalRecipeIndexUrl(recipe.indexPolicy.url) ?? recipe.indexPolicy.url,
            };
          const { indexPolicy: _indexPolicy, ...recipeWithoutIndex } = recipe;
          const base = {
            ...recipeWithoutIndex,
            buildPolicy: recipe.buildPolicy ?? { mode: "scripts-disabled" as const },
          };
          return indexPolicy === undefined
            ? base
            : { ...base, indexPolicy };
        }),
        login: spec.login ?? { required: false },
      };
    case "credential":
      return { kind: spec.kind, reference: spec.reference };
  }
};

const normalizeResource = (resource: ProfileResourceInput): ProfileResourceInput => {
  const base = {
    id: resource.id,
    kind: resource.kind,
    policy: resource.policy ?? defaultPolicy(resource.kind),
    target: resource.target,
    dependsOn: uniqueSorted(resource.dependsOn ?? []),
    spec: normalizeResourceSpec(resource.spec),
    verify: resource.verify,
  } as const;
  if (resource.groups === undefined) return base;
  return { ...base, groups: uniqueSorted(resource.groups) };
};

/** Apply all v2 defaults and order unordered collections deterministically. */
export const normalizeMachineProfile = (
  profile: MachineProfileAuthoring | MachineProfile,
): MachineProfile => {
  const groups = (profile.groups ?? [])
    .map((group) => group.description === undefined
      ? { name: group.name }
      : { name: group.name, description: group.description })
    .sort((left, right) => compareText(left.name, right.name));
  const resources = (profile.resources ?? [])
    .map(normalizeResource)
    .sort((left, right) => compareText(left.id, right.id));
  // An absent schedule default stays absent: it means this profile schedules
  // nothing, which is different from scheduling daily at midnight.
  const scheduleDefault = profile.scheduleDefault;
  const normalizedSchedule = scheduleDefault === undefined
    ? undefined
    : scheduleDefault.type === "weekly"
    ? { ...scheduleDefault, days: uniqueSorted(scheduleDefault.days) }
    : scheduleDefault;
  const base = {
    id: profile.id,
    version: 2 as const,
    name: profile.name,
    groups,
    resources,
  };
  return normalizedSchedule === undefined
    ? base
    : { ...base, scheduleDefault: normalizedSchedule };
};

/** Decode strict JSONC authoring input, normalize it, then reject invalid graphs. */
export const decodeMachineProfileJsonc = (text: string): MachineProfile => {
  const authored = decodeJsonc(MachineProfileAuthoringSchema)(text);
  const normalized = normalizeMachineProfile(authored);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return normalized;
};

/** Backwards-friendly concise name for the JSONC authoring boundary. */
export const decodeMachineProfile = decodeMachineProfileJsonc;

const profileJsonValue = (profile: MachineProfile): JsonValue =>
  Schema.decodeUnknownSync(Schema.MutableJson)(profile);

/** Canonical publication encoding of a validated, normalized profile. */
export const encodeMachineProfile = (profile: MachineProfile): string => {
  const normalized = normalizeMachineProfile(profile);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return canonicalJson(profileJsonValue(normalized));
};

/** Stable SHA-256 digest of the canonical publication encoding. */
export const digestMachineProfile = (profile: MachineProfile): ContentDigest => {
  const normalized = normalizeMachineProfile(profile);
  Schema.decodeUnknownSync(MachineProfileSchema, { onExcessProperty: "error" })(normalized);
  const errors = validateMachineProfile(normalized);
  if (errors.length > 0) throw new ProfileContractError(errors);
  return digestOf(profileJsonValue(normalized));
};
