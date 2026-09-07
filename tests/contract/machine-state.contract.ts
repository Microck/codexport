import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect, Fiber, Layer, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  HumanActionRequiredError,
  InvalidSchedulerJobError,
  ProcessOutputLimitError,
  ProcessTimeoutError,
} from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";

export interface MachineStateContractAdapter {
  readonly platform: "linux" | "macos" | "windows";
  readonly localFileLayer: (root: string) => Layer.Layer<MachineState>;
  readonly secureStoreLayer: (root: string) => Layer.Layer<MachineState>;
  readonly executable: string;
  readonly nativeOperations?: boolean | undefined;
  readonly pathJoin?: ((...parts: ReadonlyArray<string>) => string) | undefined;
  readonly expectedUserDirectories?: ((root: string) => {
    readonly home: string;
    readonly config: string;
    readonly data: string;
    readonly cache: string;
  }) | undefined;
  readonly schedulerAssertions?: (rendered: {
    readonly service: string;
    readonly schedule: string;
  }) => void;
}

const temporaryDirectories: Array<string> = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "canonfig-machine-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runWith = <Value, Error>(
  layer: Layer.Layer<MachineState>,
  effect: Effect.Effect<Value, Error, MachineState>,
): Promise<Value> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
    }
  }
  throw new Error(`timed out waiting for subprocess marker: ${path}`);
};

const waitForProcessExit = async (processId: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  throw new Error(`subprocess ${processId} remained alive after cancellation`);
};

export const machineStateContract = (
  name: string,
  adapter: MachineStateContractAdapter,
): void => {
  const pathJoin = adapter.pathJoin ?? join;
  const nativeOperations = adapter.nativeOperations ?? true;

  describe(`${name} MachineState contract`, () => {
    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("normalizes paths and reports platform user directories", async () => {
      const root = temporaryDirectory();
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const relative = yield* machine.normalizePath({
            path: "../target/./file",
            base: {
              platform: adapter.platform,
              absolute: pathJoin(root, "base"),
            },
          });
          const homeRelative = yield* machine.normalizePath({ path: "~/profile" });
          const directories = yield* machine.userDirectories();
          return { relative, homeRelative, directories };
        }),
      );

      expect(result.relative).toEqual({
        platform: adapter.platform,
        absolute: pathJoin(root, "target", "file"),
      });
      expect(result.homeRelative.absolute).toBe(pathJoin(root, "home", "profile"));
      const expectedDirectories = adapter.expectedUserDirectories?.(root) ?? {
        home: pathJoin(root, "home"),
        config: pathJoin(root, "config"),
        data: pathJoin(root, "data"),
        cache: pathJoin(root, "cache"),
      };
      expect(result.directories).toEqual({
        home: { platform: adapter.platform, absolute: expectedDirectories.home },
        config: { platform: adapter.platform, absolute: expectedDirectories.config },
        data: { platform: adapter.platform, absolute: expectedDirectories.data },
        cache: { platform: adapter.platform, absolute: expectedDirectories.cache },
      });
    });

    it.skipIf(!nativeOperations)(
      "creates secure directories and atomically replaces files",
      async () => {
      const root = temporaryDirectory();
      const target = join(root, "nested", "settings.json");
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const directory = yield* machine.normalizePath({ path: dirname(target) });
          const path = yield* machine.normalizePath({ path: target });
          yield* machine.ensureDirectory({ path: directory });
          yield* machine.atomicWrite({
            path,
            content: new TextEncoder().encode("old"),
          });
          yield* machine.atomicWrite({
            path,
            content: new TextEncoder().encode("new"),
          });
          return {
            content: yield* machine.readFile({ path, maximumBytes: 3 }),
            directoryPermissions: yield* machine.permissions(directory),
            filePermissions: yield* machine.permissions(path),
          };
        }),
      );

      expect(new TextDecoder().decode(result.content)).toBe("new");
      expect(result.directoryPermissions.mode).toBe(0o700);
      expect(result.filePermissions.mode).toBe(0o600);
      },
    );

    it.skipIf(!nativeOperations).each([false, true])(
      "copies large file sources and rejects corrupt backups before replacement (managed root: %s)",
      async (managedRoot) => {
        const root = temporaryDirectory();
        const source = pathJoin(root, "backup.bin");
        const handle = await open(source, "wx");
        try {
          await handle.truncate(17 * 1024 * 1024);
        } finally {
          await handle.close();
        }
        await runWith(adapter.localFileLayer(root), Effect.gen(function*() {
          const machine = yield* MachineState;
          const directory = yield* machine.normalizePath({ path: pathJoin(root, "managed") });
          const path = yield* machine.normalizePath({ path: pathJoin(directory.absolute, "target.bin") });
          const sourcePath = yield* machine.normalizePath({ path: source });
          const digest = (yield* machine.digestFile({ path: sourcePath })).value;
          yield* machine.ensureDirectory({ path: directory });
          const copy = () => managedRoot
            ? machine.mutateWithinRoot({ root: directory, path, mutation: {
              kind: "write", content: { file: source, digest }, mode: 0o750,
            } })
            : machine.atomicWrite({ path, content: { file: source, digest }, mode: 0o750 });
          yield* copy();
          expect((yield* machine.digestFile({ path })).value).toBe(digest);
          expect((yield* machine.permissions(path)).mode).toBe(0o750);
          // A changed backup must never replace an otherwise valid target.
          yield* Effect.promise(() => writeFile(source, "corrupt"));
          const failure = yield* Effect.flip(copy());
          expect(failure._tag).toBe("MachineFilesystemError");
          expect((yield* machine.digestFile({ path })).value).toBe(digest);
          expect(yield* Effect.promise(() => readdir(directory.absolute))).toEqual(["target.bin"]);
          yield* machine.removeFile({ path });
          yield* machine.ensureDirectory({ path });
          expect((yield* Effect.flip(copy()))._tag).toBe("MachineFilesystemError");
          expect((yield* machine.inspectPath(path)).kind).toBe("directory");
        }));
      },
    );

    it.skipIf(!nativeOperations)(
      "sets permissions and atomically replaces symlinks",
      async () => {
      const root = temporaryDirectory();
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const first = yield* machine.normalizePath({ path: join(root, "first") });
          const second = yield* machine.normalizePath({ path: join(root, "second") });
          const link = yield* machine.normalizePath({ path: join(root, "current") });
          yield* machine.atomicWrite({
            path: first,
            content: new TextEncoder().encode("first"),
          });
          yield* machine.atomicWrite({
            path: second,
            content: new TextEncoder().encode("second"),
          });
          yield* machine.setPermissions({ path: second, mode: 0o750 });
          yield* machine.replaceSymlink({ path: link, target: first.absolute });
          yield* machine.replaceSymlink({ path: link, target: second.absolute });
          return {
            permissions: yield* machine.permissions(second),
            target: yield* machine.readSymlink(link),
          };
        }),
      );

      expect(result.permissions).toEqual({
        mode: 0o750,
        executableByOwner: true,
      });
      expect(result.target).toBe(join(root, "second"));
      },
    );

    it.skipIf(!nativeOperations)(
      "mutates descendants through a safe root without following final symlinks",
      async () => {
        const root = temporaryDirectory();
        const managed = pathJoin(root, "managed");
        const nested = pathJoin(managed, "nested", "settings.json");
        const outside = pathJoin(root, "outside.json");
        const result = await runWith(
          adapter.localFileLayer(root),
          Effect.gen(function*() {
            const machine = yield* MachineState;
            const managedPath = yield* machine.normalizePath({ path: managed });
            const nestedPath = yield* machine.normalizePath({ path: nested });
            const outsidePath = yield* machine.normalizePath({ path: outside });
            yield* machine.ensureDirectory({ path: managedPath });
            yield* machine.atomicWrite({
              path: outsidePath,
              content: new TextEncoder().encode("outside"),
            });
            yield* machine.mutateWithinRoot({
              root: managedPath,
              path: nestedPath,
              mutation: {
                kind: "symlink",
                target: outsidePath.absolute,
              },
            });
            const linkTarget = yield* machine.readSymlink(nestedPath);
            yield* machine.mutateWithinRoot({
              root: managedPath,
              path: nestedPath,
              mutation: {
                kind: "write",
                content: new TextEncoder().encode("managed"),
              },
            });
            return {
              linkTarget,
              managedContent: yield* machine.readFile({
                path: nestedPath,
                maximumBytes: 1024,
              }),
              outsideContent: yield* machine.readFile({
                path: outsidePath,
                maximumBytes: 1024,
              }),
            };
          }),
        );

        expect(result.linkTarget).toBe(outside);
        expect(new TextDecoder().decode(result.managedContent)).toBe("managed");
        expect(new TextDecoder().decode(result.outsideContent)).toBe("outside");
      },
    );

    it.skipIf(!nativeOperations)(
      "fails closed without touching files behind symlink ancestors",
      async () => {
        const root = temporaryDirectory();
        const managed = pathJoin(root, "managed");
        const ancestor = pathJoin(managed, "nested");
        const target = pathJoin(ancestor, "settings.json");
        const outsideDirectory = pathJoin(root, "outside");
        const outside = pathJoin(outsideDirectory, "settings.json");
        const layer = adapter.localFileLayer(root);

        await runWith(
          layer,
          Effect.gen(function*() {
            const machine = yield* MachineState;
            const managedPath = yield* machine.normalizePath({ path: managed });
            const ancestorPath = yield* machine.normalizePath({ path: ancestor });
            const outsideDirectoryPath = yield* machine.normalizePath({
              path: outsideDirectory,
            });
            const outsidePath = yield* machine.normalizePath({ path: outside });
            yield* machine.ensureDirectory({ path: managedPath });
            yield* machine.ensureDirectory({ path: outsideDirectoryPath });
            yield* machine.atomicWrite({
              path: outsidePath,
              content: new TextEncoder().encode("outside"),
            });
            yield* machine.replaceSymlink({
              path: ancestorPath,
              target: outsideDirectoryPath.absolute,
            });
          }),
        );

        await expect(runWith(
          layer,
          Effect.gen(function*() {
            const machine = yield* MachineState;
            const managedPath = yield* machine.normalizePath({ path: managed });
            const targetPath = yield* machine.normalizePath({ path: target });
            yield* machine.mutateWithinRoot({
              root: managedPath,
              path: targetPath,
              mutation: {
                kind: "write",
                content: new TextEncoder().encode("managed"),
              },
            });
          }),
        )).rejects.toMatchObject({
          _tag: "MachineFilesystemError",
          operation: "mutate managed path",
        });
        expect(await readFile(outside, "utf8")).toBe("outside");
      },
    );

    it.skipIf(!nativeOperations)(
      "restores an isolated managed entry when its mutation fails",
      async () => {
        const root = temporaryDirectory();
        const managed = pathJoin(root, "managed");
        const target = pathJoin(managed, "entry");
        const child = pathJoin(target, "child.txt");
        await mkdir(target, { recursive: true });
        await writeFile(child, "preserve");
        const layer = adapter.localFileLayer(root);

        await expect(runWith(
          layer,
          Effect.gen(function*() {
            const machine = yield* MachineState;
            const managedPath = yield* machine.normalizePath({ path: managed });
            const targetPath = yield* machine.normalizePath({ path: target });
            yield* machine.mutateWithinRoot({
              root: managedPath,
              path: targetPath,
              mutation: {
                kind: "write",
                content: new TextEncoder().encode("replacement"),
              },
            });
          }),
        )).rejects.toMatchObject({
          _tag: "MachineFilesystemError",
          operation: "mutate managed path",
        });
        expect(await readFile(child, "utf8")).toBe("preserve");
      },
    );

    it.skipIf(!nativeOperations)(
      "discovers executables and computes SHA-256 digests",
      async () => {
      const root = temporaryDirectory();
      const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const path = yield* machine.normalizePath({ path: join(root, "digest") });
          const executableDirectory = yield* machine.normalizePath({
            path: dirname(adapter.executable),
          });
          yield* machine.atomicWrite({
            path,
            content: new TextEncoder().encode("abc"),
          });
          return {
            executable: yield* machine.findExecutable({
              name: basename(adapter.executable),
              searchPath: [executableDirectory],
            }),
            digest: yield* machine.digestFile({ path }),
          };
        }),
      );

      expect(result.executable.path.absolute).toBe(adapter.executable);
      expect(result.digest).toEqual({ algorithm: "sha256", value: expected });
      },
    );

    it.skipIf(!nativeOperations)(
      "runs argument-vector subprocesses with bounded captured output",
      async () => {
      const root = temporaryDirectory();
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: adapter.executable });
          return yield* machine.runProcess({
            executable,
            arguments: [
              "-e",
              "process.stdout.write(process.argv[1]); process.stderr.write('err')",
              "literal;not-a-shell-command",
            ],
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 1024,
          });
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.standardOutput)).toBe(
        "literal;not-a-shell-command",
      );
      expect(new TextDecoder().decode(result.standardError)).toBe("err");
      },
    );

    it.skipIf(!nativeOperations)(
      "terminates subprocesses at timeout and output limits",
      async () => {
      const root = temporaryDirectory();
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: adapter.executable });
          const timeout = yield* Effect.flip(machine.runProcess({
            executable,
            arguments: ["-e", "setInterval(() => {}, 1000)"],
            timeoutMilliseconds: 50,
            maximumOutputBytes: 1024,
          }));
          const output = yield* Effect.flip(machine.runProcess({
            executable,
            arguments: ["-e", "process.stdout.write('x'.repeat(4096))"],
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 128,
          }));
          return { timeout, output };
        }),
      );

      expect(result.timeout).toBeInstanceOf(ProcessTimeoutError);
      expect(result.output).toBeInstanceOf(ProcessOutputLimitError);
      },
    );

    it.skipIf(!nativeOperations)(
      "kills the subprocess when the Effect fiber is cancelled",
      async () => {
      const root = temporaryDirectory();
      const marker = join(root, "child.pid");
      await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: adapter.executable });
          const fiber = yield* machine.runProcess({
            executable,
            arguments: [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
              marker,
            ],
            timeoutMilliseconds: 20_000,
            maximumOutputBytes: 1024,
          }).pipe(Effect.forkChild);
          yield* Effect.promise(() => waitForFile(marker));
          const processId = yield* Effect.promise(() =>
            readFile(marker, "utf8").then(Number)
          );
          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(() => waitForProcessExit(processId));
        }),
      );
      },
    );

    it("requires human action unless local-file credentials are explicit", async () => {
      const root = temporaryDirectory();
      const unavailable = await runWith(
        adapter.secureStoreLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const capability = yield* machine.credentialCapability();
          const error = yield* Effect.flip(machine.storeCredential({
            name: "source-token",
            value: Redacted.make("must-not-appear"),
          }));
          return { capability, error };
        }),
      );

      expect(unavailable.capability.kind).toBe("unavailable");
      expect(unavailable.error).toBeInstanceOf(HumanActionRequiredError);
      expect(JSON.stringify(unavailable)).not.toContain("must-not-appear");
    });

    it.skipIf(!nativeOperations)(
      "stores local-file credentials only when explicitly selected",
      async () => {
      const root = temporaryDirectory();
      const stored = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const capability = yield* machine.credentialCapability();
          const reference = yield* machine.storeCredential({
            name: "source-token",
            value: Redacted.make("credential-value"),
          });
          const value = yield* machine.loadCredential({ reference });
          const credentialPath = String(reference).slice("local-file:".length);
          const permissions = yield* machine.permissions({
            platform: adapter.platform,
            absolute: credentialPath,
          });
          return {
            capability,
            reference,
            value: Redacted.value(value),
            credentialPath,
            permissions,
          };
        }),
      );

      expect(stored.capability.kind).toBe("local-file");
      expect(stored.reference).not.toContain("source-token");
      expect(stored.reference).not.toContain("credential-value");
      expect(stored.value).toBe("credential-value");
      expect(stored.permissions.mode).toBe(0o600);
      expect(await readFile(stored.credentialPath, "utf8")).toBe("credential-value");
      if (adapter.platform !== "windows") {
        expect((await stat(stored.credentialPath)).mode & 0o777).toBe(0o600);
      }
      },
    );

    it("renders and validates native scheduler primitives", async () => {
      const root = temporaryDirectory();
      const result = await runWith(
        adapter.localFileLayer(root),
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: adapter.executable });
          const rendered = yield* machine.renderSchedulerJob({
            name: "canonfig-sync",
            description: "Canonfig follower synchronization",
            executable,
            arguments: ["sync", "--path", "a value"],
            calendar: { kind: "daily", localTime: "00:00" },
          });
          const invalid = yield* Effect.flip(machine.renderSchedulerJob({
            name: "invalid/name",
            description: "invalid",
            executable,
            arguments: [],
            calendar: { kind: "daily", localTime: "25:99" },
          }));
          return { rendered, invalid };
        }),
      );

      expect(result.rendered.platform).toBe(adapter.platform);
      if (adapter.schedulerAssertions === undefined) {
        expect(result.rendered.service).toContain("ExecStart=");
        expect(result.rendered.service).toContain("\"a value\"");
        expect(result.rendered.schedule).toContain("OnCalendar=*-*-* 00:00:00");
      } else {
        adapter.schedulerAssertions(result.rendered);
      }
      expect(result.invalid).toBeInstanceOf(InvalidSchedulerJobError);
    });
  });
};
