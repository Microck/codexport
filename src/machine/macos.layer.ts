import { createHash } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import {
  CredentialReference,
  type CredentialReference as CredentialReferenceType,
} from "../domain/brand.ts";
import {
  CredentialStorageError,
  HumanActionRequiredError,
  InvalidMachinePathError,
  InvalidSchedulerJobError,
  MachineFilesystemError,
  type MachineStateError,
} from "./machine-state.errors.ts";
import { MachineState } from "./machine-state.service.ts";
import { linuxMachineStateLayer } from "./linux.layer.ts";
import type {
  CredentialPolicy,
  CredentialStorageCapability,
  MachinePath,
  NormalizePathInput,
  ProcessEnvironmentEntry,
  ProcessResult,
  RenderedSchedulerJob,
  RemoveEmptyDirectoryInput,
  SchedulerBackend,
  SchedulerCalendar,
  SchedulerJob,
  SchedulerSnapshot,
} from "./machine-state.types.ts";

export interface MacosMachineStateOptions {
  readonly credentialPolicy?: CredentialPolicy | undefined;
  readonly credentialStoreAccess?: "auto" | "unavailable" | undefined;
  readonly environment?: ReadonlyArray<ProcessEnvironmentEntry> | undefined;
  readonly schedulerBackend?: SchedulerBackend | undefined;
  /** Test seam invoked after the managed root is opened but before traversal. */
  readonly beforeSafeRootMutation?: (() => Promise<void>) | undefined;
  /** Test seam for launchd command results. */
  readonly launchctlRunner?: ((
    arguments_: ReadonlyArray<string>,
  ) => Effect.Effect<ProcessResult, MachineStateError>) | undefined;
}

const decode = Schema.decodeUnknownSync;

const environmentEntries = (): ReadonlyArray<ProcessEnvironmentEntry> =>
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }]
  );

const environmentValue = (
  environment: ReadonlyArray<ProcessEnvironmentEntry>,
  name: string,
): string | undefined => environment.find((entry) => entry.name === name)?.value;

const macosPath = (absolute: string): MachinePath => ({
  platform: "macos",
  absolute: normalize(absolute),
});

const linuxPath = (path: MachinePath): MachinePath => ({
  platform: "linux",
  absolute: path.absolute,
});

const requireMacosPath = (
  path: MachinePath,
): Effect.Effect<MachinePath, InvalidMachinePathError> =>
  path.platform === "macos"
    ? Effect.succeed(linuxPath(path))
    : Effect.fail(new InvalidMachinePathError({
      path: path.absolute,
      message: `expected a macOS path, received ${path.platform}`,
    }));

const normalizedPath = (
  input: NormalizePathInput,
  home: string,
): Effect.Effect<MachinePath, InvalidMachinePathError> => {
  if (input.path.length === 0 || input.path.includes("\0")) {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: "path must not be empty or contain NUL bytes",
    }));
  }
  if (input.base !== undefined && input.base.platform !== "macos") {
    return Effect.fail(new InvalidMachinePathError({
      path: input.path,
      message: `relative macOS paths cannot use a ${input.base.platform} base`,
    }));
  }
  const expanded = input.path === "~"
    ? home
    : input.path.startsWith("~/")
    ? join(home, input.path.slice(2))
    : input.path;
  return Effect.succeed(macosPath(resolve(input.base?.absolute ?? process.cwd(), expanded)));
};

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");

const validateSingleLine = (
  value: string,
  field: string,
): Effect.Effect<string, InvalidSchedulerJobError> =>
  value.trim().length > 0 && !/[\n\r\0]/u.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new InvalidSchedulerJobError({
      field,
      message: `${field} must be non-empty, single-line, and contain no NUL bytes`,
    }));

const launchdCalendar = (
  calendar: SchedulerCalendar,
): Effect.Effect<string, InvalidSchedulerJobError> => {
  if (calendar.kind === "systemd-on-calendar") {
    return Effect.fail(new InvalidSchedulerJobError({
      field: "calendar.kind",
      message: "systemd calendar expressions are not supported by launchd",
    }));
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(calendar.localTime)) {
    return Effect.fail(new InvalidSchedulerJobError({
      field: "calendar.localTime",
      message: "local time must use 24-hour HH:mm format",
    }));
  }
  const [hour, minute] = calendar.localTime.split(":");
  const weekdays = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  } as const;
  const intervals = calendar.kind === "daily"
    ? [undefined]
    : calendar.weekdays.map((weekday) => weekdays[weekday]);
  const rendered = intervals.map((weekday) =>
    `<dict><key>Hour</key><integer>${Number(hour)}</integer>`
      + `<key>Minute</key><integer>${Number(minute)}</integer>`
      + (weekday === undefined ? "" : `<key>Weekday</key><integer>${weekday}</integer>`)
      + "</dict>"
  );
  return Effect.succeed(rendered.length === 1
    ? rendered[0]!
    : `<array>${rendered.join("")}</array>`);
};

const renderLaunchdJob = (
  job: SchedulerJob,
): Effect.Effect<RenderedSchedulerJob, MachineStateError> =>
  Effect.gen(function*() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(job.name)) {
      return yield* new InvalidSchedulerJobError({
        field: "name",
        message: "job name must be a portable launchd label suffix",
      });
    }
    yield* validateSingleLine(job.description, "description");
    const executable = yield* requireMacosPath(job.executable);
    const arguments_ = yield* Effect.forEach(
      job.arguments,
      (argument, index) => validateSingleLine(argument, `arguments[${index}]`),
    );
    const calendar = yield* launchdCalendar(job.calendar);
    const label = `dev.canonfig.${job.name}`;
    const programArguments = [executable.absolute, ...arguments_]
      .map((argument) => `<string>${xml(argument)}</string>`)
      .join("");
    const definition = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
        + "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      `<key>Label</key><string>${xml(label)}</string>`,
      `<key>ProgramArguments</key><array>${programArguments}</array>`,
      "<key>ProcessType</key><string>Background</string>",
      `<key>StartCalendarInterval</key>${calendar}`,
      "</dict></plist>",
      "",
    ].join("\n");
    return {
      platform: "macos",
      mechanism: "launchd-user-agent",
      serviceName: `${label}.plist`,
      service: definition,
      schedule: definition,
    };
  });

const keychainKey = (
  reference: CredentialReferenceType,
): Effect.Effect<string, CredentialStorageError> => {
  const prefix = "keychain:";
  const value = String(reference);
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    return Effect.fail(new CredentialStorageError({
      operation: "resolve credential reference",
      reference: value,
      message: "credential reference is not owned by macOS Keychain",
    }));
  }
  return Effect.succeed(value.slice(prefix.length));
};

export const macosMachineStateLayer = (
  options: MacosMachineStateOptions = {},
): Layer.Layer<MachineState> => {
  const environment = options.environment ?? environmentEntries();
  const home = environmentValue(environment, "HOME") ?? homedir();
  const policy = options.credentialPolicy ?? { kind: "secure-store" };
  const security = "/usr/bin/security";
  const base = linuxMachineStateLayer({
    credentialPolicy: policy,
    environment,
    beforeSafeRootMutation: options.beforeSafeRootMutation,
    safeRootMutationStrategy: "portable",
  });

  return Layer.effect(
    MachineState,
    Effect.gen(function*() {
      const machine = yield* MachineState;
      const secureStoreAvailable = Effect.promise(() =>
        options.credentialStoreAccess !== "unavailable"
          && process.platform === "darwin"
          ? access(security).then(() => true).catch(() => false)
          : Promise.resolve(false)
      );
      const requireSecurity = Effect.gen(function*() {
        if (yield* secureStoreAvailable) return security;
        return yield* new HumanActionRequiredError({
          action: "configure macOS credential storage",
          recovery:
            "Run on macOS with an unlocked login Keychain, or explicitly select the local-file credential policy.",
        });
      });
      const runSecurity = (
        arguments_: ReadonlyArray<string>,
      ) => machine.runProcess({
        executable: { platform: "linux", absolute: security },
        arguments: arguments_,
        timeoutMilliseconds: 5_000,
        maximumOutputBytes: 1024 * 1024,
      });
      const launchAgents = join(home, "Library", "LaunchAgents");
      const launchctl = "/bin/launchctl";
      const launchDomain = `gui/${process.getuid?.() ?? 0}`;
      const runLaunchctl = options.launchctlRunner
        ?? ((arguments_: ReadonlyArray<string>) =>
          machine.runProcess({
            executable: { platform: "linux", absolute: launchctl },
            arguments: arguments_,
            timeoutMilliseconds: 10_000,
            maximumOutputBytes: 1024 * 1024,
          }));
      /**
       * Whether the current process is one launchd started from this agent.
       *
       * `launchctl bootout` stops the service's processes, so booting out the
       * agent that owns the running process kills it: a scheduled run that
       * needed to change its own calendar would end Interrupted and block
       * later fires. launchd sets XPC_SERVICE_NAME to the service label for
       * the processes it starts, which is how the case is recognized.
       */
      const runsUnderAgent = (serviceName: string): boolean => {
        const label = serviceName.endsWith(".plist")
          ? serviceName.slice(0, -".plist".length)
          : serviceName;
        return environmentValue(environment, "XPC_SERVICE_NAME") === label;
      };

      const queryLaunchctlActive = (
        label: string,
        action: string,
        recovery: string,
      ): Effect.Effect<boolean, MachineStateError> =>
        runLaunchctl(["print", `${launchDomain}/${label}`]).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(true);
            const output = Buffer.concat([
              Buffer.from(result.standardOutput),
              Buffer.from(result.standardError),
            ]).toString("utf8");
            if (/could not find service/iu.test(output)) return Effect.succeed(false);
            return Effect.fail(new HumanActionRequiredError({ action, recovery }));
          }),
        );
      const nativeScheduler: SchedulerBackend = {
        inspect: (expected) => {
          const path = join(launchAgents, expected.serviceName);
          return Effect.gen(function*() {
            const stored = yield* Effect.tryPromise({
              try: () =>
                readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) =>
                  cause.code === "ENOENT" ? undefined : Promise.reject(cause)
                ),
              catch: (cause) =>
                new MachineFilesystemError({
                  operation: "inspect launchd user agent",
                  path,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            });
            if (stored === undefined) {
              return { installed: false, enabled: false, matches: false };
            }
            const label = expected.serviceName.slice(0, -".plist".length);
            const active = yield* queryLaunchctlActive(
              label,
              "inspect the Canonfig launchd agent",
              "launchd inspection failed; sign in to the macOS graphical user session and retry.",
            );
            return {
              installed: true,
              enabled: active,
              matches: stored === expected.schedule,
            };
          });
        },
        snapshot: (expected) => {
          const path = join(launchAgents, expected.serviceName);
          return Effect.gen(function*() {
            const stored = yield* Effect.tryPromise({
              try: () =>
                readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) =>
                  cause.code === "ENOENT" ? undefined : Promise.reject(cause)
                ),
              catch: (cause) =>
                new MachineFilesystemError({
                  operation: "snapshot launchd user agent",
                  path,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            });
            if (stored === undefined) {
              return {
                state: "absent",
                platform: expected.platform,
                mechanism: expected.mechanism,
                serviceName: expected.serviceName,
              } satisfies SchedulerSnapshot;
            }
            const metadata = yield* Effect.tryPromise({
              try: () => lstat(path),
              catch: (cause) =>
                new MachineFilesystemError({
                  operation: "snapshot launchd user agent",
                  path,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            });
            const label = expected.serviceName.slice(0, -".plist".length);
            const active = yield* queryLaunchctlActive(
              label,
              "capture the Canonfig launchd agent",
              "launchd snapshot inspection failed; sign in to the macOS graphical user session and retry.",
            );
            return {
              state: "present",
              platform: expected.platform,
              mechanism: expected.mechanism,
              serviceName: expected.serviceName,
              enabled: active,
              active,
              servicePresent: true,
              schedulePresent: true,
              service: stored,
              schedule: stored,
              serviceMode: metadata.mode & 0o777,
              scheduleMode: metadata.mode & 0o777,
            } satisfies SchedulerSnapshot;
          });
        },
        install: (definition) => {
          const path = join(launchAgents, definition.serviceName);
          return Effect.gen(function*() {
            yield* machine.atomicWrite({
              path: linuxPath({ platform: "macos", absolute: path }),
              content: new TextEncoder().encode(definition.schedule),
              mode: 0o600,
            });
            // Never bootout the agent running this process. The written plist
            // is the new definition, and launchd loads it on the next login,
            // which is strictly better than killing the run doing the update.
            if (runsUnderAgent(definition.serviceName)) return;
            yield* runLaunchctl(["bootout", launchDomain, path]).pipe(Effect.ignore);
            const result = yield* runLaunchctl(["bootstrap", launchDomain, path]);
            if (result.exitCode !== 0) {
              return yield* new HumanActionRequiredError({
                action: "load the Canonfig launchd agent",
                recovery:
                  "Sign in to the macOS graphical user session and ensure launchd user agents are available, then retry.",
              });
            }
          });
        },
        remove: (definition) => {
          const path = join(launchAgents, definition.serviceName);
          return Effect.gen(function*() {
            // Removing the plist is enough when this process is the agent's
            // own: booting it out would kill the process doing the removal.
            if (!runsUnderAgent(definition.serviceName)) {
              yield* runLaunchctl(["bootout", launchDomain, path]).pipe(Effect.ignore);
            }
            yield* machine.removeFile({
              path: linuxPath({ platform: "macos", absolute: path }),
            });
          });
        },
        restore: (expected, snapshot) => {
          const path = join(launchAgents, expected.serviceName);
          return Effect.gen(function*() {
            yield* runLaunchctl(["bootout", launchDomain, path]).pipe(Effect.ignore);
            if (snapshot.state === "absent") {
              yield* machine.removeFile({
                path: linuxPath({ platform: "macos", absolute: path }),
              });
              return;
            }
            if (
              !snapshot.servicePresent
              || !snapshot.schedulePresent
              || snapshot.service === undefined
            ) {
              return yield* new HumanActionRequiredError({
                action: "restore the Canonfig launchd agent",
                recovery: "The captured launchd plist was incomplete; inspect the user agent manually.",
              });
            }
            yield* machine.atomicWrite({
              path: linuxPath({ platform: "macos", absolute: path }),
              content: new TextEncoder().encode(snapshot.service),
              mode: snapshot.serviceMode ?? 0o600,
            });
            if (snapshot.enabled) {
              const result = yield* runLaunchctl(["bootstrap", launchDomain, path]);
              if (result.exitCode !== 0) {
                return yield* new HumanActionRequiredError({
                  action: "load the restored Canonfig launchd agent",
                  recovery:
                    "Sign in to the macOS graphical user session and ensure launchd user agents are available, then retry.",
                });
              }
            }
          });
        },
      };
      const scheduler = options.schedulerBackend ?? nativeScheduler;

      return MachineState.of({
        normalizePath: (input) => normalizedPath(input, home),
        userDirectories: () => Effect.succeed({
          home: macosPath(home),
          config: macosPath(
            environmentValue(environment, "XDG_CONFIG_HOME")
              ?? join(home, "Library", "Application Support"),
          ),
          data: macosPath(
            environmentValue(environment, "XDG_DATA_HOME")
              ?? join(home, "Library", "Application Support"),
          ),
          cache: macosPath(
            environmentValue(environment, "XDG_CACHE_HOME")
              ?? join(home, "Library", "Caches"),
          ),
        }),
        ensureDirectory: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.ensureDirectory({ ...input, path })),
          ),
        atomicWrite: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.atomicWrite({ ...input, path })),
          ),
        readFile: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.readFile({ ...input, path })),
          ),
        removeFile: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.removeFile({ ...input, path })),
          ),
        removeEmptyDirectory: (input: RemoveEmptyDirectoryInput) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.removeEmptyDirectory({ ...input, path })),
          ),
        validatePathWithinRoot: (input) =>
          Effect.all({
            root: requireMacosPath(input.root),
            path: requireMacosPath(input.path),
          }).pipe(Effect.flatMap(machine.validatePathWithinRoot)),
        mutateWithinRoot: (input) =>
          Effect.all({
            root: requireMacosPath(input.root),
            path: requireMacosPath(input.path),
          }).pipe(
            Effect.flatMap(({ root, path }) =>
              machine.mutateWithinRoot({
                root,
                path,
                mutation: input.mutation,
              })
            ),
          ),
        replaceSymlink: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.replaceSymlink({ ...input, path })),
          ),
        readSymlink: (path) =>
          requireMacosPath(path).pipe(
            Effect.flatMap(machine.readSymlink),
          ),
        inspectPath: (path) =>
          requireMacosPath(path).pipe(Effect.flatMap(machine.inspectPath)),
        listDirectory: (path) =>
          requireMacosPath(path).pipe(Effect.flatMap(machine.listDirectory)),
        setPermissions: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.setPermissions({ ...input, path })),
          ),
        permissions: (path) =>
          requireMacosPath(path).pipe(Effect.flatMap(machine.permissions)),
        snapshotPermissions: (path) =>
          requireMacosPath(path).pipe(Effect.flatMap(machine.snapshotPermissions)),
        findExecutable: (query) => {
          const searchPath = query.searchPath?.map(linuxPath);
          return machine.findExecutable({ ...query, searchPath }).pipe(
            Effect.map((found) => ({ ...found, path: macosPath(found.path.absolute) })),
          );
        },
        runProcess: (invocation) =>
          Effect.all({
            executable: requireMacosPath(invocation.executable),
            workingDirectory: invocation.workingDirectory === undefined
              ? Effect.succeed(undefined)
              : requireMacosPath(invocation.workingDirectory),
          }).pipe(
            Effect.flatMap(({ executable, workingDirectory }) =>
              machine.runProcess({ ...invocation, executable, workingDirectory })
            ),
          ),
        digestFile: (input) =>
          requireMacosPath(input.path).pipe(
            Effect.flatMap((path) => machine.digestFile({ ...input, path })),
          ),
        credentialCapability: (): Effect.Effect<
          CredentialStorageCapability,
          MachineStateError
        > => {
          if (policy.kind === "local-file") {
            return Effect.succeed({
              kind: "local-file",
              path: macosPath(resolve(policy.path)),
            });
          }
          return secureStoreAvailable.pipe(Effect.map((available) =>
            available
              ? { kind: "secure-noninteractive" as const, provider: "keychain" as const }
              : {
                kind: "unavailable" as const,
                recovery:
                  "Run on macOS with an unlocked login Keychain, or explicitly select the local-file credential policy.",
              }
          ));
        },
        storeCredential: (input) => {
          if (policy.kind === "local-file") return machine.storeCredential(input);
          if (input.name.trim().length === 0) {
            return Effect.fail(new CredentialStorageError({
              operation: "store credential",
              reference: "keychain",
              message: "credential name must not be empty",
            }));
          }
          const key = createHash("sha256").update(input.name).digest("hex");
          return requireSecurity.pipe(
            Effect.flatMap(() =>
              runSecurity([
                "add-generic-password",
                "-U",
                "-a",
                "canonfig",
                "-s",
                `dev.canonfig.${key}`,
                "-w",
                Redacted.value(input.value),
              ])
            ),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.succeed(
                  decode(CredentialReference)(`keychain:${key}`),
                )
                : Effect.fail(new HumanActionRequiredError({
                  action: "unlock macOS Keychain",
                  recovery: "Unlock the login Keychain for this user session, then retry.",
                }))
            ),
          );
        },
        loadCredential: (input) => {
          if (policy.kind === "local-file") return machine.loadCredential(input);
          return Effect.gen(function*() {
            const key = yield* keychainKey(input.reference);
            yield* requireSecurity;
            const result = yield* runSecurity([
              "find-generic-password",
              "-a",
              "canonfig",
              "-s",
              `dev.canonfig.${key}`,
              "-w",
            ]);
            if (result.exitCode !== 0) {
              return yield* new HumanActionRequiredError({
                action: "provide macOS Keychain credential",
                recovery: "Store the required credential in the unlocked login Keychain, then retry.",
              });
            }
            return Redacted.make(
              Buffer.from(result.standardOutput).toString("utf8").replace(/\n$/u, ""),
            );
          });
        },
        removeCredential: (reference) => {
          if (policy.kind === "local-file") return machine.removeCredential(reference);
          return Effect.gen(function*() {
            const key = yield* keychainKey(reference);
            yield* requireSecurity;
            const result = yield* runSecurity([
              "delete-generic-password",
              "-a",
              "canonfig",
              "-s",
              `dev.canonfig.${key}`,
            ]);
            if (result.exitCode !== 0) {
              return yield* new CredentialStorageError({
                operation: "remove credential",
                reference: String(reference),
                message: "macOS Keychain did not remove the credential",
              });
            }
          });
        },
        renderSchedulerJob: renderLaunchdJob,
        inspectSchedulerJob: scheduler.inspect,
        snapshotSchedulerJob: scheduler.snapshot,
        installSchedulerJob: scheduler.install,
        removeSchedulerJob: scheduler.remove,
        restoreSchedulerJob: scheduler.restore,
      });
    }).pipe(Effect.provide(base)),
  );
};
