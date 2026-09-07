import type { CliFailureCategory } from "./exit-codes.ts";

/**
 * A tagged error as it reaches the CLI boundary.
 *
 * Every error in the tree is a `Schema.TaggedError` or `Data.TaggedError`, so
 * its declared fields are plain instance properties and `_tag` says which of
 * them are present. Declaring the union of every field the tree uses keeps the
 * taxonomy below reading them as typed properties instead of indexing an
 * untyped record, and each entry only reads the fields its own error declares.
 */
export interface TaggedRuntimeError extends Error {
  readonly _tag?: string | undefined;
  readonly action?: string | undefined;
  readonly actualBytes?: number | undefined;
  readonly artifact?: string | undefined;
  readonly blob?: string | undefined;
  readonly capability?: string | undefined;
  readonly category?: string | undefined;
  readonly collection?: string | undefined;
  readonly command?: ReadonlyArray<string> | undefined;
  readonly conflictsWith?: string | undefined;
  readonly cycle?: ReadonlyArray<string> | undefined;
  readonly decision?: string | undefined;
  readonly dependency?: string | undefined;
  readonly desiredKind?: string | undefined;
  readonly digest?: string | undefined;
  readonly entity?: string | undefined;
  readonly executable?: string | undefined;
  readonly field?: string | undefined;
  readonly follower?: string | undefined;
  readonly format?: string | undefined;
  readonly harness?: string | undefined;
  readonly id?: string | undefined;
  readonly keyId?: string | undefined;
  readonly kind?: string | undefined;
  readonly maximumBytes?: number | undefined;
  readonly maximumOutputBytes?: number | undefined;
  readonly method?: string | undefined;
  // `ExecutableNotFoundError` declares a field named `name`, which shadows
  // `Error.name`. That is why its string form used to be just the executable
  // name: the field, not the type. It is declared non-optional here because
  // `Error.name` always has a value, and only that error's entry reads it.
  readonly name: string;
  readonly observedState?: string | undefined;
  readonly operation?: string | undefined;
  readonly outcome?: string | undefined;
  readonly package?: string | undefined;
  readonly path?: string | undefined;
  readonly policy?: string | undefined;
  readonly publishedKind?: string | undefined;
  readonly reason?: string | undefined;
  readonly reasons?: ReadonlyArray<string> | undefined;
  readonly recovery?: string | undefined;
  readonly reference?: string | undefined;
  readonly resource?: string | undefined;
  readonly revision?: string | undefined;
  readonly run?: string | undefined;
  readonly state?: string | undefined;
  readonly target?: string | undefined;
  readonly task?: string | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly value?: string | undefined;
}

/**
 * Renders one field of a partially-populated error. A field that is absent
 * reads as the empty string, which keeps the renderer from emitting the word
 * "undefined" into an operator-facing message.
 */
const text = (value: string | undefined): string => value ?? "";
const count = (value: number | undefined): string =>
  value === undefined ? "" : String(value);
const list = (value: ReadonlyArray<string> | undefined): string =>
  (value ?? []).join(", ");

/** The error's own `message` field, when it declares one and it is non-empty. */
const declaredMessage = (error: TaggedRuntimeError): string | undefined =>
  error.message.length > 0 ? error.message : undefined;

interface FailureDescriptor {
  readonly category: (error: TaggedRuntimeError) => CliFailureCategory;
  readonly message: (error: TaggedRuntimeError) => string;
}

const describe = (
  category: CliFailureCategory,
  message: (error: TaggedRuntimeError) => string,
): FailureDescriptor => ({ category: () => category, message });

/**
 * For an error that carries its own failure class as a field. Its class is data
 * rather than a property of the type, so it is read from the error instead of
 * being fixed here.
 */
const classified = (
  category: (error: TaggedRuntimeError) => CliFailureCategory,
  message: (error: TaggedRuntimeError) => string,
): FailureDescriptor => ({ category, message });

/**
 * Prefers the error's declared `message` field and falls back to a rendering
 * built from its other fields. Errors that carry a message use it verbatim so
 * the layer that raised the failure keeps control of the wording.
 */
const declared = (
  category: CliFailureCategory,
  fallback: (error: TaggedRuntimeError) => string,
): FailureDescriptor =>
  describe(category, (error) => declaredMessage(error) ?? fallback(error));

/**
 * Every tagged error that can reach the CLI, with the semantic failure class it
 * belongs to and an operator-facing message built from its own fields.
 *
 * This table is the single authority for exit classification. It replaces
 * matching words against the error type name, which silently misfiled every
 * error whose name happened to contain no recognized word and rendered the type
 * name itself as the diagnostic. Two invariants hold here:
 *
 * - the exit code follows from the semantic class, never from the type name;
 * - an expected error never renders as `String(error)`.
 *
 * `tests/cli-failure-taxonomy.test.ts` scans the source tree for tagged error
 * declarations and fails when one is missing from this table, so a new error
 * type cannot quietly inherit a wrong classification.
 *
 * A few leaf errors are genuinely context-dependent: a process timeout is a
 * transport failure while fetching from the Source Machine, a human action when
 * an agent harness overruns, and an apply failure when an installer does. The
 * entry here is the default for a leaf error that reaches the boundary
 * unclassified; the subsystem that knows the context overrides it by raising
 * `CliCommandFailure` with an explicit category.
 */
export const failureTaxonomy = {
  // Plan and profile construction invariants. Reaching the CLI means Canonfig
  // built something malformed itself, so these are defects, not operator input.
  ActionCycleError: describe(
    "internal",
    (error) => `the execution plan contains a cycle: ${list(error.cycle)}`,
  ),
  ActionKindMismatchError: describe(
    "internal",
    (error) => `action ${text(error.id)} does not match its declared kind`,
  ),
  ActionNotInPlanError: describe(
    "internal",
    (error) =>
      `run ${text(error.run)} refers to action ${text(error.action)}, which is not in its plan`,
  ),
  DuplicateActionError: describe(
    "internal",
    (error) => `the execution plan declares action ${text(error.id)} twice`,
  ),
  MissingActionReferenceError: describe(
    "internal",
    (error) => `the execution plan refers to unknown action ${text(error.id)}`,
  ),
  DuplicatePlannerInputError: describe(
    "internal",
    (error) =>
      `${text(error.collection)} was given ${text(error.id)} twice`,
  ),
  InvalidExecutionPlanError: declared(
    "internal",
    (error) => `execution plan ${text(error.digest)} is not valid`,
  ),
  InvalidObservedStateError: describe(
    "internal",
    (error) =>
      `observed state for ${text(error.resource)} (${text(error.kind)}) is not valid: ${text(error.observedState)}`,
  ),
  MissingArtifactError: describe(
    "internal",
    (error) => `artifact ${text(error.digest)} is missing from the plan`,
  ),
  MissingBlobMetadataError: describe(
    "internal",
    (error) =>
      `resource ${text(error.resource)} refers to blob ${text(error.blob)}, which has no metadata`,
  ),
  MissingDesiredResourceError: describe(
    "internal",
    (error) => `desired state for ${text(error.resource)} is missing`,
  ),
  MissingExecutionResourceError: describe(
    "internal",
    (error) => `the execution plan is missing resource ${text(error.resource)}`,
  ),
  MissingObservedResourceError: describe(
    "internal",
    (error) => `observed state for ${text(error.resource)} is missing`,
  ),
  RepositoryDecodeError: declared(
    "internal",
    (error) =>
      `stored ${text(error.entity)} ${text(error.id)} could not be decoded`,
  ),
  RepositorySqlError: declared(
    "internal",
    (error) => `the local database failed during ${text(error.operation)}`,
  ),
  InvalidRunTransitionError: declared(
    "internal",
    (error) => `run ${text(error.run)} cannot make that state transition`,
  ),

  // Authored profile validation. The operator wrote something Canonfig cannot
  // apply, so the profile, not the machine, is what needs changing.
  ConflictingResourceTargetError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.id)} targets ${text(error.target)}, which ${text(error.conflictsWith)} also targets: ${text(error.reason)}`,
  ),
  DependencyCycleError: describe(
    "usage-or-configuration",
    (error) => `the profile declares a dependency cycle: ${list(error.cycle)}`,
  ),
  DuplicateGroupError: describe(
    "usage-or-configuration",
    (error) => `the profile declares follower group ${text(error.name)} twice`,
  ),
  DuplicateResourceError: describe(
    "usage-or-configuration",
    (error) => `the profile declares resource ${text(error.id)} twice`,
  ),
  InvalidBuildPolicyError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares an invalid build policy`,
  ),
  InvalidRecipeError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares an invalid installation recipe`,
  ),
  InvalidTargetError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares an invalid target path`,
  ),
  InvalidTextCompositionError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} cannot use append-local: ${text(error.reason)}. Correct its file specification before publishing.`,
  ),
  MissingDependencyError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} depends on a resource the profile does not declare`,
  ),
  MissingGroupReferenceError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} refers to a follower group the profile does not declare`,
  ),
  PolicyKindMismatchError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares an apply policy its kind does not support`,
  ),
  ResourceSpecKindMismatchError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares a specification its kind does not support`,
  ),
  UnmanageableFilesystemModeError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares a filesystem mode Canonfig cannot manage`,
  ),
  VerificationContentMismatchError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares verification content its method does not use`,
  ),
  VerificationKindMismatchError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.id)} declares a verification method its kind does not support`,
  ),

  // Planning against a specific follower. The profile is well formed but cannot
  // be applied to this machine as written.
  PlannerConflictingResourcePathError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} targets ${text(error.path)}, which ${text(error.conflictsWith)} also targets: ${text(error.reason)}`,
  ),
  PlannerDependencyCycleError: describe(
    "usage-or-configuration",
    (error) => `the profile declares a dependency cycle: ${list(error.cycle)}`,
  ),
  PlannerInvalidRecipeError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} declares an unusable ${text(error.method)} recipe for ${text(error.package)}: ${text(error.reason)}`,
  ),
  PlannerInvalidResourcePathError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} targets ${text(error.path)}, which Canonfig cannot manage: ${text(error.reason)}`,
  ),
  PlannerMissingDependencyError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} depends on ${text(error.dependency)}, which this follower does not receive`,
  ),
  PlannerPolicyKindMismatchError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} (${text(error.kind)}) does not support apply policy ${text(error.policy)}`,
  ),
  PlannerResourceKindMismatchError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} was published as ${text(error.publishedKind)} but is now declared ${text(error.desiredKind)}`,
  ),
  PlannerTextCompositionError: describe(
    "usage-or-configuration",
    (error) => `resource ${text(error.resource)} cannot use append-local: ${text(error.reason)}. Correct the Source profile and publish a new revision.`,
  ),
  PlannerVerificationContentMismatchError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} (${text(error.kind)}) declares ${text(error.method)} verification with content it does not use: ${text(error.reason)}`,
  ),
  PlannerVerificationKindMismatchError: describe(
    "usage-or-configuration",
    (error) =>
      `resource ${text(error.resource)} (${text(error.kind)}) cannot be verified by ${text(error.method)}`,
  ),

  // Source Machine state and publication input.
  DiscoveryFilesystemError: describe(
    "usage-or-configuration",
    (error) =>
      `${text(error.path)} could not be ${text(error.operation) === "stat" ? "inspected" : "read"}: ${text(error.reason)}`,
  ),
  DiscoveryParseError: describe(
    "usage-or-configuration",
    (error) =>
      `${text(error.path)} is not valid ${text(error.format)}: ${text(error.reason)}`,
  ),
  InvalidDiscoveryInputError: describe(
    "usage-or-configuration",
    (error) => `the scan input is not valid: ${text(error.reason)}`,
  ),
  InvalidPublicationInputError: describe(
    "usage-or-configuration",
    (error) => `the publication input is not valid: ${text(error.reason)}`,
  ),
  PublicationNotConfiguredError: describe(
    "usage-or-configuration",
    (error) =>
      `${text(error.operation)} needs a configured Source Machine; run 'canonfig source init' first`,
  ),
  PublicationSigningError: describe(
    "usage-or-configuration",
    (error) =>
      text(error.operation) === "sign"
        ? `the profile revision could not be signed (${text(error.reason)}); run 'canonfig source init' first`
        : `the profile revision signature could not be verified: ${text(error.reason)}`,
  ),
  SourceNotInitializedError: declared(
    "usage-or-configuration",
    (error) =>
      `${text(error.operation)} needs an initialized Source Machine; run 'canonfig source init' first`,
  ),

  // Local state lookups where the operator named something that does not exist.
  FollowerNotFoundError: describe(
    "usage-or-configuration",
    (error) => `no enrolled follower ${text(error.follower)}`,
  ),
  RevisionNotFoundError: describe(
    "usage-or-configuration",
    (error) => `no published profile revision ${text(error.revision)}`,
  ),
  RunNotFoundError: describe(
    "usage-or-configuration",
    (error) => `no synchronization run ${text(error.run)}`,
  ),
  RecoveryRunNotFoundError: describe(
    "usage-or-configuration",
    (error) => `follower ${text(error.follower)} has no run to recover`,
  ),

  // Machine and scheduler configuration.
  ExecutableNotFoundError: describe(
    "usage-or-configuration",
    (error) => `${text(error.name)} was not found on PATH`,
  ),
  FileSizeLimitError: describe(
    "usage-or-configuration",
    (error) =>
      `${text(error.path)} is larger than the ${count(error.maximumBytes)} byte limit`,
  ),
  InvalidMachinePathError: declared(
    "usage-or-configuration",
    (error) => `${text(error.path)} is not a path Canonfig can manage`,
  ),
  InvalidSchedulerJobError: declared(
    "usage-or-configuration",
    (error) => `the scheduled job's ${text(error.field)} is not valid`,
  ),
  // Declared twice with different fields: `{ id }` for an authored profile
  // schedule and `{ field, message }` for a native scheduler job. Both render
  // here until the duplicate tag is resolved.
  InvalidScheduleError: declared(
    "usage-or-configuration",
    (error) => {
      const resource = text(error.id);
      return resource.length > 0
        ? `resource ${resource} declares an invalid schedule`
        : `the schedule's ${text(error.field)} is not valid`;
    },
  ),
  UnsupportedHarnessError: describe(
    "usage-or-configuration",
    (error) => `${text(error.harness)} is not a supported agent harness`,
  ),
  InvalidAgentTaskError: declared(
    "usage-or-configuration",
    (error) => `agent task ${text(error.task)} is not valid`,
  ),
  FollowerSynchronizationConfigurationError: declared(
    "usage-or-configuration",
    (error) =>
      text(error.reason) === "missing"
        ? "this machine is not enrolled; run 'canonfig follower enroll' first"
        : `the follower configuration is ${text(error.reason)}`,
  ),
  EnrollmentConfigurationError: declared(
    "usage-or-configuration",
    (error) => `${text(error.operation)} is not configured`,
  ),
  MalformedEnrollmentRequestError: declared(
    "usage-or-configuration",
    () => "the enrollment request is malformed",
  ),

  SecretTransferError: classified(
    (error) => {
      switch (error.category) {
        case "usage":
          return "usage-or-configuration";
        case "storage":
          return "human-action-required";
        case "authentication":
          return "authentication-or-revocation";
        case "transport":
          return "transport";
        default:
          return "usage-or-configuration";
      }
    },
    (error) =>
      declaredMessage(error) ?? `${text(error.operation)} failed`,
  ),

  // A person must act before Canonfig can continue.
  HumanActionRequiredError: describe(
    "human-action-required",
    (error) => `${text(error.action)}: ${text(error.recovery)}`,
  ),
  ScheduleHumanActionRequiredError: describe(
    "human-action-required",
    (error) => `${text(error.action)}: ${text(error.recovery)}`,
  ),
  CredentialStorageError: declared(
    "human-action-required",
    (error) =>
      `credential ${text(error.reference)} could not be ${text(error.operation)}`,
  ),
  PublicationReviewRequiredError: describe(
    "human-action-required",
    (error) => `the proposal needs review before publication: ${text(error.decision)}`,
  ),
  UnresolvedPublicationProposalError: describe(
    "human-action-required",
    (error) => `the proposal has evidence that needs review: ${list(error.reasons)}`,
  ),
  RecoveryIntegrityError: declared(
    "human-action-required",
    (error) => `the rollback material for run ${text(error.run)} is not intact`,
  ),

  // Agent harness refusals. A refused, timed-out or unusable proposal is work a
  // person must finish, not a failed apply, because resolution happens before
  // any mutation and therefore leaves nothing rolled back.
  DeniedAgentCapabilityError: describe(
    "human-action-required",
    (error) =>
      `the agent harness is not allowed ${text(error.capability)} ${text(error.value)}`,
  ),
  AgentExecutionCancelledError: describe(
    "human-action-required",
    (error) => `${text(error.executable)} was cancelled before it proposed anything`,
  ),
  AgentExecutionTimeoutError: describe(
    "human-action-required",
    (error) =>
      `${text(error.executable)} did not answer within ${count(error.timeoutMilliseconds)} ms`,
  ),
  AgentInputLimitError: describe(
    "human-action-required",
    (error) =>
      `the agent task is ${count(error.actualBytes)} bytes, over the ${count(error.maximumBytes)} byte limit`,
  ),
  AgentOutputLimitError: describe(
    "human-action-required",
    (error) =>
      `${text(error.executable)} wrote more than its ${count(error.maximumBytes)} byte limit`,
  ),
  AgentProcessError: declared(
    "human-action-required",
    (error) => `${text(error.executable)} failed`,
  ),
  AgentVerificationError: declared(
    "human-action-required",
    (error) => `the agent's proposal did not verify: ${list(error.command)}`,
  ),
  InvalidAgentResponseError: declared(
    "human-action-required",
    () => "the agent harness returned output Canonfig cannot use",
  ),

  // Something already on this machine blocks the requested change.
  ActiveRunExistsError: describe(
    "conflict-or-drift",
    (error) =>
      `follower ${text(error.follower)} has a run still open; run 'canonfig recover' first`,
  ),
  DuplicateFollowerIdentityError: declared(
    "conflict-or-drift",
    () => "this machine is already enrolled",
  ),
  EnrollmentStateConflictError: declared(
    "conflict-or-drift",
    (error) => `the enrollment state conflicts: ${text(error.reason)}`,
  ),
  RevisionImmutableError: declared(
    "conflict-or-drift",
    (error) => `profile revision ${text(error.revision)} is published and cannot change`,
  ),

  // Credentials, signatures and invitations.
  EnrollmentFingerprintMismatchError: declared(
    "authentication-or-revocation",
    () => "the Source Machine's certificate fingerprint does not match the invitation",
  ),
  EnrollmentSourceMismatchError: declared(
    "authentication-or-revocation",
    () => "the invitation was issued by a different Source Machine",
  ),
  InvalidFollowerCredentialError: declared(
    "authentication-or-revocation",
    () => "the follower credential is invalid",
  ),
  InvalidPublicationSignatureError: describe(
    "authentication-or-revocation",
    (error) => `the profile revision signature from key ${text(error.keyId)} is invalid`,
  ),
  InvitationExpiredError: declared(
    "authentication-or-revocation",
    () => "the invitation has expired; ask the Source Machine for a new one",
  ),
  InvitationNotFoundError: declared(
    "authentication-or-revocation",
    () => "the invitation is not known to this Source Machine",
  ),
  InvitationReplayError: declared(
    "authentication-or-revocation",
    () => "the invitation was already used; ask the Source Machine for a new one",
  ),
  RevokedFollowerCredentialError: declared(
    "authentication-or-revocation",
    () => "this follower's credential has been revoked",
  ),
  TransportUnauthorizedError: describe(
    "authentication-or-revocation",
    (error) => `this follower is not authorized to read ${text(error.resource)}`,
  ),

  // Reaching the Source Machine.
  EnrollmentTransportError: declared(
    "transport",
    (error) => `${text(error.operation)} could not reach the Source Machine`,
  ),
  TransportIntegrityError: describe(
    "transport",
    (error) => `artifact ${text(error.artifact)} did not match its expected digest`,
  ),
  TransportInterruptedError: describe(
    "transport",
    (error) => `${text(error.operation)} was interrupted`,
  ),
  TransportMalformedResponseError: describe(
    "transport",
    (error) => `the Source Machine's response to ${text(error.operation)} was malformed`,
  ),
  TransportResourceNotFoundError: describe(
    "transport",
    (error) => `the Source Machine does not have ${text(error.resource)}`,
  ),
  TransportSizeLimitError: describe(
    "transport",
    (error) => `artifact ${text(error.artifact)} is larger than the transport limit`,
  ),

  // Applying and verifying on the follower.
  ActionExecutionError: declared(
    "verification-or-apply-failure",
    (error) => `action ${text(error.action)} failed`,
  ),
  InvalidArtifactError: declared(
    "verification-or-apply-failure",
    (error) => `artifact ${text(error.digest)} is not usable`,
  ),
  MachineFilesystemError: declared(
    "verification-or-apply-failure",
    (error) =>
      `${text(error.operation)} failed on ${text(error.path)}`,
  ),
  NpmArtifactError: declared(
    "verification-or-apply-failure",
    (error) => `${text(error.operation)} failed for the npm artifact`,
  ),
  RollbackCleanupError: declared(
    "verification-or-apply-failure",
    (error) =>
      `rollback material for run ${text(error.run)} could not be cleaned up (${text(error.outcome)})`,
  ),
  ScheduleVerificationError: declared(
    "verification-or-apply-failure",
    (error) =>
      `${text(error.operation)} left the schedule ${text(error.state)}`,
  ),
  ProcessStartError: declared(
    "verification-or-apply-failure",
    (error) => `${text(error.executable)} could not be started`,
  ),
  ProcessTimeoutError: describe(
    "verification-or-apply-failure",
    (error) =>
      `${text(error.executable)} did not finish within ${count(error.timeoutMilliseconds)} ms`,
  ),
  ProcessOutputLimitError: describe(
    "verification-or-apply-failure",
    (error) =>
      `${text(error.executable)} wrote more than its ${count(error.maximumOutputBytes)} byte limit`,
  ),
} as const satisfies Record<string, FailureDescriptor>;

/** The failure class and message for a tagged error reaching the CLI boundary. */
export interface RuntimeFailureDescription {
  readonly category: CliFailureCategory;
  readonly message: string;
}

const descriptors = new Map<string, FailureDescriptor>(
  Object.entries(failureTaxonomy),
);

/** Every classified error tag, for the taxonomy's coverage test. */
export const classifiedErrorTags = (): ReadonlySet<string> =>
  new Set(descriptors.keys());

export const describeRuntimeError = (
  error: TaggedRuntimeError,
): RuntimeFailureDescription => {
  const descriptor = descriptors.get(error._tag ?? "");
  // An unclassified error is a defect: either a new error type that was never
  // added to the table, or a non-tagged throw escaping a boundary. Exit 1 is
  // reserved for exactly that, and the declared message still beats the type
  // name as a diagnostic.
  if (descriptor === undefined) {
    return {
      category: "internal",
      message: declaredMessage(error)
        ?? `an unexpected ${error._tag ?? "error"} occurred`,
    };
  }
  const message = descriptor.message(error);
  return {
    category: descriptor.category(error),
    message: message.length > 0 ? message : `an unexpected ${error._tag} occurred`,
  };
};
