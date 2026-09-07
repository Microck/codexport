import { Schema } from "effect";

import {
  BlobId,
  ContentDigest,
  CredentialReference,
  GroupName,
  ResourceId,
  ToolId,
} from "./brand.ts";
import {
  AutomaticRecipeMethod as AutomaticRecipeMethodSchema,
  RecipeSourceMetadata as RecipeSourceMetadataSchema,
  RecipeIndexPolicy as RecipeIndexPolicySchema,
  RecipeMethod as RecipeMethodSchema,
  recipeValidationError,
} from "./recipe-versions.ts";

/**
 * Profile Resource kinds and Apply Policies from the architecture contract.
 * The defaults table is the single source of truth for policy-kind defaults.
 */

export const ResourceKind = Schema.Literals([
  "file",
  "directory",
  "config",
  "skill",
  "tool",
  "credential",
]);
export type ResourceKind = Schema.Schema.Type<typeof ResourceKind>;

export const ApplyPolicy = Schema.Literals([
  "replace",
  "mirror-owned",
  "merge",
  "replace-if-unmodified",
  "append-local",
  "ensure",
  "require-local",
]);
export type ApplyPolicy = Schema.Schema.Type<typeof ApplyPolicy>;

/** The default Apply Policy for each resource kind, per the architecture contract. */
export const defaultPolicyForKind = {
  file: "replace",
  directory: "mirror-owned",
  config: "merge",
  skill: "replace-if-unmodified",
  tool: "ensure",
  credential: "require-local",
} satisfies Readonly<Record<ResourceKind, ApplyPolicy>>;

/** Which policies are compatible with which kinds. `ensure` and `require-local` are kind-specific. */
const compatiblePolicies = {
  file: ["replace", "replace-if-unmodified", "append-local"],
  directory: ["mirror-owned", "replace"],
  config: ["merge", "replace"],
  skill: ["replace-if-unmodified", "replace"],
  tool: ["ensure"],
  credential: ["require-local"],
} satisfies Readonly<Record<ResourceKind, ReadonlyArray<ApplyPolicy>>>;

export const policyCompatibleWithKind = (kind: ResourceKind, policy: ApplyPolicy): boolean =>
  compatiblePolicies[kind].some((candidate) => candidate === policy);

/** Platform selector for installation recipes and path mapping. */
export const Platform = Schema.Literals(["linux", "macos", "windows"]);
export type Platform = Schema.Schema.Type<typeof Platform>;

export const RecipeMethod = RecipeMethodSchema;
export type RecipeMethod = Schema.Schema.Type<typeof RecipeMethod>;
export const AutomaticRecipeMethod = AutomaticRecipeMethodSchema;
export type AutomaticRecipeMethod = Schema.Schema.Type<typeof AutomaticRecipeMethod>;

/**
 * A build policy is part of the reviewed recipe contract. The default keeps
 * package lifecycle hooks disabled. A required build policy records the
 * bounds a future sandboxed builder would need; the current process executor
 * deliberately escalates this mode to Human Action Required.
 */
export const BuildCapability = Schema.Literals([
  "read-files",
  "write-files",
  "network",
  "execute",
]);
export type BuildCapability = Schema.Schema.Type<typeof BuildCapability>;

export const BuildStep = Schema.Struct({
  executable: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
});
export type BuildStep = Schema.Schema.Type<typeof BuildStep>;

export const BuildPolicy = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("scripts-disabled"),
  }),
  Schema.Struct({
    mode: Schema.Literal("required"),
    reviewedBy: Schema.NonEmptyString,
    reviewedAt: Schema.NonEmptyString,
    executables: Schema.Array(Schema.NonEmptyString),
    paths: Schema.Array(Schema.NonEmptyString),
    origins: Schema.Array(Schema.NonEmptyString),
    capabilities: Schema.Array(BuildCapability),
    steps: Schema.Array(BuildStep),
  }),
]);
export type BuildPolicy = Schema.Schema.Type<typeof BuildPolicy>;

export type { RecipeSource } from "./recipe-versions.ts";
export { RecipeSourceMetadataSchema as RecipeSourceMetadata };
export const RecipeIndexPolicy = RecipeIndexPolicySchema;
export type RecipeIndexPolicy = Schema.Schema.Type<typeof RecipeIndexPolicySchema>;

/**
 * A Profile Resource: one named item of desired configuration.
 * `spec` carries kind-specific fields decoded by `resourceSpecSchema`.
 */
export const GroupFilter = Schema.Struct({
  anyOf: Schema.Array(GroupName),
});
export type GroupFilter = Schema.Schema.Type<typeof GroupFilter>;

/** Portable POSIX mode bits accepted by authoring and published resource contracts. */
export const FilesystemMode = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0o7777),
);

export const DirectoryFile = Schema.Struct({
  path: Schema.NonEmptyString,
  blob: BlobId,
  executable: Schema.Boolean,
  mode: Schema.optional(FilesystemMode),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});
export type DirectoryFile = Schema.Schema.Type<typeof DirectoryFile>;

export const FileResourceSpec = Schema.Struct({
  kind: Schema.Literal("file"),
  content: Schema.String,
  digest: ContentDigest,
  executable: Schema.Boolean,
  mode: Schema.optional(FilesystemMode),
  symlinkTo: Schema.optional(Schema.NonEmptyString),
});
export type FileResourceSpec = Schema.Schema.Type<typeof FileResourceSpec>;

export const DirectoryResourceSpec = Schema.Struct({
  kind: Schema.Literal("directory"),
  mode: Schema.optional(FilesystemMode),
  directories: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.NonEmptyString,
    mode: FilesystemMode,
  }))),
  files: Schema.Array(DirectoryFile),
});
export type DirectoryResourceSpec = Schema.Schema.Type<typeof DirectoryResourceSpec>;

export const ConfigFormat = Schema.Literals(["toml", "json", "yaml"]);
export type ConfigFormat = Schema.Schema.Type<typeof ConfigFormat>;

export const ConfigValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type ConfigValue = Schema.Schema.Type<typeof ConfigValue>;

export const ConfigKey = Schema.Struct({
  path: Schema.NonEmptyString,
  value: ConfigValue,
});
export type ConfigKey = Schema.Schema.Type<typeof ConfigKey>;

export const ConfigResourceSpec = Schema.Struct({
  kind: Schema.Literal("config"),
  format: ConfigFormat,
  keys: Schema.Array(ConfigKey),
});
export type ConfigResourceSpec = Schema.Schema.Type<typeof ConfigResourceSpec>;

export const SkillResourceSpec = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: Schema.NonEmptyString,
  mode: Schema.optional(FilesystemMode),
  directories: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.NonEmptyString,
    mode: FilesystemMode,
  }))),
  files: Schema.Array(DirectoryFile),
});
export type SkillResourceSpec = Schema.Schema.Type<typeof SkillResourceSpec>;

const ToolRecipeRefSchema = Schema.Struct({
  platform: Platform,
  method: RecipeMethod,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
  indexPolicy: Schema.optional(RecipeIndexPolicySchema),
  buildPolicy: Schema.optional(BuildPolicy),
  source: Schema.optional(Schema.Union([
    Schema.NonEmptyString,
    RecipeSourceMetadataSchema,
  ])),
});

export const ToolRecipeRef = ToolRecipeRefSchema.check(
  Schema.makeFilter((recipe) => {
    const reason = recipeValidationError(recipe);
    return reason === undefined
      ? undefined
      : { path: ["version"], issue: reason };
  }),
);
export type ToolRecipeRef = Schema.Schema.Type<typeof ToolRecipeRef>;

export const LoginRequirement = Schema.Union([
  Schema.Struct({ required: Schema.Literal(false) }),
  Schema.Struct({
    required: Schema.Literal(true),
    howTo: Schema.NonEmptyString,
  }),
]);
export type LoginRequirement = Schema.Schema.Type<typeof LoginRequirement>;

/**
 * Where a bounded Configuration Agent may install this tool, and from where.
 *
 * Declared, never inferred. An Agent Task used to be given the resource target
 * as its only writable path, which for a tool is the bare executable name
 * rather than a path, and no origins at all: the controlled executor could
 * authorize no install action, so the task could only "succeed" if the tool
 * turned out to be present already.
 *
 * A tool that omits this is simply not installable by an agent, and says so as
 * a human action rather than dispatching a task that cannot be satisfied.
 */
/**
 * An exact HTTPS origin, with no path, query, credentials or trailing slash.
 *
 * Checked here rather than only where the agent runs: an `http://` origin in a
 * profile can never authorize anything, because the harness filters it out
 * before execution, so accepting it at publication only defers the discovery
 * to a follower that then reports bounds it does not have.
 */
const isExactHttpsOrigin = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.origin === value;
};

export const AgentInstallBounds = Schema.Struct({
  /** Paths or roots the agent may write, as authored targets. */
  paths: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  /** Exact HTTPS origins the agent may fetch from. */
  origins: Schema.optional(
    Schema.Array(Schema.NonEmptyString).check(
      Schema.makeFilter((origins) => {
        const rejected = origins.find((origin) => !isExactHttpsOrigin(origin));
        return rejected === undefined ? undefined : {
          path: ["origins"],
          issue: `agent install origin must be an exact HTTPS origin: ${rejected}`,
        };
      }),
    ),
  ),
});
export type AgentInstallBounds = Schema.Schema.Type<typeof AgentInstallBounds>;

export const ToolResourceSpec = Schema.Struct({
  kind: Schema.Literal("tool"),
  toolId: ToolId,
  recipes: Schema.Array(ToolRecipeRef),
  login: LoginRequirement,
  agentInstall: Schema.optional(AgentInstallBounds),
});
export type ToolResourceSpec = Schema.Schema.Type<typeof ToolResourceSpec>;

export const CredentialResourceSpec = Schema.Struct({
  kind: Schema.Literal("credential"),
  reference: CredentialReference,
});
export type CredentialResourceSpec = Schema.Schema.Type<typeof CredentialResourceSpec>;

/**
 * The calendar grammar a Machine Profile may declare.
 *
 * Only shapes every follower backend can render are allowed. A `custom`
 * expression was accepted at publication and then refused at apply time by
 * launchd and Windows Task Scheduler, which left a macOS or Windows follower
 * unable to converge at all. A follower that wants a backend-specific calendar
 * sets one locally, where it is that machine's business.
 */
export const ScheduleCalendar = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("daily"),
    at: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    days: Schema.Array(Schema.NonEmptyString),
    at: Schema.NonEmptyString,
  }),
]);
export type ScheduleCalendar = Schema.Schema.Type<typeof ScheduleCalendar>;

export const ResourceSpec = Schema.Union([
  FileResourceSpec,
  DirectoryResourceSpec,
  ConfigResourceSpec,
  SkillResourceSpec,
  ToolResourceSpec,
  CredentialResourceSpec,
]);
export type ResourceSpec = Schema.Schema.Type<typeof ResourceSpec>;

/** How to verify a resource reached its desired state. */
export const VerificationSpec = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("digest"),
    digest: ContentDigest,
  }),
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
    reference: CredentialReference,
  }),
  Schema.Struct({
    method: Schema.Literal("symlink"),
    target: Schema.NonEmptyString,
  }),
]);
export type VerificationSpec = Schema.Schema.Type<typeof VerificationSpec>;

export const ProfileResource = Schema.Struct({
  id: ResourceId,
  kind: ResourceKind,
  policy: ApplyPolicy,
  target: Schema.NonEmptyString,
  group: Schema.optional(GroupFilter),
  dependsOn: Schema.Array(ResourceId),
  spec: ResourceSpec,
  verify: VerificationSpec,
});
export type ProfileResource = Schema.Schema.Type<typeof ProfileResource>;

/** A discovered tool entry from the source scan, per the profile contract. */
export const InvocationEvidence = Schema.Struct({
  source: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  invocation: Schema.NonEmptyString,
  resolvedExecutable: Schema.optional(Schema.NonEmptyString),
  packageManager: Schema.optional(Schema.NonEmptyString),
});
export type InvocationEvidence = Schema.Schema.Type<typeof InvocationEvidence>;

const ToolRecipeSchema = Schema.Struct({
  platform: Platform,
  method: RecipeMethod,
  package: Schema.NonEmptyString,
  version: Schema.optional(Schema.NonEmptyString),
  source: Schema.optional(Schema.Union([
    Schema.NonEmptyString,
    RecipeSourceMetadataSchema,
  ])),
});
export const ToolRecipe = ToolRecipeSchema.check(
  Schema.makeFilter((recipe) => {
    const reason = recipeValidationError(recipe);
    return reason === undefined
      ? undefined
      : { path: ["version"], issue: reason };
  }),
);
export type ToolRecipe = Schema.Schema.Type<typeof ToolRecipe>;

export const DiscoveredTool = Schema.Struct({
  id: ToolId,
  upstream: Schema.NonEmptyString,
  evidence: Schema.Array(InvocationEvidence),
  recipes: Schema.Array(ToolRecipe),
  verify: Schema.Struct({
    command: Schema.Array(Schema.NonEmptyString),
    expectContains: Schema.optional(Schema.String),
  }),
  login: LoginRequirement,
});
export type DiscoveredTool = Schema.Schema.Type<typeof DiscoveredTool>;
