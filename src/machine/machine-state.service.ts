import { Context, type Effect, type Redacted } from "effect";

import type {
  CredentialReference,
} from "../domain/brand.ts";
import type { MachineStateError } from "./machine-state.errors.ts";
import type {
  AtomicWriteInput,
  CredentialStorageCapability,
  DigestFileInput,
  DiscoveredExecutable,
  EnsureDirectoryInput,
  ExecutableQuery,
  FileDigest,
  FilePermissions,
  LoadCredentialInput,
  MachinePath,
  MachineDirectoryEntry,
  MachineObject,
  NormalizePathInput,
  ProcessInvocation,
  ProcessResult,
  ReadFileInput,
  RemoveEmptyDirectoryInput,
  RemoveFileInput,
  RenderedSchedulerJob,
  SafeRootMutationInput,
  SchedulerInspection,
  SchedulerJob,
  SetPermissionsInput,
  SchedulerSnapshot,
  StoreCredentialInput,
  SymlinkInput,
  UserDirectories,
  ValidatePathWithinRootInput,
} from "./machine-state.types.ts";

export class MachineState extends Context.Service<MachineState, {
  readonly normalizePath: (
    input: NormalizePathInput,
  ) => Effect.Effect<MachinePath, MachineStateError>;
  readonly userDirectories: () => Effect.Effect<UserDirectories, MachineStateError>;
  readonly ensureDirectory: (
    input: EnsureDirectoryInput,
  ) => Effect.Effect<void, MachineStateError>;
  /** Protect content before writing; preserve existing parent and sibling permissions. */
  readonly atomicWrite: (
    input: AtomicWriteInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly readFile: (
    input: ReadFileInput,
  ) => Effect.Effect<Uint8Array, MachineStateError>;
  readonly removeFile: (
    input: RemoveFileInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly removeEmptyDirectory: (
    input: RemoveEmptyDirectoryInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly validatePathWithinRoot: (
    input: ValidatePathWithinRootInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly mutateWithinRoot: (
    input: SafeRootMutationInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly replaceSymlink: (
    input: SymlinkInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly readSymlink: (
    path: MachinePath,
  ) => Effect.Effect<string, MachineStateError>;
  /** Inspect the final path component without following symlinks or reparse points. */
  readonly inspectPath: (
    path: MachinePath,
  ) => Effect.Effect<MachineObject, MachineStateError>;
  /**
   * Every entry beneath a managed directory, deepest last, without following
   * symlinks out of it.
   *
   * Observation otherwise inspects only owned and desired paths, so a file the
   * operator added is never seen. `replace` needs to see it to remove it, or
   * it is indistinguishable from `mirror-owned`.
   */
  readonly listDirectory: (
    path: MachinePath,
  ) => Effect.Effect<ReadonlyArray<MachineDirectoryEntry>, MachineStateError>;
  readonly setPermissions: (
    input: SetPermissionsInput,
  ) => Effect.Effect<void, MachineStateError>;
  readonly permissions: (
    path: MachinePath,
  ) => Effect.Effect<FilePermissions, MachineStateError>;
  readonly findExecutable: (
    query: ExecutableQuery,
  ) => Effect.Effect<DiscoveredExecutable, MachineStateError>;
  readonly runProcess: (
    invocation: ProcessInvocation,
  ) => Effect.Effect<ProcessResult, MachineStateError>;
  readonly digestFile: (
    input: DigestFileInput,
  ) => Effect.Effect<FileDigest, MachineStateError>;
  readonly credentialCapability: (
  ) => Effect.Effect<CredentialStorageCapability, MachineStateError>;
  /** Local-file storage owns and restricts its credential directory before writing. */
  readonly storeCredential: (
    input: StoreCredentialInput,
  ) => Effect.Effect<CredentialReference, MachineStateError>;
  readonly loadCredential: (
    input: LoadCredentialInput,
  ) => Effect.Effect<Redacted.Redacted<string>, MachineStateError>;
  readonly removeCredential: (
    reference: CredentialReference,
  ) => Effect.Effect<void, MachineStateError>;
  readonly renderSchedulerJob: (
    job: SchedulerJob,
  ) => Effect.Effect<RenderedSchedulerJob, MachineStateError>;
  readonly inspectSchedulerJob: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerInspection, MachineStateError>;
  readonly installSchedulerJob: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly removeSchedulerJob: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly snapshotSchedulerJob: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerSnapshot, MachineStateError>;
  readonly restoreSchedulerJob: (
    expected: RenderedSchedulerJob,
    snapshot: SchedulerSnapshot,
  ) => Effect.Effect<void, MachineStateError>;
}>()("canonfig/machine/MachineState") {}
