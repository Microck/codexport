import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Effect, Option, Redacted, Schema } from "effect";

import {
  AgentResolution,
  executableAllowed,
  isNestedCommandLauncher,
} from "../agent/agent-resolution.service.ts";
import type { AgentResolutionOutcome } from "../agent/agent-resolution.types.ts";
import {
  ActionId,
  BlobId,
  ContentDigest,
  CredentialReference,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  RunId,
  SourceSignature,
} from "../domain/brand.ts";
import {
  ResourceSpecInputSchema,
  type ProfileRevision,
  type ResourceSpecInput,
  type VerificationInput,
} from "../domain/profile.ts";
import type { ObservedResourceState } from "../domain/synchronization.ts";
import { parseTextComposition } from "../domain/text-composition.ts";
import type { AppliedResourceRecord } from "../domain/synchronization.ts";
import {
  fetchRevision,
  listRevisions,
} from "../enrollment/follower-client.ts";
import type {
  FetchedRevision,
  RevisionMetadata,
} from "../enrollment/enrollment.types.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { MachineFilesystemError } from "../machine/machine-state.errors.ts";
import { ScheduleManager } from "../schedule/schedule-manager.service.ts";
import {
  defaultSyncSchedule,
  syncScheduleFromDefault,
} from "../schedule/schedule-manager.types.ts";
import {
  canonicalJson,
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import { StateRepository } from "../state/state-repository.service.ts";
import { Synchronization } from "./synchronization.service.ts";
import {
  getConfigPath,
  parseConfigDocument,
  serializeConfigDocument,
  setConfigPath,
  type ConfigDocument,
} from "./config-codec.ts";
import {
  defaultLocalExecution,
  FollowerSynchronizationConfigurationError,
  type FollowerSynchronizationConfiguration,
  type FollowerAgentHarnessConfiguration,
} from "./follower-sync-config.ts";
import { planSynchronization } from "./planner.ts";
import { defaultSynchronizationExecutionLimits } from "./executor.ts";
import type {
  AvailableBlob,
  DesiredResource,
  DesiredResourceEntry,
  PlanningProfileRevision,
  PlannedSynchronization,
  SynchronizationArtifact,
  SynchronizationAgentConfiguration,
} from "./synchronization.types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const isNotFoundFilesystemError = (
  error: MachineFilesystemError,
): boolean => /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message);

/**
 * The bound on a process Canonfig starts on this machine. Installers and
 * `command` verifications routinely outlast an HTTP request, so this is
 * deliberately not the transport timeout.
 */
const localProcessTimeout = (
  configuration: FollowerSynchronizationConfiguration,
): number =>
  configuration.localExecution?.processTimeoutMilliseconds
    ?? defaultLocalExecution.processTimeoutMilliseconds;

const configurationError = (
  reason: "missing" | "stale" | "invalid-profile" | "invalid-reference",
  message: string,
) => new FollowerSynchronizationConfigurationError({ reason, message });

export const loadFollowerSynchronizationConfiguration = Effect.fn(
  "FollowerOrchestration.loadConfiguration",
)(function*(
  stateLocation: string,
): Effect.fn.Return<
  FollowerSynchronizationConfiguration,
  FollowerSynchronizationConfigurationError,
  StateRepository
> {
  const repository = yield* StateRepository;
  const configuration = yield* repository
    .getFollowerSynchronizationConfiguration()
    .pipe(
      Effect.mapError(() =>
        configurationError("stale", "follower synchronization configuration is unreadable")
      ),
    );
  if (configuration === undefined) {
    return yield* configurationError(
      "missing",
      "follower synchronization configuration is not enrolled",
    );
  }
  if (configuration.stateLocation !== stateLocation) {
    return yield* configurationError(
      "stale",
      "follower synchronization configuration belongs to another state repository",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(configuration.source.endpoint);
  } catch {
    return yield* configurationError(
      "stale",
      "configured source endpoint is malformed",
    );
  }
  if (
    endpoint.protocol !== "https:"
    || (
      endpoint.hostname !== "127.0.0.1"
      && endpoint.hostname !== "[::1]"
      && endpoint.hostname !== "::1"
    )
  ) {
    return yield* configurationError(
      "stale",
      "configured source endpoint is not pinned loopback HTTPS",
    );
  }
  const state = yield* repository.loadState(configuration.follower.id).pipe(
    Effect.mapError(() =>
      configurationError("stale", "configured follower identity is unavailable")
    ),
  );
  if (
    state.follower.id !== configuration.follower.id
    || state.follower.credentialReference !== configuration.credentialReference
    || state.follower.revoked
    || state.sourceIdentity?.publicKeyFingerprint
      !== configuration.source.signingFingerprint
  ) {
    return yield* configurationError(
      "stale",
      "configured follower, source, or credential reference is stale",
    );
  }
  return configuration;
});

const transportInput = (
  configuration: FollowerSynchronizationConfiguration,
  signal?: AbortSignal,
) => ({
  endpoint: configuration.source.endpoint,
  tlsFingerprint: configuration.source.tlsFingerprint,
  credentialReference: configuration.credentialReference,
  sourceFingerprint: configuration.source.signingFingerprint,
  timeoutMilliseconds: configuration.scheduledInvocation.timeoutMilliseconds,
  signal,
});

const selectedRevision = Effect.fn(
  "FollowerOrchestration.selectedRevision",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  requestedRevision?: string,
  signal?: AbortSignal,
) {
  const revisions = yield* listRevisions(transportInput(configuration, signal));
  const matching = revisions.revisions
    .filter((revision) => revision.profileId === configuration.selectedProfile)
    .sort((left, right) => right.sequence - left.sequence);
  const selected = requestedRevision === undefined
    ? matching[0]
    : matching.find((revision) => revision.id === requestedRevision);
  if (selected === undefined) {
    return yield* configurationError(
      "invalid-profile",
      requestedRevision === undefined
        ? `selected profile ${configuration.selectedProfile} has no authorized revision`
        : `recovery revision ${requestedRevision} is no longer authorized`,
    );
  }
  return selected;
});

interface DecodedSpec {
  readonly resource: RevisionMetadata["resources"][number];
  readonly spec: ResourceSpecInput;
  readonly blob: FetchedRevision["blobs"][number];
  readonly blobBytes: Uint8Array;
}

const decodeSpecs = (
  fetched: FetchedRevision,
): Effect.Effect<ReadonlyArray<DecodedSpec>, FollowerSynchronizationConfigurationError> =>
  Effect.forEach(fetched.metadata.resources, (resource) =>
    Effect.gen(function*() {
      if (resource.blobs.length !== 1) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} does not have one canonical content blob`,
        );
      }
      const blob = fetched.blobs.find((entry) => entry.id === resource.blobs[0]);
      if (blob === undefined) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} is missing its verified content blob`,
        );
      }
      const blobBytes = yield* Effect.tryPromise({
        try: () => readFile(blob.path),
        catch: () =>
          configurationError(
            "stale",
            `verified cache blob for ${resource.id} is unavailable`,
          ),
      });
      const spec = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(ResourceSpecInputSchema)(
            JSON.parse(decoder.decode(blobBytes)),
          ),
        catch: () =>
          configurationError(
            "stale",
            `verified content blob for ${resource.id} is malformed`,
          ),
      });
      if (spec.kind !== resource.kind) {
        return yield* configurationError(
          "stale",
          `resource ${resource.id} kind does not match its verified content`,
        );
      }
      return { resource, spec, blob, blobBytes };
    })
  );

const fileDigest = (content: string): typeof ContentDigest.Type =>
  Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(encoder.encode(content)));

const configDocument = (
  spec: Extract<ResourceSpecInput, { readonly kind: "config" }>,
): Uint8Array => {
  const document: ConfigDocument = {};
  for (const entry of [...spec.keys].sort((left, right) =>
    compareText(left.path, right.path)
  )) {
    setConfigPath(document, entry.path, entry.value);
  }
  return encoder.encode(serializeConfigDocument(spec.format, document));
};

interface HydratedDesiredResource {
  readonly desired: DesiredResource;
  readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
}

export const authorizationViewIdentity = (
  metadata: Pick<RevisionMetadata, "id" | "profileId" | "metadataDigest">,
) => {
  const suffix = `view:${metadata.metadataDigest}`;
  return {
    revision: Schema.decodeUnknownSync(ProfileRevisionId)(
      `${metadata.id}:${suffix}`,
    ),
    profile: Schema.decodeUnknownSync(ProfileId)(
      `${metadata.profileId}:${suffix}`,
    ),
  };
};

const desiredFor = (
  spec: ResourceSpecInput,
): HydratedDesiredResource => {
  switch (spec.kind) {
    case "file": {
      const content = encoder.encode(spec.content);
      const isSymlink = spec.symlinkTo !== undefined;
      const digest = Schema.decodeUnknownSync(ContentDigest)(
        !isSymlink
          ? sha256BytesHex(content)
          : sha256Hex(spec.symlinkTo),
      );
      return {
        desired: {
          kind: "file",
          digest,
          executable: isSymlink ? false : spec.executable ?? false,
          mode: isSymlink ? 0 : spec.mode ?? (spec.executable === true ? 0o700 : 0o600),
          symlinkTo: spec.symlinkTo,
        },
        artifacts: !isSymlink ? [{ digest, content }] : [],
      };
    }
    case "directory":
    case "skill": {
      const files = spec.files.map((file) => ({
        path: file.path,
        digest: file.symlinkTo === undefined
          ? fileDigest(file.content)
          : Schema.decodeUnknownSync(ContentDigest)(sha256Hex(file.symlinkTo)),
        executable: file.symlinkTo === undefined ? file.executable ?? false : false,
        mode: file.symlinkTo === undefined
          ? file.mode ?? (file.executable === true ? 0o700 : 0o600)
          : 0,
        symlinkTo: file.symlinkTo,
      }));
      const artifacts = spec.files.flatMap((file, index) =>
        file.symlinkTo === undefined
          ? [{ digest: files[index]!.digest, content: encoder.encode(file.content) }]
          : []
      );
      const directories = spec.directories ?? [];
      const mode = spec.mode ?? 0o700;
      // The declared verification digest is a stable content contract. Exact
      // modes and object kinds belong to the separate convergence-state digest.
      const digest = directoryVerificationDigest(files);
      return {
        desired: spec.kind === "skill"
          ? { kind: "skill", digest, mode, directories, files }
          : { kind: "directory", mode, directories, files },
        artifacts,
      };
    }
    case "config": {
      const content = configDocument(spec);
      const digest = Schema.decodeUnknownSync(ContentDigest)(sha256BytesHex(content));
      return {
        desired: {
          kind: "config",
          digest,
          format: spec.format,
          keys: spec.keys
            .map((entry) => entry.path)
            .sort((left, right) => left.localeCompare(right)),
        },
        artifacts: [{ digest, content }],
      };
    }
    case "tool":
      return {
        desired: {
          kind: "tool",
          toolId: spec.toolId,
          recipes: spec.recipes,
          loginRequired: spec.login?.required ?? false,
          loginInstructions: spec.login?.required === true
            ? spec.login.howTo
            : undefined,
          agentInstall: spec.agentInstall,
        },
        artifacts: [],
      };
    case "credential":
      return {
        desired: {
          kind: "credential",
          reference: spec.reference,
          instructions:
            `Store credential ${spec.reference} in this machine's secure credential store, then run synchronization again.`,
        },
        artifacts: [],
      };
  }
};

const observeFile = (
  target: string,
  desired: Extract<DesiredResource, { readonly kind: "file" }>,
  policy: ProfileRevision["resources"][number]["policy"],
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: target });
    const observedKind = yield* machine.inspectPath(path);
    if (observedKind.kind === "symlink") {
      return yield* machine.readSymlink(path).pipe(
        Effect.map((symlinkTo): ObservedResourceState => ({
          state: "present",
          digest: desired.symlinkTo === symlinkTo
            ? desired.digest
            : sha256Hex(symlinkTo),
          executable: false,
          objectKind: "symlink",
          symlinkTo,
        })),
      );
    }
    if (observedKind.kind !== "regular") {
      return {
        state: "present",
        digest: sha256Hex(`canonfig:observed-object:${observedKind.kind}`),
        executable: false,
        objectKind: observedKind.kind,
      } as const;
    }
    if (desired.symlinkTo !== undefined) {
      return {
        state: "present",
        digest: sha256Hex("canonfig:observed-object:regular"),
        executable: false,
        objectKind: "regular",
      } as const;
    }
    if (policy === "append-local") {
      const bytes = yield* machine.readFile({ path, maximumBytes: defaultSynchronizationExecutionLimits.maximumFileBytes });
      const composition = yield* Effect.try(() => parseTextComposition(bytes));
      const permissions = yield* machine.permissions(path);
      const observation = {
        state: "present",
        digest: sha256BytesHex(bytes),
        executable: permissions.executableByOwner,
        mode: permissions.mode,
        objectKind: "regular",
      } as const;
      return composition.kind === "managed"
        ? { ...observation, managedSourceDigest: sha256Hex(composition.source) }
        : observation;
    }
    return yield* machine.digestFile({ path }).pipe(
      Effect.flatMap((digest) =>
        machine.permissions(path).pipe(
          Effect.map((permissions): ObservedResourceState => ({
            state: "present",
            digest: digest.value,
            executable: permissions.executableByOwner,
            mode: permissions.mode,
            objectKind: "regular",
          })),
        )
      ),
      Effect.catchTag("MachineFilesystemError", (error) =>
        Effect.succeed(error.message.includes("ENOENT")
          ? { state: "absent" } as const
          : { state: "unverifiable", reason: error.message } as const)
      ),
      Effect.catch((error) =>
        Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
      ),
    );
  }).pipe(
    Effect.catchTag("MachineFilesystemError", (error) =>
      Effect.succeed(error.message.includes("ENOENT")
        ? { state: "absent" } as const
        : { state: "unverifiable", reason: error.message } as const)
    ),
    Effect.catch((error) =>
      Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
    ),
  );

const observeConfig = (
  decoded: {
    readonly resource: Pick<ProfileRevision["resources"][number], "target">;
  },
  desired: Extract<DesiredResource, { readonly kind: "config" }>,
): Effect.Effect<ObservedResourceState, never, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: decoded.resource.target });
    const observedKind = yield* machine.inspectPath(path);
    if (observedKind.kind !== "regular") {
      return {
        state: "present",
        digest: sha256Hex(`canonfig:observed-object:${observedKind.kind}`),
        executable: false,
        objectKind: observedKind.kind,
      } as const;
    }
    const bytes = yield* machine.readFile({
      path,
      maximumBytes: 8 * 1024 * 1024,
    });
    const current = parseConfigDocument(desired.format, decoder.decode(bytes));
    const managed: ConfigDocument = {};
    for (const key of desired.keys) {
      const value = getConfigPath(current, key);
      if (value !== undefined) setConfigPath(managed, key, value);
    }
    return {
      state: "present",
      digest: sha256BytesHex(
        encoder.encode(serializeConfigDocument(desired.format, managed)),
      ),
      executable: false,
      objectKind: "regular",
    } as const;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        String(error).includes("ENOENT")
          ? { state: "absent" } as const
          : { state: "unverifiable", reason: String(error) } as const,
      )
    ),
  );

const observe = (
  decoded: {
    // `policy` is read so a `replace` directory can be listed in full; the
    // other policies observe only owned and desired paths.
    readonly resource: Pick<
      ProfileRevision["resources"][number],
      "kind" | "target" | "policy"
    >;
  },
  desired: DesiredResource,
  verification: VerificationInput,
  applied?: AppliedResourceRecord,
  scheduleManager?: ScheduleManager["Service"] | undefined,
): Effect.Effect<ObservedResourceState, never, MachineState> => {
  switch (desired.kind) {
    case "file":
      return observeFile(decoded.resource.target, desired, decoded.resource.policy);
    case "config":
      return observeConfig(decoded, desired);
    case "directory":
    case "skill":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const root = yield* machine.normalizePath({ path: decoded.resource.target });
        const rootKind = yield* machine.inspectPath(root).pipe(
          Effect.catchTag("MachineFilesystemError", (error) =>
            isNotFoundFilesystemError(error)
              ? Effect.succeed(undefined)
              : Effect.fail(error)
          ),
        );
        if (rootKind === undefined) return { state: "absent" } as const;
        if (rootKind.kind !== "directory") {
          return {
            state: "present",
            digest: sha256Hex(`canonfig:observed-object:${rootKind.kind}`),
            executable: false,
            objectKind: rootKind.kind,
          } as const;
        }
        const rootPermissions = yield* machine.permissions(root);
        // Under `replace` the managed subtree is the desired subtree exactly,
        // so every entry has to be observed, including ones Canonfig never
        // wrote. Observation otherwise inspects only owned and desired paths,
        // which made a locally added file invisible and therefore
        // unremovable: `replace` behaved like `mirror-owned` for anything
        // foreign, and the two policies were the same thing.
        const foreign = decoded.resource.policy === "replace"
          ? yield* machine.listDirectory(root).pipe(
            Effect.map((entries) =>
              entries.map((entry) => {
                const observed = {
                  path: entry.path,
                  digest: Schema.decodeUnknownSync(ContentDigest)(
                    sha256Hex(`canonfig:observed-object:${entry.kind}`),
                  ),
                  executable: false,
                };
                return entry.kind === "directory"
                  ? { ...observed, objectKind: "directory" as const }
                  : observed;
              })
            ),
          )
          : [];
        const candidates = [...new Map([
          ...foreign,
          ...(applied?.ownedFiles ?? []).map((file) => ({
            ...file,
            executable: file.executable ?? false,
          })),
          ...desired.files,
          ...desired.directories.map((directory) => ({
            path: directory.path,
            digest: Schema.decodeUnknownSync(ContentDigest)(sha256Hex("canonfig:directory")),
            executable: (directory.mode & 0o100) !== 0,
            mode: directory.mode,
            objectKind: "directory" as const,
          })),
        ].map((file) => [file.path, file])).values()];
        const files = yield* Effect.forEach(candidates, (file) =>
          Effect.gen(function*() {
            const path = yield* machine.normalizePath({ path: file.path, base: root });
            const kind = yield* machine.inspectPath(path).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed(undefined)
                  : Effect.fail(error)
              ),
            );
            if (kind === undefined) {
              return { path: file.path, state: "absent" } as const;
            }
            if (kind.kind === "directory") {
              const permissions = yield* machine.permissions(path);
              return {
                path: file.path,
                digest: sha256Hex("canonfig:directory"),
                executable: permissions.executableByOwner,
                mode: permissions.mode,
                objectKind: "directory" as const,
              };
            }
            if (kind.kind === "symlink") {
              const symlinkTo = yield* machine.readSymlink(path);
              return {
                path: file.path,
                digest: sha256Hex(symlinkTo),
                executable: false,
                objectKind: "symlink" as const,
                symlinkTo,
              };
            }
            if (kind.kind !== "regular") {
              return {
                path: file.path,
                digest: sha256Hex(`canonfig:observed-object:${kind.kind}`),
                executable: false,
                objectKind: kind.kind,
              } as const;
            }
            return yield* machine.digestFile({ path }).pipe(
              Effect.flatMap((digest) =>
                machine.permissions(path).pipe(
                  Effect.map((permissions) => ({
                    path: file.path,
                    digest: digest.value,
                    executable: permissions.executableByOwner,
                    mode: permissions.mode,
                    objectKind: "regular" as const,
                  })),
                )
              ),
              Effect.catchTag("MachineFilesystemError", (error) =>
                isNotFoundFilesystemError(error)
                  ? Effect.succeed({ path: file.path, state: "absent" } as const)
                  : Effect.fail(error)
              ),
            );
          })
        );
        return {
          state: "directory",
          objectKind: "directory",
          mode: rootPermissions.mode,
          files,
        } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ state: "unverifiable", reason: String(error) } as const)
        ),
      );
    case "tool":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const executable = verification.method === "executable-present"
          ? verification.executable
          : decoded.resource.target;
        if (executable.includes("/") || executable.includes("\\")) {
          return yield* machine.normalizePath({ path: executable }).pipe(
            Effect.flatMap((path) => machine.permissions(path)),
            Effect.as({
              state: "present",
              digest: sha256Hex(executable),
              executable: true,
            } as const),
            Effect.catch(() => Effect.succeed({ state: "absent" } as const)),
          );
        }
        return yield* machine.findExecutable({ name: executable }).pipe(
          Effect.as({ state: "present", digest: sha256Hex(executable), executable: true } as const),
          Effect.catch(() => Effect.succeed({ state: "absent" } as const)),
        );
      });
    case "credential":
      return Effect.gen(function*() {
        const machine = yield* MachineState;
        const reference = Schema.decodeUnknownSync(CredentialReference)(
          verification.method === "credential-present"
            ? verification.reference
            : desired.reference,
        );
        return yield* machine.loadCredential({ reference }).pipe(
          Effect.map((value) => {
            Redacted.value(value);
            return {
              state: "present",
              digest: sha256Hex(desired.reference),
              executable: false,
            } as const;
          }),
          Effect.catch(() => Effect.succeed({ state: "absent" } as const)),
        );
      });
  }
};

/**
 * The verification a removed resource's own shape requires.
 *
 * Every removed resource used to be given `digest` verification, but the
 * planner requires `symlink` verification for a symlink file and rejects the
 * mismatch, so a follower that had applied a symlink and then stopped
 * receiving it failed every plan and apply with a bare
 * `PlannerVerificationKindMismatchError` before any action was planned. The
 * record was never dropped, so the failure repeated forever and the follower
 * could neither converge nor remove anything.
 */
const removedResourceVerification = (
  applied: AppliedResourceRecord,
  desired: DesiredResource,
): VerificationInput =>
  desired.kind === "file" && desired.symlinkTo !== undefined
    ? { method: "symlink", target: desired.symlinkTo }
    : { method: "digest", digest: Schema.decodeUnknownSync(ContentDigest)(applied.digest) };

const removedResourceState = (
  applied: AppliedResourceRecord,
): {
  readonly resource: ProfileRevision["resources"][number];
  readonly desired: DesiredResource;
} | undefined => {
  if (
    applied.kind === undefined
    || applied.policy === undefined
    || applied.target === undefined
  ) {
    return undefined;
  }
  const resource = {
    id: applied.resource,
    kind: applied.kind,
    policy: applied.policy,
    target: applied.target,
    dependsOn: [],
    blobs: [],
  } satisfies ProfileRevision["resources"][number];
  const digest = Schema.decodeUnknownSync(ContentDigest)(applied.digest);
  switch (applied.kind) {
    case "file":
      return {
        resource,
        desired: {
          kind: "file",
          digest,
          executable: applied.executable ?? false,
          mode: applied.mode ?? (applied.executable === true ? 0o700 : 0o600),
          symlinkTo: applied.symlinkTo,
        },
      };
    case "directory":
    case "skill":
      if (applied.ownedFiles === undefined) return undefined;
      const directories = applied.ownedFiles
        .filter((file) => file.objectKind === "directory")
        .map((directory) => ({
          path: directory.path,
          mode: directory.mode ?? 0o700,
        }));
      const files = applied.ownedFiles
        .filter((file) => file.objectKind !== "directory")
        .map((file) => ({
          path: file.path,
          digest: Schema.decodeUnknownSync(ContentDigest)(file.digest),
          executable: file.executable ?? false,
          mode: file.mode ?? (file.executable === true ? 0o700 : 0o600),
          symlinkTo: file.symlinkTo,
        }));
      return {
        resource,
        desired: applied.kind === "skill"
          ? {
            kind: "skill",
            digest,
            mode: applied.mode ?? 0o700,
            directories,
            files,
          }
          : {
            kind: "directory",
            mode: applied.mode ?? 0o700,
            directories,
            files,
          },
      };
    case "config":
      if (
        applied.ownedKeys === undefined
        || applied.configFormat === undefined
      ) {
        return undefined;
      }
      return {
        resource,
        desired: {
          kind: "config",
          digest,
          format: applied.configFormat,
          keys: applied.ownedKeys,
        },
      };
    case "tool":
    case "credential":
      return undefined;
  }
};

const hydrateRevision = Effect.fn("FollowerOrchestration.hydrateRevision")(
  function*(
    fetched: FetchedRevision,
    appliedResources: ReadonlyArray<AppliedResourceRecord> = [],
    scheduleManager?: ScheduleManager["Service"] | undefined,
  ): Effect.fn.Return<
    {
      readonly revision: PlanningProfileRevision;
      readonly observations: ReadonlyArray<{
        readonly resource: typeof ResourceId.Type;
        readonly observed: ObservedResourceState;
      }>;
      readonly artifacts: ReadonlyArray<SynchronizationArtifact>;
    },
    FollowerSynchronizationConfigurationError,
    MachineState
  > {
    const decoded = yield* decodeSpecs(fetched);
    const desired: Array<DesiredResourceEntry> = [];
    const observations = [];
    const artifacts: Array<SynchronizationArtifact> = [];
    const blobs: Array<AvailableBlob> = [];
    const announcedBlobs = new Set<string>();
    const removedResources = [];
    const appliedByResource = new Map(appliedResources.map((record) => [
      record.resource,
      record,
    ]));
    for (const entry of decoded) {
      const hydration = desiredFor(entry.spec);
      desired.push({
        resource: entry.resource.id,
        desired: hydration.desired,
        verification: entry.resource.verify,
      });
      observations.push({
        resource: entry.resource.id,
        observed: yield* observe(
          entry,
          hydration.desired,
          entry.resource.verify,
          appliedByResource.get(entry.resource.id),
          scheduleManager,
        ),
      });
      artifacts.push(
        { digest: entry.blob.id, content: entry.blobBytes },
        ...hydration.artifacts,
      );
      // Two resources with identical published specifications share one blob,
      // because a blob's id is the digest of its content. Emit it once: the
      // list describes what is available to transfer, not which resource asked
      // for it.
      if (!announcedBlobs.has(entry.blob.id)) {
        announcedBlobs.add(entry.blob.id);
        blobs.push({
          id: Schema.decodeUnknownSync(BlobId)(entry.blob.id),
          bytes: entry.blobBytes.byteLength,
        });
      }
    }
    const currentIds = new Set(fetched.metadata.resources.map((resource) => resource.id));
    for (
      const applied of [...appliedResources].sort((left, right) =>
        left.resource.localeCompare(right.resource)
      )
    ) {
      if (currentIds.has(applied.resource)) continue;
      const removed = removedResourceState(applied);
      if (removed === undefined) continue;
      removedResources.push(applied.resource);
      const removedVerification = removedResourceVerification(
        applied,
        removed.desired,
      );
      desired.push({
        resource: removed.resource.id,
        desired: removed.desired,
        verification: removedVerification,
      });
      observations.push({
        resource: removed.resource.id,
        observed: yield* observe(
          { resource: removed.resource },
          removed.desired,
          removedVerification,
          applied,
          scheduleManager,
        ),
      });
    }
    const metadata = fetched.metadata;
    const view = authorizationViewIdentity(metadata);
    const canonicalBytes = canonicalJson(
      Schema.decodeUnknownSync(Schema.MutableJson)({
        sourceRevision: metadata.id,
        metadataDigest: metadata.metadataDigest,
        resources: metadata.resources,
      }),
    );
    const base: ProfileRevision = {
      id: view.revision,
      profileId: view.profile,
      sequence: metadata.sequence,
      canonicalBytes,
      digest: sha256Hex(canonicalBytes),
      signature: Schema.decodeUnknownSync(SourceSignature)(
        metadata.sourceSignature,
      ),
      publishedAt: metadata.publishedAt,
      scheduleDefault: metadata.scheduleDefault,
      resources: [
        ...metadata.resources.map(({ verify: _, ...resource }) => resource),
        ...removedResources.map((resource) =>
          removedResourceState(appliedByResource.get(resource)!)!.resource
        ),
      ],
      groups: [],
    };
    return {
      revision: { ...base, desired, blobs, removedResources },
      observations,
      artifacts: [...new Map(artifacts.map((entry) => [entry.digest, entry])).values()],
    };
  },
);

const persistableRevision = (
  revision: PlanningProfileRevision,
): ProfileRevision => ({
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

const pathWithinHarnessBounds = (
  path: string,
  configuration: FollowerAgentHarnessConfiguration,
): boolean => configuration.allowedPaths.some((root) => {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedPath = path.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
});

const originWithinHarnessBounds = (
  origin: string,
  configuration: FollowerAgentHarnessConfiguration,
): boolean => {
  try {
    const normalized = new URL(origin).origin;
    return configuration.allowedOrigins.some((allowed) =>
      new URL(allowed).origin === normalized
    );
  } catch {
    return false;
  }
};

const harnessConfigurationIssue = (
  configuration: FollowerAgentHarnessConfiguration,
): string | undefined => {
  if (configuration.executable.trim() !== configuration.executable) {
    return "agent harness executable reference is invalid";
  }
  if (
    configuration.environment?.some((entry) =>
      entry.name.trim() !== entry.name || entry.name.includes("=")
    ) === true
  ) {
    return "agent harness environment overrides are invalid";
  }
  if (configuration.allowedPaths.some((path) => path.trim() !== path)) {
    return "agent harness path bounds are invalid";
  }
  if (
    configuration.allowedExecutables.some((executable) =>
      executable.trim() !== executable
    )
    || configuration.executableAuthorizations?.some((authorization) =>
      authorization.executable.trim() !== authorization.executable
    ) === true
  ) {
    return "agent harness executable bounds are invalid";
  }
  if (
    configuration.executableAuthorizations?.some((authorization) =>
      isNestedCommandLauncher(authorization.executable)
    ) === true
  ) {
    return "agent harness executable bounds include an unboundable nested-command launcher";
  }
  if (
    configuration.executableAuthorizations?.some((authorization) =>
      authorization.behavior === "script-interpreter"
    ) === true
  ) {
    return "agent harness script-interpreter execution requires an unavailable cross-platform sandbox";
  }
  for (const origin of configuration.allowedOrigins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) {
        return "agent harness origin bounds must be exact HTTPS origins";
      }
    } catch {
      return "agent harness origin bounds are invalid";
    }
  }
  return undefined;
};

const boundedTask = (
  task: PlannedSynchronization["agentTasks"][number],
  configuration: FollowerAgentHarnessConfiguration,
) =>
  Effect.gen(function*() {
    const allowedExecutables: Array<string> = [];
    for (const executable of task.allowedExecutables) {
      if (yield* executableAllowed(
        executable,
        configuration.allowedExecutables,
        configuration.environment,
        task.allowedPaths[0] ?? process.cwd(),
      )) {
        allowedExecutables.push(executable);
      }
    }
    // Authorizations may only claim executables that survived the harness
    // allowlist; otherwise the bounded task would over-claim its bounds.
    const boundedAuthorizations = task.executableAuthorizations?.filter(
      (authorization) => allowedExecutables.includes(authorization.executable),
    );
    return {
      ...task,
      allowedPaths: task.allowedPaths.filter((path) =>
        pathWithinHarnessBounds(path, configuration)
      ),
      allowedExecutables,
      executableAuthorizations: boundedAuthorizations,
      allowedOrigins: task.allowedOrigins.filter((origin) =>
        originWithinHarnessBounds(origin, configuration)
      ),
      forbidden: [...new Set([
        ...task.forbidden,
        ...(["elevation", "login", "restart", "reboot"] as const).filter(
          (capability) => !configuration.allowedCapabilities.includes(capability),
        ),
      ])],
    };
  });

const recanonicalizePlan = (
  plan: PlannedSynchronization,
  actions: PlannedSynchronization["actions"],
): PlannedSynchronization => {
  const body = {
    revision: plan.revision,
    follower: plan.follower,
    requiredBlobs: plan.requiredBlobs,
    actions,
    agentTasks: plan.agentTasks,
  };
  const encoded = canonicalJson(Schema.decodeUnknownSync(Schema.MutableJson)(
    JSON.parse(JSON.stringify(body)),
  ));
  return { ...body, encoded, digest: sha256Hex(encoded) };
};

const agentConfigurationFor = (
  configuration: FollowerSynchronizationConfiguration,
  scheduled: boolean,
  signal?: AbortSignal,
): SynchronizationAgentConfiguration => ({
  policy: configuration.agentPolicy,
  harness: configuration.agentHarness === undefined
    ? undefined
    : {
      harness: configuration.agentHarness.kind,
      executable: configuration.agentHarness.executable,
      environment: configuration.agentHarness.environment,
      maximumInputBytes: configuration.agentHarness.maximumInputBytes,
      allowedPaths: configuration.agentHarness.allowedPaths,
      allowedExecutables: configuration.agentHarness.allowedExecutables,
      executableAuthorizations: configuration.agentHarness.executableAuthorizations,
      allowedOrigins: configuration.agentHarness.allowedOrigins,
      allowedCapabilities: configuration.agentHarness.allowedCapabilities,
    },
  scheduled,
  signal,
});

/**
 * Brings the native synchronization job in line with the follower's effective
 * schedule, after a converged run.
 *
 * Deliberately outside the resource transaction, and deliberately failure
 * tolerant. A scheduler that does not work is operational degradation on this
 * machine, not a reason to undo configuration that applied correctly: the
 * schedule used to be a planned action, so a host without a working user
 * scheduler failed the whole run and rolled it back, and could never converge.
 *
 * A follower that set its own schedule keeps it. This only installs the
 * inherited profile default, and only when the follower has not decided for
 * itself.
 */
const reconcileInheritedSchedule = Effect.fn(
  "FollowerOrchestration.reconcileInheritedSchedule",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  scheduleDefault: RevisionMetadata["scheduleDefault"],
  scheduleManager: ScheduleManager["Service"] | undefined,
) {
  if (scheduleManager === undefined) return;
  const override = configuration.scheduleOverride;
  if (override !== undefined && override.kind !== "inherit") return;
  if (scheduleDefault === undefined) {
    yield* scheduleManager.remove().pipe(Effect.ignore);
    return;
  }
  yield* scheduleManager.update({
    schedule: syncScheduleFromDefault(scheduleDefault),
  }).pipe(Effect.ignore);
});

const persistProfileScheduleDefault = Effect.fn(
  "FollowerOrchestration.persistProfileScheduleDefault",
)(function*(
  configuration: FollowerSynchronizationConfiguration,
  scheduleDefault: RevisionMetadata["scheduleDefault"],
) {
  const repository = yield* StateRepository;
  const state = yield* repository.loadState(configuration.follower.id);
  if (state.sourceIdentity === undefined) return;
  yield* repository.saveFollowerSynchronizationConfiguration({
    sourceIdentity: state.sourceIdentity,
    configuration: {
      ...configuration,
      scheduleDefault,
      updatedAt: new Date().toISOString(),
    },
  });
});

export const resolveAgentTasks = Effect.fn("FollowerOrchestration.resolveAgentTasks")(
  function*(
    configuration: FollowerSynchronizationConfiguration,
    plan: PlannedSynchronization,
    scheduled: boolean,
    signal?: AbortSignal,
    planning = false,
  ) {
    const noResolutions: ReadonlyArray<AgentResolutionOutcome> = [];
    if (
      plan.agentTasks.length === 0
      || configuration.agentPolicy === "deterministic-only"
    ) {
      return {
        plan,
        agentResolutions: noResolutions,
      };
    }
    const harness = configuration.agentHarness;
    const harnessIssue = harness === undefined
      ? "Agent harness is not configured"
      : harnessConfigurationIssue(harness);
    if (harness === undefined || harnessIssue !== undefined) {
      const actions = plan.actions.map((action) =>
        action.detail.kind === "agent-task"
          ? {
            ...action,
            kind: "human-action" as const,
            detail: {
              kind: "human-action" as const,
              reason: `${harnessIssue} for ${action.detail.summary}`,
              instructions:
                "Configure a supported bounded agent harness, or switch to deterministic-only policy, then rerun synchronization.",
            },
          }
          : action
      );
      return {
        plan: recanonicalizePlan(plan, actions),
        agentResolutions: noResolutions,
      };
    }
    const agent = yield* AgentResolution;
    const resolutions: Array<AgentResolutionOutcome> = [];
    const replacements = new Map<string, "resolved" | "human">();
    const reasons = new Map<string, string>();
    for (const task of plan.agentTasks) {
      const bounded = yield* boundedTask(task, harness);
      const resolution = yield* agent.resolve({
        policy: planning ? "agent-propose" : configuration.agentPolicy,
        task: bounded,
        harness: {
          harness: harness.kind,
          executable: harness.executable,
          environment: harness.environment,
          maximumInputBytes: harness.maximumInputBytes,
          allowedPaths: harness.allowedPaths,
          allowedExecutables: harness.allowedExecutables,
          executableAuthorizations: harness.executableAuthorizations,
          allowedOrigins: harness.allowedOrigins,
          allowedCapabilities: harness.allowedCapabilities,
        },
        scheduled,
        signal,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (outcome) => ({ outcome }),
        }),
      );
      if ("error" in resolution) {
        const reason =
          `Configured agent harness could not safely resolve the task: ${resolution.error.message.slice(0, 1024)}`;
        replacements.set(task.id, "human");
        reasons.set(task.id, reason);
        // Report the refusal rather than dropping it. A plan used to compute
        // this and discard it, so the agent task showed unchanged with an
        // empty agentResolutions and no reason at all.
        resolutions.push({ outcome: "refused", task: bounded, reason });
        continue;
      }
      resolutions.push(resolution.outcome);
      replacements.set(
        task.id,
        resolution.outcome.outcome === "applied" ? "resolved" : "human",
      );
      if (resolution.outcome.outcome === "proposed") {
        reasons.set(
          task.id,
          `Agent proposal requires human review: ${resolution.outcome.proposal.summary}`,
        );
      }
    }
    const actions = plan.actions.map((action) => {
      if (action.detail.kind !== "agent-task") return action;
      if (planning) return action;
      const replacement = replacements.get(action.detail.taskId);
      if (replacement === "resolved") {
        return {
          ...action,
          kind: "no-op" as const,
          detail: { kind: "no-op" as const },
        };
      }
      return {
        ...action,
        kind: "human-action" as const,
        detail: {
          kind: "human-action" as const,
          reason: reasons.get(action.detail.taskId)
            ?? `Bounded agent task requires resolution: ${action.detail.summary}`,
          instructions:
            `Resolve task ${action.detail.taskId} under the configured bounds, then rerun synchronization.`,
        },
      };
    });
    return {
      plan: recanonicalizePlan(plan, actions),
      agentResolutions: resolutions,
    };
  },
);

export const synchronizeFollower = Effect.fn(
  "FollowerOrchestration.synchronize",
)(function*(
  stateLocation: string,
  mode: "plan" | "apply",
  signal?: AbortSignal,
  scheduled = false,
) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const synchronization = yield* Synchronization;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );
  const scheduleManager = Option.getOrUndefined(
    yield* Effect.serviceOption(ScheduleManager),
  );
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const selected = yield* selectedRevision(configuration, undefined, signal);
  const fetched = yield* fetchRevision({
    ...transportInput(configuration, signal),
    revisionId: selected.id,
    cacheDirectory: configuration.cacheDirectory,
    maximumMetadataBytes:
      configuration.scheduledInvocation.maximumMetadataBytes,
    maximumBlobBytes: configuration.scheduledInvocation.maximumBlobBytes,
  }).pipe(Effect.provideService(MachineState, machine));
  const appliedResources = yield* repository.loadAppliedResources(
    configuration.follower.id,
  );
  const hydrated = yield* hydrateRevision(
    fetched,
    appliedResources,
    scheduleManager,
  ).pipe(
    Effect.provideService(MachineState, machine),
  );
  if (mode === "apply") {
    yield* repository.publishRevision({
      revision: persistableRevision(hydrated.revision),
    });
  }
  const plan = yield* planSynchronization({
    revision: hydrated.revision,
    follower: configuration.follower.id,
    observedState: {
      platform: (yield* machine.userDirectories()).home.platform,
      resources: hydrated.observations,
      availableBlobs: fetched.blobs.map((blob) => blob.id),
    },
    localOverlay: configuration.localOverlay ?? [],
    appliedResources,
  });
  const noAgentResolutions: ReadonlyArray<AgentResolutionOutcome> = [];
  // `agent-propose` records a proposal and stops, which is what the operator
  // documentation and the glossary describe. Apply used to skip resolution
  // entirely and turn every Agent Task straight into a human action without
  // ever invoking the harness, so no proposal was ever recorded.
  //
  // Resolving here is safe for both cases this covers: planning asks the
  // harness to propose, and `agent-propose` proposes by definition, so neither
  // mutates the machine before the run begins. `agent-apply` still resolves
  // inside the run, where its mutation is journaled for recovery.
  const resolveBeforeRun = mode === "plan"
    || configuration.agentPolicy === "agent-propose";
  const planned = resolveBeforeRun
    ? yield* resolveAgentTasks(
      configuration,
      plan,
      scheduled,
      signal,
      mode === "plan",
    )
    : { plan: plan, agentResolutions: noAgentResolutions };
  const appliedAgentResolutions: Array<AgentResolutionOutcome> = [];
  const journaledAgentResolution = mode === "apply" && agentResolution !== undefined
    ? AgentResolution.of({
      resolve: (input) =>
        agentResolution.resolve(input).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              appliedAgentResolutions.push(outcome);
            })
          ),
        ),
      proposeProfileChange: agentResolution.proposeProfileChange,
    })
    : undefined;
  if (mode === "plan") {
    return {
      mode,
      revision: selected.id,
      downloadedBlobs: fetched.downloadedBlobs,
      reusedBlobs: fetched.reusedBlobs,
      plan: planned.plan,
      agentResolutions: planned.agentResolutions,
    };
  }
  const outcome = yield* synchronization.run({
    id: Schema.decodeUnknownSync(RunId)(`run-${randomUUID()}`),
    plan: planned.plan,
    revision: hydrated.revision,
    appliedResources,
    artifacts: hydrated.artifacts,
    agent: agentConfigurationFor(configuration, scheduled, signal),
    agentResolution: journaledAgentResolution,
    limits: {
      // The transport timeout used to be passed here, which killed any
      // installer or `command` verification that ran longer than 10 seconds.
      processTimeoutMilliseconds: localProcessTimeout(configuration),
    },
  });
  if (outcome.outcome === "Converged") {
    yield* persistProfileScheduleDefault(
      configuration,
      fetched.metadata.scheduleDefault,
    );
    yield* reconcileInheritedSchedule(
      configuration,
      fetched.metadata.scheduleDefault,
      scheduleManager,
    );
  }
  return {
    mode,
    revision: selected.id,
    downloadedBlobs: fetched.downloadedBlobs,
    reusedBlobs: fetched.reusedBlobs,
    agentResolutions: appliedAgentResolutions,
    outcome,
  };
});

/**
 * Closes an interrupted run without recovering it.
 *
 * `recover` needs the run's source revision to still be authorized, so a
 * follower whose view changed, whose source is gone, or which was pointed at
 * another profile could not close its run at all: `recover` failed and
 * `sync --apply` was refused with `ActiveRunExistsError` on every attempt, with
 * no way out short of editing the database.
 *
 * This is deliberately not a rollback. Whatever the interrupted run had already
 * applied stays applied, and the next run reconciles it like any other
 * follower state. Abandoning only stops the open run from blocking that.
 */
export const abandonFollowerRun = Effect.fn(
  "FollowerOrchestration.abandon",
)(function*(stateLocation: string) {
  const repository = yield* StateRepository;
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const recovery = yield* repository.loadRecovery(configuration.follower.id);
  if (recovery === undefined) {
    return yield* configurationError(
      "stale",
      "no durable interrupted synchronization run is available",
    );
  }
  const appliedResources = yield* repository.loadAppliedResources(
    configuration.follower.id,
  );
  yield* repository.completeRun({
    run: recovery.run.id,
    completedAt: new Date().toISOString(),
    outcome: {
      outcome: "Failed",
      run: recovery.run.id,
      reason: "the interrupted run was abandoned by the operator",
    },
    appliedResources,
  });
  return {
    run: recovery.run.id,
    revision: recovery.run.revision,
    abandoned: true as const,
  };
});

export const recoverFollower = Effect.fn(
  "FollowerOrchestration.recover",
)(function*(stateLocation: string, signal?: AbortSignal) {
  const repository = yield* StateRepository;
  const machine = yield* MachineState;
  const synchronization = yield* Synchronization;
  const agentResolution = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentResolution),
  );
  const scheduleManager = Option.getOrUndefined(
    yield* Effect.serviceOption(ScheduleManager),
  );
  const configuration = yield* loadFollowerSynchronizationConfiguration(
    stateLocation,
  );
  const recovery = yield* repository.loadRecovery(configuration.follower.id);
  if (recovery === undefined) {
    return yield* configurationError(
      "stale",
      "no durable interrupted synchronization run is available",
    );
  }
  const sourceRevision = recovery.run.revision.replace(
    /:view:[a-f0-9]{64}$/u,
    "",
  );
  const selected = yield* selectedRevision(
    configuration,
    sourceRevision,
    signal,
  );
  const fetched = yield* fetchRevision({
    ...transportInput(configuration, signal),
    revisionId: selected.id,
    cacheDirectory: configuration.cacheDirectory,
    maximumMetadataBytes:
      configuration.scheduledInvocation.maximumMetadataBytes,
    maximumBlobBytes: configuration.scheduledInvocation.maximumBlobBytes,
  }).pipe(Effect.provideService(MachineState, machine));
  const appliedResources = [
    ...new Map([
      ...(yield* repository.loadAppliedResources(configuration.follower.id)),
      ...recovery.removedResources,
    ].map((record) => [record.resource, record] as const)).values(),
  ];
  const hydrated = yield* hydrateRevision(
    fetched,
    appliedResources,
    scheduleManager,
  ).pipe(
    Effect.provideService(MachineState, machine),
  );
  const outcome = yield* synchronization.recover({
    follower: configuration.follower.id,
    revision: hydrated.revision,
    artifacts: hydrated.artifacts,
    agent: agentConfigurationFor(configuration, false, signal),
    agentResolution,
    limits: {
      // The transport timeout used to be passed here, which killed any
      // installer or `command` verification that ran longer than 10 seconds.
      processTimeoutMilliseconds: localProcessTimeout(configuration),
    },
  });
  if (outcome.outcome === "Converged") {
    yield* persistProfileScheduleDefault(
      configuration,
      fetched.metadata.scheduleDefault,
    );
  }
  return {
    revision: selected.id,
    downloadedBlobs: fetched.downloadedBlobs,
    reusedBlobs: fetched.reusedBlobs,
    outcome,
  };
});
