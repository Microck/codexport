import { Effect, Schema } from "effect";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";

import { ContentDigest, CredentialReference, type RunId } from "../domain/brand.ts";
import {
  ResourceSpecInputSchema,
  type PublishedResource,
  type ResourceSpecInput,
  type VerificationInput,
} from "../domain/profile.ts";
import {
  AutomaticRecipeMethod,
  type BuildPolicy,
  type RecipeIndexPolicy,
  type RecipeSource,
} from "../domain/resource.ts";
import type { PlannedAction } from "../domain/synchronization.ts";
import { composeTextFile, parseTextComposition, sourceTextIssue } from "../domain/text-composition.ts";
import { MachineFilesystemError, type MachineStateError } from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import { FilePermissionSnapshot, type MachinePath } from "../machine/machine-state.types.ts";
import {
  directoryVerificationDigest,
  sha256BytesHex,
  sha256Hex,
} from "../profile/profile-codec.ts";
import {
  type SetScheduleInput,
  type SyncSchedule,
} from "../schedule/schedule-manager.types.ts";
import {
  ActionExecutionError,
  InvalidArtifactError,
  InvalidExecutionPlanError,
  MissingArtifactError,
  type SynchronizationExecutionInputError,
} from "./synchronization.errors.ts";
import type {
  DesiredResource,
  SynchronizationArtifact,
  SynchronizationExecutionLimits,
} from "./synchronization.types.ts";
import {
  getConfigPath,
  parseConfigDocument,
  removeConfigPath,
  serializeConfigDocument,
  setConfigPath,
} from "./config-codec.ts";
import { parseNpmPackageSpecification } from "../domain/npm-package-spec.ts";
import {
  isMissingAutomaticRecipeVersion,
  recipeSourceDetails,
  recipeValidationError,
  canonicalRecipeIndexUrl,
  defaultPythonIndex,
  npmVersionFromTarballSource,
} from "../domain/recipe-versions.ts";
import {
  defaultNpmArtifactTransport,
  validateNpmArtifactProvenance,
  verifyNpmArtifactBytes,
  type NpmArtifactTransport,
} from "./npm-artifact.ts";
import { relativePathAncestors } from "./resource-plans.ts";

const isUnboundedNonNpmPackage = (value: string): boolean =>
  /^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value)
  || /(?:^|@)(?:npm:|git\+|git:\/\/|github:|gitlab:|bitbucket:|git@|file:|link:|workspace:|https?:\/\/)/iu
    .test(value);

type StoredFile = typeof StoredFileSchema.Type;

const StoredFileSchema = Schema.Union([
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("absent"),
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("directory"),
    permissions: FilePermissionSnapshot,
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("regular"),
    digest: ContentDigest,
    permissions: FilePermissionSnapshot,
  }),
  Schema.Struct({
    path: Schema.NonEmptyString,
    state: Schema.Literal("symlink"),
    target: Schema.NonEmptyString,
  }),
]);

/** Derived locally, never accepted as a path from persisted metadata. */
const backupFile = (reference: string, target: string): string =>
  `${reference}.${sha256Hex(target)}.bin`;

interface RollbackMaterial {
  readonly reference: string;
  readonly stored: ReadonlyArray<StoredFile>;
  readonly restore: Effect.Effect<void, SynchronizationExecutionInputError | MachineStateError, MachineState>;
}

export interface ResourceExecutionContext {
  readonly run: RunId;
  readonly action: PlannedAction;
  readonly resource: PublishedResource;
  readonly desired: DesiredResource;
  readonly verification: VerificationInput;
  readonly artifacts: ReadonlyMap<string, SynchronizationArtifact>;
  readonly limits: SynchronizationExecutionLimits;
  readonly previousSchedule?: SyncSchedule | undefined;
  /**
   * The default is the bounded HTTPS artifact transport. This optional seam
   * lets integration tests use a local HTTPS fixture without altering a
   * reviewed source or the production transport policy.
   */
  readonly npmArtifactTransport?: NpmArtifactTransport | undefined;
}

export interface PreparedResourceAction {
  readonly rollbackReference?: string | undefined;
  readonly execute: Effect.Effect<void, SynchronizationExecutionInputError | MachineStateError, MachineState>;
  readonly rollback?: Effect.Effect<
    void,
    SynchronizationExecutionInputError | MachineStateError,
    MachineState
  > | undefined;
}

export interface ResourceVerification {
  readonly passed: boolean;
  readonly method: string;
  readonly observedDigest?: string | undefined;
  readonly exitCode?: number | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const artifact = (
  artifacts: ReadonlyMap<string, SynchronizationArtifact>,
  digest: string,
): Effect.Effect<Uint8Array, MissingArtifactError | InvalidArtifactError> => {
  const value = artifacts.get(digest);
  if (value === undefined) return Effect.fail(new MissingArtifactError({ digest }));
  const observed = sha256BytesHex(value.content);
  if (observed !== digest) {
    return Effect.fail(new InvalidArtifactError({
      digest,
      message: `artifact content digest was ${observed}`,
    }));
  }
  return Effect.succeed(value.content);
};

const readIfPresent = (
  path: MachinePath,
  maximumBytes: number,
): Effect.Effect<Uint8Array | undefined, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.readFile({ path, maximumBytes }).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
  });

const captureStoredFile = (
  path: MachinePath,
): Effect.Effect<StoredFile, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const kind = yield* machine.inspectPath(path).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT") || error.message.includes("ENOTDIR")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
    if (kind === undefined) return { path: path.absolute, state: "absent" };
    if (kind.kind === "directory") {
      const permissions = yield* machine.snapshotPermissions(path);
      return { path: path.absolute, state: "directory", permissions };
    }
    const symlink = yield* machine.readSymlink(path).pipe(
      Effect.catchTag("MachineFilesystemError", () => Effect.succeed(undefined)),
    );
    if (symlink !== undefined) {
      return { path: path.absolute, state: "symlink", target: symlink };
    }
    const digest = yield* machine.digestFile({ path });
    const permissions = yield* machine.snapshotPermissions(path);
    return {
      path: path.absolute,
      state: "regular",
      digest: digest.value,
      permissions,
    };
  });

const restoreStoredFile = (
  entry: StoredFile,
  reference: string,
  root?: MachinePath | undefined,
  directoryPermissions: "restore" | "writable" = "restore",
): Effect.Effect<void, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: entry.path });
    if ((entry.state === "regular" || entry.state === "directory")
      && (path.platform === "windows") !== (entry.permissions.platform === "windows")) {
      return yield* new MachineFilesystemError({
        operation: "restore permissions",
        path: entry.path,
        message: "permission snapshot belongs to a different platform",
      });
    }
    switch (entry.state) {
      case "absent":
        if (root === undefined) {
          yield* machine.removeFile({ path });
        } else {
          const currentKind = yield* machine.inspectPath(path).pipe(
            Effect.catchTag("MachineFilesystemError", (error) =>
              error.message.includes("ENOENT")
                ? Effect.succeed(undefined)
                : Effect.fail(error)
            ),
          );
          if (currentKind?.kind === "directory") {
            yield* machine.removeEmptyDirectory({ path });
          } else {
            yield* machine.mutateWithinRoot({
              root,
              path,
              mutation: { kind: "remove" },
            });
          }
        }
        return;
      case "directory": {
        const policy = directoryPermissions === "writable"
          ? { mode: entry.permissions.mode | 0o700 }
          : { permissions: entry.permissions };
        if (root === undefined) {
          const currentKind = yield* machine.inspectPath(path).pipe(
            Effect.catchTag("MachineFilesystemError", (error) =>
              error.message.includes("ENOENT")
                ? Effect.succeed(undefined)
                : Effect.fail(error)
            ),
          );
          if (currentKind !== undefined && currentKind.kind !== "directory") {
            yield* machine.removeFile({ path });
          }
          yield* machine.ensureDirectory({ path, mode: entry.permissions.mode | 0o700 });
          yield* machine.setPermissions({ path, ...policy });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "directory", ...policy },
          });
        }
        return;
      }
      case "regular": {
        const content = { file: backupFile(reference, entry.path), digest: entry.digest };
        if (root === undefined) {
          yield* machine.atomicWrite({ path, content, permissions: entry.permissions });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "write", content, permissions: entry.permissions },
          });
        }
        return;
      }
      case "symlink": {
        if (root === undefined) {
          yield* machine.replaceSymlink({ path, target: entry.target });
        } else {
          yield* machine.mutateWithinRoot({
            root,
            path,
            mutation: { kind: "symlink", target: entry.target },
          });
        }
      }
    }
  });

const normalizeRelative = (
  target: MachinePath,
  relative: string,
): Effect.Effect<MachinePath, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (
      relative.length === 0
      || relative.startsWith("/")
      || relative.startsWith("\\")
      || /^[A-Za-z]:/u.test(relative)
      || relative.split(/[\\/]/u).includes("..")
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `mirror path must remain relative to its target: ${relative}`,
      });
    }
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path: relative, base: target });
  });

const sameMachinePath = (
  left: MachinePath,
  right: MachinePath,
): boolean =>
  left.platform === right.platform
  && (
    left.platform === "windows"
      ? left.absolute.toLowerCase() === right.absolute.toLowerCase()
      : left.absolute === right.absolute
  );

const machinePathKey = (path: MachinePath): string =>
  `${path.platform}:${path.platform === "windows"
    ? path.absolute.toLowerCase()
    : path.absolute}`;

const pathWithinMachineRoot = (
  root: MachinePath,
  path: MachinePath,
): boolean => {
  if (root.platform !== path.platform) return false;
  const remainder = root.platform === "windows"
    ? win32.relative(root.absolute.toLowerCase(), path.absolute.toLowerCase())
    : relative(root.absolute, path.absolute);
  return remainder === ""
    || (
      !remainder.startsWith("..")
      && !win32.isAbsolute(remainder)
      && !isAbsolute(remainder)
    );
};

/**
 * Return the exact deterministic rollback path set. Directory mutations need
 * snapshots for every intermediate ancestor because a failed restart can
 * otherwise leave newly-created nested directories behind. Keep this
 * expansion shared by capture and recovery validation so the persisted
 * material cannot be rejected or accepted under a different path contract.
 */
const rollbackPathSet = (
  paths: ReadonlyArray<MachinePath>,
  root?: MachinePath | undefined,
): Effect.Effect<
  ReadonlyArray<MachinePath>,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const normalizedRoot = root === undefined
      ? undefined
      : yield* machine.normalizePath({ path: root.absolute });
    const normalizedPaths = yield* Effect.forEach(
      paths,
      (path) => machine.normalizePath({ path: path.absolute }),
    );
    const pathsWithAncestors = new Map(
      normalizedPaths.map((path) => [machinePathKey(path), path] as const),
    );
    if (normalizedRoot !== undefined) {
      for (const path of normalizedPaths) {
        if (!pathWithinMachineRoot(normalizedRoot, path)) {
          return yield* new InvalidExecutionPlanError({
            message: `rollback path is outside managed root ${normalizedRoot.absolute}: ${path.absolute}`,
          });
        }
        if (sameMachinePath(path, normalizedRoot)) continue;
        let ancestor = path.platform === "windows"
          ? win32.dirname(path.absolute)
          : dirname(path.absolute);
        while (!sameMachinePath({ platform: normalizedRoot.platform, absolute: ancestor }, normalizedRoot)) {
          const candidate: MachinePath = {
            platform: normalizedRoot.platform,
            absolute: ancestor,
          };
          if (!pathWithinMachineRoot(normalizedRoot, candidate)) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback ancestor is outside managed root ${normalizedRoot.absolute}: ${ancestor}`,
            });
          }
          const normalized = yield* machine.normalizePath({ path: ancestor });
          if (!pathWithinMachineRoot(normalizedRoot, normalized)) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback ancestor is outside managed root ${normalizedRoot.absolute}: ${normalized.absolute}`,
            });
          }
          pathsWithAncestors.set(machinePathKey(normalized), normalized);
          const parent = normalized.platform === "windows"
            ? win32.dirname(normalized.absolute)
            : dirname(normalized.absolute);
          if (parent === normalized.absolute) {
            return yield* new InvalidExecutionPlanError({
              message: `rollback path ancestry did not reach managed root ${normalizedRoot.absolute}`,
            });
          }
          ancestor = parent;
        }
      }
    }
    return [...pathsWithAncestors.values()].sort((left, right) =>
      left.platform.localeCompare(right.platform)
      || left.absolute.localeCompare(right.absolute)
    );
  });

const deepestPathFirst = <Value>(
  entries: ReadonlyArray<Value>,
  pathOf: (entry: Value) => string,
): ReadonlyArray<Value> =>
  entries
    .map((value) => {
      const path = pathOf(value);
      return { value, path, depth: path.split(/[\\/]/u).length };
    })
    .sort((left, right) =>
      right.depth - left.depth
      || right.path.length - left.path.length
      || left.path.localeCompare(right.path)
    )
    .map(({ value }) => value);

type StoredDirectory = Extract<StoredFile, { readonly state: "directory" }>;

/**
 * Restore a managed tree while its directories are still writable. Exact
 * captured modes are applied from the leaves upward only after every child
 * object is back in place, with the root mode applied last.
 */
const restoreStoredFiles = (
  stored: ReadonlyArray<StoredFile>,
  reference: string,
  root?: MachinePath | undefined,
): Effect.Effect<void, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const deepestEntries = deepestPathFirst(stored, (file) => file.path);
    if (root === undefined) {
      for (const entry of deepestEntries) {
        yield* restoreStoredFile(entry, reference);
      }
      return;
    }

    const machine = yield* MachineState;
    const rootEntry = stored.find((entry) => entry.path === root.absolute);
    const rootState = rootEntry?.state;
    const directories = stored.filter(
      (entry): entry is StoredDirectory => entry.state === "directory",
    );
    const deepestDirectories = deepestPathFirst(directories, (entry) => entry.path);
    const rootDirectory = directories.find((entry) => entry.path === root.absolute);
    if (rootEntry !== undefined && rootState !== "absent" && rootState !== "directory") {
      for (const entry of deepestEntries) {
        if (entry === rootEntry) continue;
        yield* restoreStoredFile(entry, reference, root);
      }
      yield* restoreStoredFile(rootEntry, reference);
      return;
    }

    if (rootDirectory !== undefined) {
      yield* restoreStoredFile(rootDirectory, reference, undefined, "writable");
    } else {
      const currentKind = yield* machine.inspectPath(root).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          error.message.includes("ENOENT")
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        ),
      );
      // The captured state says the whole tree was absent, and it still is.
      // Restoring entries inside it would be restoring them to absent, and
      // every one of those goes through the managed root, which is opened with
      // O_DIRECTORY: that threw ENOENT and left `canonfig recover` failing on
      // repeat with the run still open, so the follower was stuck until the
      // operator created the directory by hand.
      if (currentKind === undefined && rootState === "absent") return;
      if (currentKind?.kind === "directory") {
        yield* machine.setPermissions({ path: root, mode: 0o700 });
      }
    }

    for (const directory of [...deepestDirectories].reverse()) {
      if (directory === rootEntry) continue;
      yield* restoreStoredFile(directory, reference, root, "writable");
    }

    for (const entry of deepestEntries) {
      if (entry === rootEntry || entry.state === "directory") continue;
      yield* restoreStoredFile(entry, reference, root);
    }

    for (const directory of deepestDirectories) {
      if (directory === rootEntry) continue;
      yield* restoreStoredFile(directory, reference, root);
    }
    if (rootDirectory !== undefined) {
      yield* machine.setPermissions({ path: root, permissions: rootDirectory.permissions });
    } else if (rootEntry !== undefined && rootState === "absent") {
      yield* machine.removeEmptyDirectory({ path: root }).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
        ),
      );
    }
  });

const captureRollback = (
  context: ResourceExecutionContext,
  paths: ReadonlyArray<MachinePath>,
  root?: MachinePath | undefined,
): Effect.Effect<
  RollbackMaterial,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const rollbackDirectory = yield* machine.normalizePath({
      path: `canonfig/rollback/${context.run}`,
      base: directories.cache,
    });
    yield* machine.ensureDirectory({ path: rollbackDirectory });
    const rollbackPath = yield* machine.normalizePath({
      path: `${sha256Hex(context.action.id)}.json`,
      base: rollbackDirectory,
    });
    const pathsWithAncestors = yield* rollbackPathSet(paths, root);
    const rootKind = root === undefined
      ? undefined
      : yield* machine.inspectPath(root).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          error.message.includes("ENOENT")
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        ),
      );
    const stored = yield* Effect.forEach(
      pathsWithAncestors,
      (path) =>
        root !== undefined
          && rootKind !== undefined
          && rootKind.kind !== "directory"
          && !sameMachinePath(path, root)
          ? Effect.succeed({ path: path.absolute, state: "absent" } as const)
          : Effect.gen(function*() {
            const entry = yield* captureStoredFile(path);
            if (entry.state === "regular") {
              const backup = yield* machine.normalizePath({ path: backupFile(rollbackPath.absolute, entry.path) });
              yield* machine.atomicWrite({
                path: backup,
                content: { file: entry.path, digest: entry.digest },
                mode: 0o600,
              });
            }
            return entry;
          }),
    );
    yield* machine.atomicWrite({
      path: rollbackPath,
      content: encoder.encode(JSON.stringify(stored)),
    });
    const restore = context.resource.policy === "append-local"
      ? restoreAppendLocal(context, stored, rollbackPath.absolute)
      : restoreStoredFiles(stored, rollbackPath.absolute, root);
    return { reference: rollbackPath.absolute, stored, restore };
  });

const rollbackPaths = (
  context: ResourceExecutionContext,
): Effect.Effect<
  ReadonlyArray<MachinePath>,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const detail = context.action.detail;
    switch (detail.kind) {
      case "write-file":
      case "write-config":
        return [yield* targetPath(detail.target)];
      case "mirror-directory": {
        const root = yield* targetPath(detail.target);
        const declaredDirectories = context.desired.kind === "directory"
            || context.desired.kind === "skill"
          ? (context.desired.directories ?? []).map((directory) => directory.path)
          : [];
        const descendants = yield* Effect.forEach(
          [...new Set([...detail.adds, ...detail.removes, ...declaredDirectories])],
          (path) => normalizeRelative(root, path),
        );
        return yield* rollbackPathSet([root, ...descendants], root);
      }
      case "remove-resource": {
        if (context.resource.kind === "directory" || context.resource.kind === "skill") {
          const root = yield* targetPath(detail.target);
          const descendants = yield* Effect.forEach(
            detail.paths,
            (path) => normalizeRelative(root, path),
          );
          return yield* rollbackPathSet([root, ...descendants], root);
        }
        if (context.resource.kind === "file" || context.resource.kind === "config") {
          return [yield* targetPath(detail.target)];
        }
        return [];
      }
      default:
        return [];
    }
  });

/**
 * Restore a persisted, owned-file rollback snapshot. Both the reference and
 * every stored target are re-derived from the immutable action before use.
 */
export const restoreRollbackReference = (
  context: ResourceExecutionContext,
  reference: string,
): Effect.Effect<
  void,
  SynchronizationExecutionInputError | MachineStateError,
  MachineState
> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const directories = yield* machine.userDirectories();
    const rollbackDirectory = yield* machine.normalizePath({
      path: `canonfig/rollback/${context.run}`,
      base: directories.cache,
    });
    const expectedReference = yield* machine.normalizePath({
      path: `${sha256Hex(context.action.id)}.json`,
      base: rollbackDirectory,
    });
    const actualReference = yield* machine.normalizePath({ path: reference });
    if (actualReference.absolute !== expectedReference.absolute) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback reference does not belong to action ${context.action.id}`,
      });
    }
    const expectedPaths = yield* rollbackPaths(context);
    // Only metadata is inline. Allow escaped paths and native symlink text,
    // independently of the size of any regular-file preimage.
    const maximumBytes = expectedPaths.reduce((total, path) => total
      + Buffer.byteLength(JSON.stringify(path.absolute)) + 256 * 1024, 2);
    if (!Number.isSafeInteger(maximumBytes)) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback material is too large for action ${context.action.id}`,
      });
    }
    const bytes = yield* machine.readFile({
      path: actualReference,
      maximumBytes,
    });
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(StoredFileSchema)),
    )(decoder.decode(bytes)).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({
          message: `invalid rollback material for action ${context.action.id}: ${String(error)}. Recover old-format runs with the CLI that created them before upgrading.`,
        })
      ),
    );
    const allowed = new Set(expectedPaths.map((path) => path.absolute));
    if (
      stored.length !== allowed.size
      || stored.some((entry) => !allowed.has(entry.path))
      || new Set(stored.map((entry) => entry.path)).size !== stored.length
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `rollback material targets do not match action ${context.action.id}`,
      });
    }
    const root = context.action.detail.kind === "mirror-directory"
      || (
        context.action.detail.kind === "remove-resource"
        && (context.resource.kind === "directory" || context.resource.kind === "skill")
      )
      ? yield* targetPath(context.action.detail.target)
      : undefined;
    if (context.resource.policy === "append-local") {
      yield* restoreAppendLocal(context, stored, reference);
    } else {
      yield* restoreStoredFiles(stored, reference, root);
    }
  });

const targetPath = (
  target: string,
): Effect.Effect<MachinePath, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    return yield* machine.normalizePath({ path: target });
  });

type StoredTextFile = Extract<StoredFile, { readonly state: "absent" | "regular" }>;

const textSnapshot = (stored: ReadonlyArray<StoredFile>): Effect.Effect<StoredTextFile, InvalidExecutionPlanError> => {
  const entry = stored[0];
  return stored.length === 1 && entry !== undefined
    && (entry.state === "absent" || entry.state === "regular")
    ? Effect.succeed(entry)
    : Effect.fail(new InvalidExecutionPlanError({ message: "append-local requires a regular text file" }));
};

/** Derive the post-write bytes from the very snapshot kept for rollback. */
const appendLocalOutput = (
  context: ResourceExecutionContext,
  before: StoredTextFile,
  reference: string,
): Effect.Effect<{ readonly content: Uint8Array | undefined; readonly mode: number }, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const desired = context.desired;
    if (desired.kind !== "file" || desired.symlinkTo !== undefined || desired.executable
      || ((desired.mode ?? 0) & 0o111) !== 0) {
      return yield* new InvalidExecutionPlanError({ message: "append-local requires a non-executable regular text file" });
    }
    const machine = yield* MachineState;
    const bytesBefore = before.state === "absent" ? undefined : yield* machine.readFile({
      path: yield* targetPath(backupFile(reference, before.path)),
      maximumBytes: context.limits.maximumFileBytes,
    });
    if (before.state === "regular" && bytesBefore !== undefined && sha256BytesHex(bytesBefore) !== before.digest) {
      return yield* new InvalidExecutionPlanError({ message: `rollback backup digest mismatch: ${before.path}` });
    }
    const current = bytesBefore === undefined ? undefined : yield* Effect.try({
      try: () => parseTextComposition(bytesBefore),
      catch: (error) => new InvalidExecutionPlanError({ message: `cannot compose ${before.path}: ${String(error)}` }),
    });
    const mode = context.action.detail.kind === "remove-resource" && before.state === "regular"
      ? before.permissions.mode : desired.mode ?? 0o600;
    if (context.action.detail.kind === "remove-resource") {
      if (current === undefined) return { content: undefined, mode };
      if (current.kind !== "managed" || sha256Hex(current.source) !== desired.digest) {
        return yield* new InvalidExecutionPlanError({ message: `Source text changed before removal: ${before.path}. Replan synchronization.` });
      }
      return { content: encoder.encode(current.local), mode };
    }
    const detail = context.action.detail;
    if (detail.kind !== "write-file") {
      return yield* new InvalidExecutionPlanError({ message: "append-local requires a write-file or removal action" });
    }
    const currentSourceDigest = current?.kind === "managed" ? sha256Hex(current.source) : undefined;
    if (current !== undefined && (current.kind === "managed"
      ? currentSourceDigest !== detail.previousSourceDigest && currentSourceDigest !== desired.digest
      : detail.previousSourceDigest !== undefined)) {
      return yield* new InvalidExecutionPlanError({ message: `Source text changed before writing: ${before.path}. Replan synchronization.` });
    }
    const bytes = yield* artifact(context.artifacts, desired.digest);
    const source = yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const issue = sourceTextIssue(text);
        if (issue !== undefined) throw new Error(issue);
        return text;
      },
      catch: (error) => new InvalidArtifactError({ digest: desired.digest, message: String(error) }),
    });
    const content = composeTextFile(source, current);
    if (content.byteLength > context.limits.maximumFileBytes) {
      return yield* new InvalidExecutionPlanError({ message: `composed text exceeds the ${context.limits.maximumFileBytes}-byte file limit: ${before.path}` });
    }
    return { content, mode };
  });

const sameTextSnapshot = (left: StoredFile, right: StoredTextFile): boolean =>
  left.state === "absent" && right.state === "absent"
    || left.state === "regular" && right.state === "regular"
      && left.digest === right.digest && left.permissions.mode === right.permissions.mode
      && (left.permissions.platform !== "windows"
        ? right.permissions.platform !== "windows"
        : right.permissions.platform === "windows"
          && left.permissions.securityDescriptor === right.permissions.securityDescriptor);

/** Refuse links and special objects before any file read, including recovery. */
const inspectTextTarget = (path: MachinePath) => Effect.gen(function*() {
  const machine = yield* MachineState;
  const kind = yield* machine.inspectPath(path).pipe(
    Effect.catchTag("MachineFilesystemError", (error) => error.message.includes("ENOENT")
      ? Effect.succeed(undefined) : Effect.fail(error)),
  );
  if (kind !== undefined && kind.kind !== "regular") {
    return yield* new InvalidExecutionPlanError({ message: `append-local target is not a regular file: ${path.absolute}` });
  }
});

/**
 * A full backup is evidence, not permission to overwrite later local edits.
 * Recovery accepts only the exact pre- or post-write state of this action.
 */
const restoreAppendLocal = (context: ResourceExecutionContext, stored: ReadonlyArray<StoredFile>, reference: string) =>
  Effect.gen(function*() {
    const before = yield* textSnapshot(stored);
    const path = yield* targetPath(before.path);
    yield* inspectTextTarget(path);
    const current = yield* captureStoredFile(path);
    if (sameTextSnapshot(current, before)) return;
    const { content, mode } = yield* appendLocalOutput(context, before, reference);
    // The intended write has a portable mode, not the preimage's native ACL.
    const matchesAfter = content === undefined ? current.state === "absent"
      : current.state === "regular" && current.digest === sha256BytesHex(content)
        && current.permissions.mode === mode;
    if (!matchesAfter) {
      return yield* new InvalidExecutionPlanError({ message: `append-local target changed after the action: ${before.path}. Inspect the retained rollback backup before recovering.` });
    }
    yield* restoreStoredFile(before, reference);
  });

const prepareAppendLocal = (context: ResourceExecutionContext, target: string) =>
  Effect.gen(function*() {
    const path = yield* targetPath(target);
    yield* inspectTextTarget(path);
    const rollback = yield* captureRollback(context, [path]);
    const before = yield* textSnapshot(rollback.stored);
    const { content, mode } = yield* appendLocalOutput(context, before, rollback.reference);
    const execute = Effect.gen(function*() {
      yield* inspectTextTarget(path);
      const current = yield* captureStoredFile(path);
      if (!sameTextSnapshot(current, before)) {
        return yield* new InvalidExecutionPlanError({ message: `append-local target changed while preparing: ${target}. Replan synchronization.` });
      }
      if (content === undefined) return;
      const machine = yield* MachineState;
      yield* machine.atomicWrite({ path, content, mode });
    });
    return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
  });

const prepareWrite = (
  context: ResourceExecutionContext,
  target: string,
  digest: string,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (context.resource.policy === "append-local") return yield* prepareAppendLocal(context, target);
    const path = yield* targetPath(target);
    const rollback = yield* captureRollback(context, [path]);
    const execute = Effect.gen(function*() {
      const machine = yield* MachineState;
      if (context.desired.kind !== "file") {
        const content = yield* artifact(context.artifacts, digest);
        yield* machine.atomicWrite({ path, content });
        return;
      }
      if (context.desired.symlinkTo !== undefined) {
        yield* machine.replaceSymlink({
          path,
          target: context.desired.symlinkTo,
        });
        return;
      }
      const content = yield* artifact(context.artifacts, digest);
      yield* machine.atomicWrite({
        path,
        content,
        mode: context.desired.mode ?? (context.desired.executable ? 0o700 : 0o600),
      });
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareConfig = (
  context: ResourceExecutionContext,
  target: string,
  keys: ReadonlyArray<string>,
  removes: ReadonlyArray<string> = [],
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    if (context.desired.kind !== "config") {
      return yield* new InvalidExecutionPlanError({
        message: `write-config action does not target a config resource: ${context.resource.id}`,
      });
    }
    const config = context.desired;
    const path = yield* targetPath(target);
    const desiredBytes = yield* artifact(context.artifacts, config.digest);
    const desired = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          config.format,
          decoder.decode(desiredBytes),
        ),
      catch: (error) =>
        new InvalidArtifactError({
          digest: config.digest,
          message: String(error),
        }),
    });
    const currentBytes = yield* readIfPresent(path, context.limits.maximumFileBytes);
    const current = currentBytes === undefined
      ? {}
      : yield* Effect.try({
        try: () =>
          parseConfigDocument(
            config.format,
            decoder.decode(currentBytes),
          ),
        catch: (error) =>
          new InvalidExecutionPlanError({
            message: `cannot merge non-object config ${target}: ${String(error)}`,
          }),
      });
    for (const key of keys) {
      const value = getConfigPath(desired, key);
      if (value !== undefined) setConfigPath(current, key, value);
    }
    // Keys Canonfig owned that the revision no longer declares. The planner
    // only asks for this while the file still holds what Canonfig wrote, so
    // there is no local edit here to lose.
    for (const key of removes) {
      removeConfigPath(current, key);
    }
    const content = encoder.encode(
      serializeConfigDocument(config.format, current),
    );
    const rollback = yield* captureRollback(context, [path]);
    const execute = Effect.gen(function*() {
      const machine = yield* MachineState;
      yield* machine.atomicWrite({ path, content });
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareMirror = (
  context: ResourceExecutionContext,
  target: string,
  adds: ReadonlyArray<string>,
  removes: ReadonlyArray<string>,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const desired = context.desired;
    if (desired.kind !== "directory" && desired.kind !== "skill") {
      return yield* new InvalidExecutionPlanError({
        message: `mirror action does not target a directory resource: ${context.resource.id}`,
      });
    }
    const root = yield* targetPath(target);
    const desiredByPath = new Map(desired.files.map((file) => [
      file.path,
      file,
    ]));
    const desiredDirectories = new Map((desired.directories ?? []).map((directory) => [
      directory.path,
      directory,
    ]));
    const removedPaths = new Set(removes);
    const mutationAncestors = relativePathAncestors([...adds, ...removes]);
    const allRelative = [
      ...new Set([
        ...adds,
        ...removes,
        ...desiredDirectories.keys(),
        ...mutationAncestors,
      ]),
    ];
    const paths = yield* Effect.forEach(allRelative, (path) => normalizeRelative(root, path));
    const byRelative = new Map(allRelative.map((path, index) => [path, paths[index]!]));
    const contentByPath = new Map<string, Uint8Array>();
    for (const relative of adds) {
      const desiredFile = desiredByPath.get(relative);
      if (desiredFile === undefined && desiredDirectories.get(relative) === undefined) {
        return yield* new InvalidExecutionPlanError({
          message: `mirror add is absent from desired content: ${relative}`,
        });
      }
      if (desiredFile !== undefined && desiredFile.symlinkTo === undefined) {
        contentByPath.set(
          relative,
          yield* artifact(context.artifacts, desiredFile.digest),
        );
      }
    }
    const rollback = yield* captureRollback(context, [root, ...paths], root);
    const execute = Effect.gen(function*() {
      const activeMachine = yield* MachineState;
      const rootMode = desired.mode ?? 0o700;
      const rootKind = yield* activeMachine.inspectPath(root).pipe(
        Effect.catchTag("MachineFilesystemError", (error) =>
          error.message.includes("ENOENT")
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        ),
      );
      if (rootKind !== undefined && rootKind.kind !== "directory") {
        yield* activeMachine.removeFile({ path: root });
      }
      const traversableRootMode = rootMode | 0o700;
      yield* activeMachine.ensureDirectory({ path: root, mode: traversableRootMode });
      yield* activeMachine.setPermissions({ path: root, mode: traversableRootMode });
      const orderedDirectories = [...desiredDirectories.values()].sort((left, right) =>
        left.path.split("/").length - right.path.split("/").length
        || left.path.localeCompare(right.path)
      );
      const orderedMutationAncestors = [...mutationAncestors].sort((left, right) =>
        left.split("/").length - right.split("/").length
        || left.localeCompare(right)
      );
      const preservedAncestorModes = new Map<string, number>();
      // Widen before child mutations, then restore surviving modes below.
      for (const relative of orderedMutationAncestors) {
        const path = byRelative.get(relative)!;
        const current = yield* activeMachine.inspectPath(path).pipe(
          Effect.catchTag("MachineFilesystemError", (error) =>
            error.message.includes("ENOENT")
              ? Effect.succeed(undefined)
              : Effect.fail(error)
          ),
        );
        if (current?.kind === "directory") {
          const permissions = yield* activeMachine.permissions(path);
          if (!desiredDirectories.has(relative) && !removedPaths.has(relative)) {
            preservedAncestorModes.set(relative, permissions.mode);
          }
          const writableMode = permissions.mode | 0o700;
          if (writableMode !== permissions.mode) {
            yield* activeMachine.setPermissions({ path, mode: writableMode });
          }
        }
      }
      const orderedRemoves = [...removes].sort((left, right) =>
        right.split("/").length - left.split("/").length
      );
      for (const relative of orderedRemoves) {
        yield* activeMachine.mutateWithinRoot({
          root,
          path: byRelative.get(relative)!,
          mutation: { kind: "remove" },
        });
      }
      for (const directory of orderedDirectories) {
        yield* activeMachine.mutateWithinRoot({
          root,
          path: byRelative.get(directory.path)!,
          mutation: { kind: "directory", mode: directory.mode | 0o700 },
        });
      }
      const orderedAdds = adds
        .filter((relative) => !desiredDirectories.has(relative))
        .sort((left, right) =>
          left.split("/").length - right.split("/").length
          || left.localeCompare(right)
        );
      for (const relative of orderedAdds) {
        const desiredFile = desiredByPath.get(relative)!;
        yield* activeMachine.mutateWithinRoot({
          root,
          path: byRelative.get(relative)!,
          mutation: desiredFile.symlinkTo === undefined
            ? {
              kind: "write",
              content: contentByPath.get(relative)!,
              mode: desiredFile.mode ?? (desiredFile.executable ? 0o700 : 0o600),
            }
            : { kind: "symlink", target: desiredFile.symlinkTo },
        });
      }
      const finalDirectoryModes = deepestPathFirst(
        [
          ...orderedDirectories,
          ...[...preservedAncestorModes].map(([path, mode]) => ({ path, mode })),
        ],
        (directory) => directory.path,
      );
      for (const directory of finalDirectoryModes) {
        yield* activeMachine.setPermissions({
          path: byRelative.get(directory.path)!,
          mode: directory.mode,
        });
      }
      yield* activeMachine.setPermissions({ path: root, mode: rootMode });
    });
    return {
      rollbackReference: rollback.reference,
      execute,
      rollback: rollback.restore,
    };
  });

const prepareRemoval = (
  context: ResourceExecutionContext,
  detail: Extract<PlannedAction["detail"], { readonly kind: "remove-resource" }>,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    switch (context.resource.kind) {
      case "file": {
        if (context.resource.policy === "append-local") return yield* prepareAppendLocal(context, detail.target);
        const path = yield* targetPath(detail.target);
        const rollback = yield* captureRollback(context, [path]);
        const execute = Effect.gen(function*() {
          const machine = yield* MachineState;
          yield* machine.removeFile({ path }).pipe(
            Effect.catchTag("MachineFilesystemError", (error) =>
              error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
            ),
          );
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "config": {
        if (context.resource.policy === "replace") {
          const path = yield* targetPath(detail.target);
          const rollback = yield* captureRollback(context, [path]);
          const execute = Effect.gen(function*() {
            const machine = yield* MachineState;
            yield* machine.removeFile({ path }).pipe(
              Effect.catchTag("MachineFilesystemError", (error) =>
                error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
              ),
            );
          });
          return {
            rollbackReference: rollback.reference,
            execute,
            rollback: rollback.restore,
          };
        }
        if (context.desired.kind !== "config") {
          return yield* new InvalidExecutionPlanError({
            message: `removal action does not target a config resource: ${context.resource.id}`,
          });
        }
        const config = context.desired;
        const path = yield* targetPath(detail.target);
        const rollback = yield* captureRollback(context, [path]);
        const execute = Effect.gen(function*() {
          const currentBytes = yield* readIfPresent(
            path,
            context.limits.maximumFileBytes,
          );
          if (currentBytes === undefined) return;
          const current = yield* Effect.try({
            try: () => parseConfigDocument(
              config.format,
              decoder.decode(currentBytes),
            ),
            catch: (error) => new InvalidExecutionPlanError({
              message: `cannot remove keys from config ${detail.target}: ${String(error)}`,
            }),
          });
          for (const key of detail.keys) removeConfigPath(current, key);
          const machine = yield* MachineState;
          yield* machine.atomicWrite({
            path,
            content: encoder.encode(serializeConfigDocument(config.format, current)),
          });
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "directory":
      case "skill": {
        if (context.desired.kind !== "directory" && context.desired.kind !== "skill") {
          return yield* new InvalidExecutionPlanError({
            message: `removal action does not target a directory resource: ${context.resource.id}`,
          });
        }
        const root = yield* targetPath(detail.target);
        const paths = yield* Effect.forEach(
          detail.paths,
          (path) => normalizeRelative(root, path),
        );
        const rollback = yield* captureRollback(context, [root, ...paths], root);
        const execute = Effect.gen(function*() {
          const machine = yield* MachineState;
          const parentPaths = yield* rollbackPathSet(
            paths.map((path): MachinePath => ({
              platform: path.platform,
              absolute: path.platform === "windows"
                ? win32.dirname(path.absolute)
                : dirname(path.absolute),
            })),
            root,
          );
          const originalModes = (yield* Effect.forEach(
            parentPaths,
            (path) =>
              machine.inspectPath(path).pipe(
                Effect.flatMap((kind) =>
                  kind.kind === "directory"
                    ? machine.permissions(path).pipe(
                      Effect.map((permissions) => ({ path, mode: permissions.mode })),
                    )
                    : Effect.succeed(undefined)
                ),
                Effect.catchTag("MachineFilesystemError", (error) =>
                  /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message)
                    ? Effect.succeed(undefined)
                    : Effect.fail(error)
                ),
              ),
          )).filter((entry): entry is { readonly path: MachinePath; readonly mode: number } =>
            entry !== undefined
          );
          const changedModes: Array<{ readonly path: MachinePath; readonly mode: number }> = [];
          const removal = Effect.gen(function*() {
            for (const entry of [...deepestPathFirst(originalModes, (value) => value.path.absolute)].reverse()) {
              const writableMode = entry.mode | 0o700;
              if (writableMode === entry.mode) continue;
              yield* machine.setPermissions({ path: entry.path, mode: writableMode });
              changedModes.push(entry);
            }
            for (const path of deepestPathFirst(paths, (value) => value.absolute)) {
              yield* machine.mutateWithinRoot({
                root,
                path,
                mutation: { kind: "remove" },
              }).pipe(
                Effect.catchTag("MachineFilesystemError", (error) =>
                  error.message.includes("ENOENT") ? Effect.void : Effect.fail(error)
                ),
              );
            }
          });
          const removalResult = yield* Effect.result(removal);
          const restorationResult = yield* Effect.result(Effect.forEach(
            deepestPathFirst(changedModes, (entry) => entry.path.absolute),
            (entry) =>
              machine.setPermissions({ path: entry.path, mode: entry.mode }).pipe(
                Effect.catchTag("MachineFilesystemError", (error) =>
                  /\b(?:ENOENT|ENOTDIR)\b/u.test(error.message)
                    ? Effect.void
                    : Effect.fail(error)
                ),
              ),
            { discard: true },
          ));
          if (removalResult._tag === "Failure") {
            return yield* Effect.fail(removalResult.failure);
          }
          if (restorationResult._tag === "Failure") {
            return yield* Effect.fail(restorationResult.failure);
          }
        });
        return { rollbackReference: rollback.reference, execute, rollback: rollback.restore };
      }
      case "tool":
      case "credential":
        return yield* new InvalidExecutionPlanError({
          message: `resource ${context.resource.id} does not support automatic removal`,
        });
    }
  });

const installInvocation = (
  context: ResourceExecutionContext,
  method: string,
  packageName: string,
  version?: string | undefined,
  buildPolicy: BuildPolicy = { mode: "scripts-disabled" },
  source?: RecipeSource | undefined,
  indexPolicy?: RecipeIndexPolicy | undefined,
): Effect.Effect<
  void,
  MachineStateError | ActionExecutionError | InvalidExecutionPlanError,
  MachineState
> =>
  Effect.gen(function*() {
    if (method === "source") {
      return yield* new InvalidExecutionPlanError({
        message: `source recipe ${packageName} requires Human Action Required; no bounded source installer is available`,
      });
    }
    if (!Schema.is(AutomaticRecipeMethod)(method)) {
      return yield* new InvalidExecutionPlanError({
        message: `unknown installer method ${method}`,
      });
    }
    if (buildPolicy.mode === "required") {
      return yield* new InvalidExecutionPlanError({
        message:
          `recipe ${method}/${packageName} requires a bounded build policy; the process executor cannot confine lifecycle descendants`,
      });
    }
    if (
      method === "cargo"
      && buildPolicy.mode === "scripts-disabled"
    ) {
      return yield* new InvalidExecutionPlanError({
        message:
          `cargo recipe ${packageName} requires Human Action Required because Cargo has no disable-scripts mode`,
      });
    }
    if (
      version !== undefined
      && ![
        "npm",
        "pnpm",
        "bun",
        "brew",
        "homebrew",
        "winget",
        "uv",
        "cargo",
        "apt",
      ].includes(method)
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `installer ${method} cannot honor requested version ${version}`,
      });
    }
    if (
      packageName === "--"
      || /^\s*-{1,2}\S*/u.test(packageName)
      || /\s/u.test(packageName)
      || (
        method === "npm"
          ? parseNpmPackageSpecification(packageName).kind !== "registry"
          : isUnboundedNonNpmPackage(packageName)
      )
    ) {
      return yield* new InvalidExecutionPlanError({
        message: `ambiguous or source dependency ${packageName} requires a separately bounded execution plan`,
      });
    }
    const recipeError = recipeValidationError({
      method,
      package: packageName,
      version,
      source,
      indexPolicy,
    });
    if (
      recipeError !== undefined
      || isMissingAutomaticRecipeVersion({
        method,
        package: packageName,
        version,
        source,
      })
    ) {
      return yield* new InvalidExecutionPlanError({
        message: recipeError ?? `automatic installer ${method} requires an exact version`,
      });
    }
    const pythonIndex = method === "uv"
      ? canonicalRecipeIndexUrl(indexPolicy?.url ?? defaultPythonIndex)
      : undefined;
    if (method === "uv" && pythonIndex === undefined) {
      return yield* new InvalidExecutionPlanError({
        message: `uv recipe ${packageName} has an invalid reviewed Python index policy`,
      });
    }
    const npmFamily = method === "npm" || method === "pnpm" || method === "bun";
    const sourceDetailsValue = recipeSourceDetails(source);
    const effectiveVersion = version
      ?? (
        npmFamily && sourceDetailsValue.source !== undefined
          ? npmVersionFromTarballSource(packageName, sourceDetailsValue.source)
          : undefined
      );
    const sourceUrl = npmFamily
      && sourceDetailsValue.source !== undefined
      && sourceDetailsValue.source.startsWith("https://")
      ? sourceDetailsValue.source
      : undefined;
    const machine = yield* MachineState;
    let verifiedArtifactPath: string | undefined;
    if (sourceUrl !== undefined) {
      if (method === "bun") {
        return yield* new InvalidExecutionPlanError({
          message:
            "bun cannot guarantee an offline local tarball installation; Human Action Required",
        });
      }
      const integrity = sourceDetailsValue.integrity;
      if (integrity === undefined) {
        return yield* new InvalidExecutionPlanError({
          message:
            `reviewed ${method} package artifact ${sourceUrl} has no supported integrity; Human Action Required`,
        });
      }
      const directories = yield* machine.userDirectories();
      const cacheDirectory = join(
        directories.cache.absolute,
        "canonfig",
        "npm-artifacts",
      );
      const artifact = yield* (context.npmArtifactTransport ?? defaultNpmArtifactTransport)
        .download({
          source: sourceUrl,
          packageName,
          version: effectiveVersion!,
          integrity,
          cacheDirectory,
          maximumBytes: 32 * 1024 * 1024,
          timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
        }).pipe(
          Effect.mapError((error) =>
            new InvalidExecutionPlanError({
              message: `reviewed package artifact could not be verified: ${error.message}`,
            })
          ),
        );
      if (artifact.source !== sourceUrl || artifact.integrity !== integrity) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact metadata changed before installation",
        });
      }
      const artifactPath = yield* machine.normalizePath({ path: artifact.path });
      yield* machine.validatePathWithinRoot({
        root: directories.cache,
        path: artifactPath,
      });
      const symlinkTarget = yield* machine.readSymlink(artifactPath).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (symlinkTarget !== undefined) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact cache entry is a symlink",
        });
      }
      if (
        !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes <= 0
        || artifact.bytes > 32 * 1024 * 1024
      ) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact size is outside the execution bound",
        });
      }
      const bytes = yield* machine.readFile({
        path: artifactPath,
        maximumBytes: artifact.bytes,
      });
      if (bytes.byteLength !== artifact.bytes || !verifyNpmArtifactBytes(bytes, integrity)) {
        return yield* new InvalidExecutionPlanError({
          message: "verified npm artifact changed or is corrupt before installation",
        });
      }
      const provenanceError = validateNpmArtifactProvenance(
        bytes,
        packageName,
        effectiveVersion,
      );
      if (provenanceError !== undefined) {
        return yield* new InvalidExecutionPlanError({
          message: `verified npm artifact provenance is not safe: ${provenanceError}; Human Action Required`,
        });
      }
      verifiedArtifactPath = artifactPath.absolute;
    }
    const executableName = method === "apt"
      ? "apt-get"
      : method === "homebrew"
      ? "brew"
      : method;
    const executable = yield* machine.findExecutable({ name: executableName });
    const packageSpecifier = npmFamily && verifiedArtifactPath !== undefined
      ? verifiedArtifactPath
      : effectiveVersion === undefined
      ? packageName
      : `${packageName}@${effectiveVersion}`;
    const packageEnvironment = method === "uv"
      ? [
        { name: "UV_CONFIG_FILE", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "PIP_CONFIG_FILE", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "UV_DEFAULT_INDEX", value: pythonIndex! },
        { name: "UV_INDEX_URL", value: pythonIndex! },
        { name: "PIP_INDEX_URL", value: pythonIndex! },
      ]
      : method === "npm" || method === "pnpm" || method === "bun"
      ? [
        { name: "NPM_CONFIG_USERCONFIG", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "NPM_CONFIG_GLOBALCONFIG", value: process.platform === "win32" ? "NUL" : "/dev/null" },
        { name: "NPM_CONFIG_LOCATION", value: "global" },
        { name: "NPM_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
        ...(verifiedArtifactPath !== undefined
          ? [{ name: "NPM_CONFIG_OFFLINE", value: "true" }]
          : []),
        ...(method === "pnpm"
          ? [
            { name: "PNPM_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
            ...(verifiedArtifactPath !== undefined
              ? [{ name: "PNPM_CONFIG_OFFLINE", value: "true" }]
              : []),
          ]
          : []),
        ...(method === "bun"
          ? [
            { name: "BUN_CONFIG_FILE", value: process.platform === "win32" ? "NUL" : "/dev/null" },
            { name: "BUN_CONFIG_REGISTRY", value: "https://registry.npmjs.org/" },
          ]
          : []),
      ]
      : undefined;
    const arguments_ = method === "npm"
      ? [
        "install",
        "--global",
        packageSpecifier,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--ignore-scripts"] : []),
        ...(verifiedArtifactPath !== undefined ? ["--offline"] : []),
      ]
      : method === "pnpm" || method === "bun"
      ? [
        "add",
        "--global",
        packageSpecifier,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--ignore-scripts"] : []),
        ...(verifiedArtifactPath !== undefined ? ["--offline"] : []),
      ]
      : method === "brew" || method === "homebrew"
      ? ["install", version === undefined ? packageName : `${packageName}@${version}`]
      : method === "winget"
      ? version === undefined
        ? ["install", "--id", packageName, "--silent"]
        : ["install", "--id", packageName, "--version", version, "--exact", "--silent"]
      : method === "uv"
      ? [
        "tool",
        "install",
        version === undefined ? packageName : `${packageName}==${version}`,
        ...(buildPolicy.mode === "scripts-disabled" ? ["--only-binary=:all:"] : []),
        "--no-config",
        `--default-index=${pythonIndex!}`,
      ]
      : method === "apt"
      ? ["install", "-y", version === undefined ? packageName : `${packageName}=${version}`]
      : method === "cargo" && version !== undefined
      ? ["install", packageName, "--version", version, "--locked"]
      : ["install", packageName];
    const result = yield* machine.runProcess({
      executable: executable.path,
      arguments: arguments_,
      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
      maximumOutputBytes: context.limits.maximumProcessOutputBytes,
      environment: packageEnvironment,
      environmentUnset: method === "uv"
        ? [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "FTP_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "NETRC",
          "CURL_CA_BUNDLE",
          "REQUESTS_CA_BUNDLE",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "PYTHONHTTPSVERIFY",
          "PYTHON_KEYRING_BACKEND",
          "KEYRING_BACKEND",
        ]
        : undefined,
      environmentUnsetPrefixes: method === "uv"
        ? ["UV_", "PIP_"]
        : npmFamily
        ? ["NPM_CONFIG_", "PNPM_CONFIG_", "BUN_CONFIG_"]
        : undefined,
    });
    if (result.exitCode !== 0) {
      return yield* new ActionExecutionError({
        action: context.action.id,
        message: `installer ${method} exited with ${String(result.exitCode)}`,
      });
    }
  });

/** Prepare deterministic work. Preparation stores rollback material before owned-file mutation. */
export const prepareResourceAction = (
  context: ResourceExecutionContext,
): Effect.Effect<PreparedResourceAction, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const detail = context.action.detail;
  switch (detail.kind) {
    case "write-file":
      return prepareWrite(context, detail.target, detail.digest);
    case "write-config":
      return prepareConfig(context, detail.target, detail.keys, detail.removes);
    case "mirror-directory":
      return prepareMirror(context, detail.target, detail.adds, detail.removes);
    case "remove-resource":
      return prepareRemoval(context, detail);
    case "install-tool":
      return Effect.succeed({
        execute: installInvocation(
          context,
          detail.method,
          detail.package,
          detail.version,
          detail.buildPolicy,
          detail.source,
          detail.indexPolicy,
        ),
      });
    case "transfer-blob":
      return artifact(context.artifacts, detail.blob).pipe(
        Effect.flatMap((content) =>
          content.byteLength === detail.bytes
            ? Effect.succeed({ execute: Effect.void })
            : Effect.fail(new InvalidArtifactError({
              digest: detail.blob,
              message: `artifact size was ${content.byteLength}, expected ${detail.bytes}`,
            }))
        ),
      );
    case "no-op":
    case "verify-only":
      return Effect.succeed({ execute: Effect.void });
    case "human-action":
    case "agent-task":
    case "drift-conflict":
      return Effect.fail(new InvalidExecutionPlanError({
        message: `${detail.kind} is an outcome action, not executable work`,
      }));
  }
};

const verifyDigest = (
  target: string,
  desiredDigest: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: target });
    const kind = yield* machine.inspectPath(path);
    if (kind.kind !== "regular") {
      return {
        passed: false,
        method: `sha256:non-${kind.kind}`,
      };
    }
    const observed = yield* machine.digestFile({ path });
    return {
      passed: observed.value === desiredDigest,
      method: "sha256",
      observedDigest: observed.value,
    };
  });

export const verifyResource = (
  context: ResourceExecutionContext,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> => {
  const desired = context.desired;
  const verification = context.verification;
  if (verification.method === "command") {
    return verifyCommand(context, verification.command, verification.expectContains);
  }
  if (verification.method === "symlink") {
    return verifySymlink(context, verification.target);
  }
  if (verification.method === "executable-present") {
    return verifyExecutable(context, verification.executable);
  }
  if (verification.method === "credential-present") {
    return verifyCredential(context, verification.reference);
  }
  const declaredDigest = verification.digest;
  switch (desired.kind) {
    case "file":
      return Effect.gen(function*() {
        const digest = yield* (context.resource.policy === "append-local"
          ? verifyAppendLocal(context, declaredDigest)
          : verifyDigest(context.resource.target, declaredDigest));
        if (!digest.passed) return digest;
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({
          path: context.resource.target,
        });
        const permissions = yield* machine.permissions(path);
        const kind = yield* machine.inspectPath(path);
        if (kind.kind !== "regular") {
          return {
            ...digest,
            passed: false,
            method: `${digest.method}+non-${kind.kind}`,
          };
        }
        return {
          ...digest,
          passed: desired.mode === undefined
            ? permissions.executableByOwner === desired.executable
            : permissions.mode === desired.mode,
          method: `${digest.method}+permissions`,
        };
      });
    case "skill":
    case "directory":
      return directoryVerificationDigest(desired.files) === declaredDigest
        ? verifyDirectory(context, [
          ...desired.files,
          ...(desired.directories ?? []).map((directory) => ({
            ...directory,
            digest: sha256Hex("canonfig:directory"),
            objectKind: "directory" as const,
          })),
        ])
        : Effect.succeed({
          passed: false,
          method: "declared-directory-digest",
        });
    case "config":
      return desired.digest === declaredDigest
        ? verifyConfig(context, desired.digest, desired.keys)
        : Effect.succeed({
          passed: false,
          method: "declared-config-digest",
        });
    case "tool":
    case "credential":
      return Effect.fail(new InvalidExecutionPlanError({
        message: `resource ${context.resource.id} has incompatible digest verification`,
      }));
  }
};

const verifyAppendLocal = (context: ResourceExecutionContext, declaredDigest: string) =>
  Effect.gen(function*() {
    const path = yield* targetPath(context.resource.target);
    yield* inspectTextTarget(path);
    const machine = yield* MachineState;
    const bytes = yield* machine.readFile({ path, maximumBytes: context.limits.maximumFileBytes });
    const composition = yield* Effect.try({
      try: () => parseTextComposition(bytes),
      catch: (error) => new InvalidExecutionPlanError({ message: `cannot verify Source text: ${String(error)}` }),
    });
    const observedDigest = composition.kind === "managed" ? sha256Hex(composition.source) : undefined;
    return { passed: observedDigest === declaredDigest, method: "sha256-source", observedDigest };
  });

const verifyCommand = (
  context: ResourceExecutionContext,
  command: ReadonlyArray<string>,
  expectContains?: string,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const [name, ...arguments_] = command;
    if (name === undefined) {
      return yield* new InvalidExecutionPlanError({
        message: `resource ${context.resource.id} has an empty verification command`,
      });
    }
    const machine = yield* MachineState;
    const executable = isAbsolute(name) || win32.isAbsolute(name)
      ? {
        name,
        path: yield* machine.normalizePath({ path: name }),
      }
      : yield* machine.findExecutable({ name });
    const result = yield* machine.runProcess({
      executable: executable.path,
      arguments: arguments_,
      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,
      maximumOutputBytes: context.limits.maximumProcessOutputBytes,
    });
    const output = `${decoder.decode(result.standardOutput)}${decoder.decode(result.standardError)}`;
    return {
      passed: result.exitCode === 0
        && (expectContains === undefined || output.includes(expectContains)),
      method: `command:${name}`,
      exitCode: result.exitCode ?? undefined,
    };
  });

const verifyExecutable = (
  context: ResourceExecutionContext,
  executable: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const method = `executable:${executable}`;
    // A verification that names a path is checked by inspecting that path,
    // which is what observation already does. findExecutable searches PATH and
    // refuses any name containing a separator, so sending a path through it
    // could never pass: observation reported the tool present, the planner
    // planned a no-op, and the no-op then failed the whole run.
    if (executable.includes("/") || executable.includes("\\")) {
      return yield* machine.normalizePath({ path: executable }).pipe(
        Effect.flatMap((path) => machine.permissions(path)),
        Effect.map((permissions) => ({
          passed: (permissions.mode & 0o111) !== 0,
          method,
        })),
        Effect.catch(() => Effect.succeed({ passed: false, method })),
      );
    }
    return yield* machine.findExecutable({ name: executable }).pipe(
      Effect.as({ passed: true, method }),
      Effect.catch(() => Effect.succeed({ passed: false, method })),
    );
  });

const verifyCredential = (
  context: ResourceExecutionContext,
  referenceValue: string,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const reference = yield* Schema.decodeUnknownEffect(CredentialReference)(
      referenceValue,
    ).pipe(
      Effect.mapError((error) =>
        new InvalidExecutionPlanError({ message: String(error) })
      ),
    );
    const machine = yield* MachineState;
    return yield* machine.loadCredential({ reference }).pipe(
      Effect.as({ passed: true, method: `credential:${referenceValue}` }),
      Effect.catch(() =>
        Effect.succeed({ passed: false, method: `credential:${referenceValue}` })
      ),
    );
  });

const verifySymlink = (
  context: ResourceExecutionContext,
  target: string,
): Effect.Effect<ResourceVerification, MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: context.resource.target });
    return yield* machine.readSymlink(path).pipe(
      Effect.map((observed) => ({
        passed: observed === target,
        method: "symlink-target",
      })),
      Effect.catch(() =>
        Effect.succeed({ passed: false, method: "symlink-target" })
      ),
    );
  });

const verifyDirectory = (
  context: ResourceExecutionContext,
  files: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly mode: number;
    readonly objectKind?: "directory" | undefined;
    readonly symlinkTo?: string | undefined;
  }>,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const root = yield* targetPath(context.resource.target);
    const machine = yield* MachineState;
    const rootKind = yield* machine.inspectPath(root).pipe(
      Effect.catchTag("MachineFilesystemError", (error) =>
        error.message.includes("ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      ),
    );
    if (rootKind === undefined) {
      return { passed: false, method: "directory-root-missing" };
    }
    if (rootKind.kind !== "directory") {
      return {
        passed: false,
        method: `directory-root-non-${rootKind.kind}`,
      };
    }
    if (context.desired.kind === "directory" || context.desired.kind === "skill") {
      const rootPermissions = yield* machine.permissions(root);
      if (rootPermissions.mode !== (context.desired.mode ?? 0o700)) {
        return { passed: false, method: "directory-root-permissions" };
      }
    }
    const observations = yield* Effect.forEach(files, (file) =>
      Effect.gen(function*() {
      const path = yield* normalizeRelative(root, file.path);
      const kind = yield* machine.inspectPath(path);
      if (file.objectKind === "directory") {
        if (kind.kind !== "directory") {
          return { expected: file.digest, observed: undefined, mode: -1, expectedMode: file.mode };
        }
        const permissions = yield* machine.permissions(path);
        return { expected: file.digest, observed: file.digest, mode: permissions.mode, expectedMode: file.mode };
      }
      if (file.symlinkTo !== undefined) {
        const target = kind.kind === "symlink"
          ? yield* machine.readSymlink(path)
          : undefined;
        return {
          expected: file.digest,
          observed: target === file.symlinkTo ? file.digest : undefined,
          mode: file.mode,
          expectedMode: file.mode,
        };
      }
      if (kind.kind !== "regular") {
        return {
          expected: file.digest,
          observed: undefined,
          mode: -1,
          expectedMode: file.mode,
        };
      }
      const observed = yield* machine.digestFile({ path });
      const permissions = yield* machine.permissions(path);
      const finalKind = yield* machine.inspectPath(path);
        return {
          expected: file.digest,
          observed: finalKind.kind === "regular" ? observed.value : undefined,
          mode: permissions.mode,
          expectedMode: file.mode,
        };
      }), {
      concurrency: context.limits.verificationConcurrency,
    });
    const mismatch = observations.find((observation) =>
      observation.observed !== observation.expected
      || observation.mode !== observation.expectedMode
    );
    if (mismatch !== undefined) {
      return {
        passed: false,
        method: "directory-sha256",
        observedDigest: mismatch.observed,
      };
    }
    return { passed: true, method: "directory-sha256" };
  });

const verifyConfig = (
  context: ResourceExecutionContext,
  digest: string,
  keys: ReadonlyArray<string>,
): Effect.Effect<ResourceVerification, SynchronizationExecutionInputError | MachineStateError, MachineState> =>
  Effect.gen(function*() {
    const desiredBytes = yield* artifact(context.artifacts, digest);
    if (context.desired.kind !== "config") {
      return yield* new InvalidExecutionPlanError({
        message: `config verification targets non-config ${context.resource.id}`,
      });
    }
    const desired = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          context.desired.kind === "config" ? context.desired.format : "json",
          decoder.decode(desiredBytes),
        ),
      catch: (error) =>
        new InvalidArtifactError({ digest, message: String(error) }),
    });
    const machine = yield* MachineState;
    const path = yield* machine.normalizePath({ path: context.resource.target });
    const observedBytes = yield* machine.readFile({
      path,
      maximumBytes: context.limits.maximumFileBytes,
    });
    const observed = yield* Effect.try({
      try: () =>
        parseConfigDocument(
          context.desired.kind === "config" ? context.desired.format : "json",
          decoder.decode(observedBytes),
        ),
      catch: (error) =>
        new InvalidExecutionPlanError({
          message: `cannot verify non-object config ${context.resource.target}: ${String(error)}`,
        }),
    });
    const passed = keys.every((key) =>
      JSON.stringify(getConfigPath(observed, key))
        === JSON.stringify(getConfigPath(desired, key))
    );
    return { passed, method: "config-keys" };
  });
