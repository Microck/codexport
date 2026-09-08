import { type Effect, type Redacted, Schema } from "effect";

import type {
  ContentDigest,
  CredentialReference,
} from "../domain/brand.ts";
import type { MachineStateError } from "./machine-state.errors.ts";

export type MachinePlatform = "linux" | "macos" | "windows";

export interface MachinePath {
  readonly platform: MachinePlatform;
  readonly absolute: string;
}

export interface NormalizePathInput {
  readonly path: string;
  readonly base?: MachinePath | undefined;
}

export interface UserDirectories {
  readonly home: MachinePath;
  readonly config: MachinePath;
  readonly data: MachinePath;
  readonly cache: MachinePath;
}

export interface EnsureDirectoryInput {
  readonly path: MachinePath;
  readonly mode?: number | undefined;
}

/** A file source is copied with bounded memory and verified before replacement. */
export type FileContent = Uint8Array | {
  readonly file: string;
  readonly digest: ContentDigest;
};

/** Persisted rollback permissions, distinct from the desired portable mode. */
export const FilePermissionSnapshot = Schema.Union([
  Schema.Struct({ platform: Schema.Literal("posix"), mode: Schema.Int }),
  Schema.Struct({
    platform: Schema.Literal("windows"),
    mode: Schema.Int,
    /** Owner, group and DACL, including inheritance flags. Audit rules are not captured. */
    securityDescriptor: Schema.NonEmptyString,
  }),
]);
export type FilePermissionSnapshot = typeof FilePermissionSnapshot.Type;

/** A managed mode and a captured rollback snapshot are mutually exclusive. */
export type FilePermissionPolicy =
  | { readonly mode?: number | undefined; readonly permissions?: never }
  | { readonly mode?: never; readonly permissions: FilePermissionSnapshot };

export type AtomicWriteInput = {
  readonly path: MachinePath;
  readonly content: FileContent;
} & FilePermissionPolicy;

export interface ReadFileInput {
  readonly path: MachinePath;
  readonly maximumBytes: number;
}

export interface RemoveFileInput {
  readonly path: MachinePath;
}

export interface RemoveEmptyDirectoryInput {
  readonly path: MachinePath;
}

export interface ValidatePathWithinRootInput {
  readonly root: MachinePath;
  readonly path: MachinePath;
}

export type SafeRootMutation =
  | ({
    readonly kind: "write";
    readonly content: FileContent;
  } & FilePermissionPolicy)
  | { readonly kind: "remove" }
  | {
    readonly kind: "symlink";
    /** Preserve the authored link text so relative targets stay relative. */
    readonly target: string;
  }
  | ({
    readonly kind: "directory";
  } & (
    | { readonly mode: number; readonly permissions?: never }
    | { readonly mode?: never; readonly permissions: FilePermissionSnapshot }
  ));

export interface SafeRootMutationInput {
  readonly root: MachinePath;
  readonly path: MachinePath;
  readonly mutation: SafeRootMutation;
}

export interface SymlinkInput {
  readonly path: MachinePath;
  /** Preserve the authored link text so relative targets stay relative. */
  readonly target: string;
}

export interface FilePermissions {
  readonly mode: number;
  readonly executableByOwner: boolean;
}

/** The object at a path, observed without following its final component. */
export type MachineObjectKind =
  | "regular"
  | "directory"
  | "symlink"
  | "reparse-point"
  | "special";

export interface MachineObject {
  readonly kind: MachineObjectKind;
}

/** One entry found by listing a managed directory, relative to its root. */
export interface MachineDirectoryEntry {
  /** Path relative to the listed root, using forward slashes. */
  readonly path: string;
  readonly kind: MachineObjectKind;
}

export type SetPermissionsInput = {
  readonly path: MachinePath;
} & (
  | { readonly mode: number; readonly permissions?: never }
  | { readonly mode?: never; readonly permissions: FilePermissionSnapshot }
);

export interface ExecutableQuery {
  readonly name: string;
  readonly searchPath?: ReadonlyArray<MachinePath> | undefined;
}

export interface DiscoveredExecutable {
  readonly name: string;
  readonly path: MachinePath;
}

export interface ProcessEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export interface ProcessInvocation {
  readonly executable: MachinePath;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory?: MachinePath | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly environmentUnset?: ReadonlyArray<string> | undefined;
  readonly environmentUnsetPrefixes?: ReadonlyArray<string> | undefined;
  /** Optional bounded bytes written to the child process before stdin is closed. */
  readonly standardInput?: Uint8Array | undefined;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly standardOutput: Uint8Array;
  readonly standardError: Uint8Array;
}

export interface DigestFileInput {
  readonly path: MachinePath;
  readonly maximumBytes?: number | undefined;
}

export type CredentialStorageCapability =
  | {
    readonly kind: "secure-noninteractive";
    readonly provider: "secret-service" | "keychain" | "credential-manager";
  }
  | {
    readonly kind: "local-file";
    readonly path: MachinePath;
  }
  | {
    readonly kind: "unavailable";
    readonly recovery: string;
  };

export type CredentialPolicy =
  | { readonly kind: "secure-store" }
  | { readonly kind: "local-file"; readonly path: string };

export interface StoreCredentialInput {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export interface LoadCredentialInput {
  readonly reference: CredentialReference;
}

export type SchedulerCalendar =
  | {
    readonly kind: "daily";
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "weekly";
    readonly weekdays: ReadonlyArray<
      "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun"
    >;
    readonly localTime: string;
    readonly timezone?: string | undefined;
  }
  | {
    readonly kind: "systemd-on-calendar";
    readonly expression: string;
    readonly timezone?: string | undefined;
  };

export interface SchedulerJob {
  readonly name: string;
  readonly description: string;
  readonly executable: MachinePath;
  readonly arguments: ReadonlyArray<string>;
  readonly calendar: SchedulerCalendar;
}

export interface RenderedSchedulerJob {
  readonly platform: MachinePlatform;
  readonly mechanism: "systemd-user-timer" | "launchd-user-agent" | "task-scheduler";
  readonly serviceName: string;
  readonly service: string;
  readonly schedule: string;
}

export interface SchedulerInspection {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly matches: boolean;
}

/**
 * Exact native scheduler material captured before a managed mutation.
 *
 * `servicePresent` and `schedulePresent` distinguish a partial native
 * installation from an absent job. Platform adapters may additionally store
 * opaque native state when rendered service/schedule strings are insufficient
 * to restore the job.
 */
export type SchedulerSnapshot =
  | {
    readonly state: "absent";
    readonly platform: MachinePlatform;
    readonly mechanism: RenderedSchedulerJob["mechanism"];
    readonly serviceName: string;
  }
  | {
    readonly state: "present";
    readonly platform: MachinePlatform;
    readonly mechanism: RenderedSchedulerJob["mechanism"];
    readonly serviceName: string;
    readonly enabled: boolean;
    readonly active?: boolean | undefined;
    readonly servicePresent: boolean;
    readonly schedulePresent: boolean;
    readonly service?: string | undefined;
    readonly schedule?: string | undefined;
    readonly serviceMode?: number | undefined;
    readonly scheduleMode?: number | undefined;
    readonly native?: string | undefined;
  };

export interface SchedulerBackend {
  readonly inspect: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerInspection, MachineStateError>;
  readonly snapshot: (
    expected: RenderedSchedulerJob,
  ) => Effect.Effect<SchedulerSnapshot, MachineStateError>;
  readonly install: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly remove: (
    definition: RenderedSchedulerJob,
  ) => Effect.Effect<void, MachineStateError>;
  readonly restore: (
    expected: RenderedSchedulerJob,
    snapshot: SchedulerSnapshot,
  ) => Effect.Effect<void, MachineStateError>;
}

export interface LinuxMachineStateOptions {
  readonly credentialPolicy?: CredentialPolicy | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly schedulerBackend?: SchedulerBackend | undefined;
  /** Test seam invoked after the managed root is opened but before traversal. */
  readonly beforeSafeRootMutation?: (() => Promise<void>) | undefined;
  /** Selects the descriptor-relative or rename-isolated safe-root implementation. */
  readonly safeRootMutationStrategy?: "descriptor" | "portable" | undefined;
}

export interface FileDigest {
  readonly algorithm: "sha256";
  readonly value: ContentDigest;
}
