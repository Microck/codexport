import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

const environment = (root: string) => [
  { name: "HOME", value: join(root, "home") },
  { name: "XDG_CONFIG_HOME", value: join(root, "config") },
  { name: "XDG_DATA_HOME", value: join(root, "data") },
  { name: "XDG_CACHE_HOME", value: join(root, "cache") },
  { name: "PATH", value: dirnameOfExecutable },
];

const dirnameOfExecutable = dirname(process.execPath);

machineStateContract("Linux", {
  platform: "linux",
  executable: process.execPath,
  localFileLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
      environment: environment(root),
    }),
  secureStoreLayer: (root) =>
    linuxMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      environment: environment(root),
    }),
});

describe("portable safe-root mutation", () => {
  it("lists every entry beneath a managed directory without following symlinks out", async () => {
    // Observation only ever inspected owned and desired paths, so a file the
    // operator added was invisible and therefore unremovable, which made
    // `replace` behave exactly like `mirror-owned` for anything foreign.
    const root = mkdtempSync(join(tmpdir(), "canonfig-list-directory-"));
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    mkdirSync(join(managed, "nested"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(managed, "owned.txt"), "owned");
    writeFileSync(join(managed, "foreign.txt"), "foreign");
    writeFileSync(join(managed, "nested", "deep.txt"), "deep");
    writeFileSync(join(outside, "secret.txt"), "must not be listed");
    symlinkSync(outside, join(managed, "link"));

    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({ path: managed });
        return yield* machine.listDirectory(path);
      }).pipe(Effect.provide(
        linuxMachineStateLayer({
          credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
          environment: environment(root),
        }),
      )),
    );

    expect(listed.map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
      "foreign.txt:regular",
      "link:symlink",
      "nested:directory",
      "nested/deep.txt:regular",
      "owned.txt:regular",
    ]);
    // The symlinked directory is reported but never descended into, so a link
    // cannot walk the listing out of the managed root.
    expect(listed.some((entry) => entry.path.includes("secret"))).toBe(false);
  });

  it("lists nothing for a directory that does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-list-absent-"));
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const machine = yield* MachineState;
        const path = yield* machine.normalizePath({ path: join(root, "absent") });
        return yield* machine.listDirectory(path);
      }).pipe(Effect.provide(
        linuxMachineStateLayer({
          credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
          environment: environment(root),
        }),
      )),
    );
    expect(listed).toEqual([]);
  });

  it("replaces an empty directory with a standalone symlink but preserves non-empty directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-standalone-symlink-"));
    try {
      const empty = join(root, "empty");
      const blocked = join(root, "blocked");
      const target = join(root, "target.txt");
      mkdirSync(empty);
      mkdirSync(blocked);
      writeFileSync(join(blocked, "child.txt"), "preserve");
      writeFileSync(target, "target");
      const layer = linuxMachineStateLayer({ environment: environment(root) });

      await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const emptyPath = yield* machine.normalizePath({ path: empty });
          yield* machine.replaceSymlink({ path: emptyPath, target });
        }).pipe(Effect.provide(layer)),
      );
      expect(readlinkSync(empty)).toBe(target);

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const blockedPath = yield* machine.normalizePath({ path: blocked });
          yield* machine.replaceSymlink({ path: blockedPath, target });
        }).pipe(Effect.provide(layer)),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "replace symlink",
      });
      expect(readFileSync(join(blocked, "child.txt"), "utf8")).toBe("preserve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies a root-contained source while atomically replacing a final symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const target = join(managed, "nested", "settings.json");
      const outside = join(root, "outside.json");
      const source = join(managed, "source.txt");
      mkdirSync(managed);
      writeFileSync(outside, "outside");
      writeFileSync(source, "managed");

      await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({ path: target });
          const outsidePath = yield* machine.normalizePath({ path: outside });
          const sourcePath = yield* machine.normalizePath({ path: source });
          const sourceDigest = (yield* machine.digestFile({ path: sourcePath })).value;
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "symlink",
              target: outsidePath.absolute,
            },
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: { file: source, digest: sourceDigest },
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
        }))),
      );

      expect(readFileSync(target, "utf8")).toBe("managed");
      expect(readFileSync(outside, "utf8")).toBe("outside");
      expect(readFileSync(source, "utf8")).toBe("managed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces conflicting final object kinds but preserves non-empty directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const target = join(managed, "entry");
      const blocked = join(managed, "blocked");
      mkdirSync(managed);
      writeFileSync(target, "file");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "child.txt"), "preserve");
      const layer = linuxMachineStateLayer({
        environment: environment(root),
        safeRootMutationStrategy: "portable",
      });

      const kinds = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({ path: target });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: { kind: "directory", mode: 0o700 },
          });
          const directory = yield* machine.inspectPath(targetPath);
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("replacement"),
            },
          });
          const regular = yield* machine.inspectPath(targetPath);
          return { directory, regular };
        }).pipe(Effect.provide(layer)),
      );

      expect(kinds).toEqual({
        directory: { kind: "directory" },
        regular: { kind: "regular" },
      });
      expect(readFileSync(target, "utf8")).toBe("replacement");

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const blockedPath = yield* machine.normalizePath({ path: blocked });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: blockedPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("replacement"),
            },
          });
        }).pipe(Effect.provide(layer)),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(join(blocked, "child.txt"), "utf8")).toBe("preserve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an ancestor is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const outside = join(root, "outside");
      const outsideFile = join(outside, "settings.json");
      mkdirSync(managed);
      mkdirSync(outside);
      writeFileSync(outsideFile, "outside");
      symlinkSync(outside, join(managed, "nested"));

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({
            path: join(managed, "nested", "settings.json"),
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("managed"),
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
        }))),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the managed root is swapped before isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-portable-safe-root-"));
    try {
      const managed = join(root, "managed");
      const displaced = join(root, "displaced");
      const outside = join(root, "outside");
      const outsideFile = join(outside, "settings.json");
      mkdirSync(managed);
      mkdirSync(outside);
      writeFileSync(outsideFile, "outside");

      await expect(Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const managedPath = yield* machine.normalizePath({ path: managed });
          const targetPath = yield* machine.normalizePath({
            path: join(managed, "settings.json"),
          });
          yield* machine.mutateWithinRoot({
            root: managedPath,
            path: targetPath,
            mutation: {
              kind: "write",
              content: new TextEncoder().encode("managed"),
            },
          });
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
          safeRootMutationStrategy: "portable",
          beforeSafeRootMutation: async () => {
            renameSync(managed, displaced);
            symlinkSync(outside, managed);
          },
        }))),
      )).rejects.toMatchObject({
        _tag: "MachineFilesystemError",
        operation: "mutate managed path",
      });
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects final objects without following links and refuses non-regular reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-no-follow-"));
    try {
      const outside = join(root, "outside.txt");
      const link = join(root, "link.txt");
      const directory = join(root, "directory");
      writeFileSync(outside, "outside");
      mkdirSync(directory);
      symlinkSync(outside, link);

      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const linkPath = yield* machine.normalizePath({ path: link });
          const directoryPath = yield* machine.normalizePath({ path: directory });
          const specialPath = yield* machine.normalizePath({ path: "/dev/null" });
          const linkKind = yield* machine.inspectPath(linkPath);
          const directoryKind = yield* machine.inspectPath(directoryPath);
          const specialKind = yield* machine.inspectPath(specialPath);
          const linkDigest = yield* machine.digestFile({ path: linkPath }).pipe(Effect.exit);
          const linkRead = yield* machine.readFile({
            path: linkPath,
            maximumBytes: 1024,
          }).pipe(Effect.exit);
          const directoryDigest = yield* machine.digestFile({ path: directoryPath }).pipe(Effect.exit);
          return { linkKind, directoryKind, specialKind, linkDigest, linkRead, directoryDigest };
        }).pipe(Effect.provide(linuxMachineStateLayer({
          environment: environment(root),
        }))),
      );

      expect(result.linkKind).toEqual({ kind: "symlink" });
      expect(result.directoryKind).toEqual({ kind: "directory" });
      expect(result.specialKind).toEqual({ kind: "special" });
      expect(result.linkDigest._tag).toBe("Failure");
      expect(result.linkRead._tag).toBe("Failure");
      expect(result.directoryDigest._tag).toBe("Failure");
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bounded process cleanup", () => {
  it("terminates the process group after a timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-process-tree-"));
    const childPidPath = join(root, "child.pid");
    try {
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const exit = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: process.execPath });
          return yield* machine.runProcess({
            executable,
            arguments: ["-e", parentScript],
            timeoutMilliseconds: 500,
            maximumOutputBytes: 1024,
          }).pipe(Effect.exit);
        }).pipe(Effect.provide(linuxMachineStateLayer({ environment: environment(root) }))),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Cause.pretty(exit.cause)).toContain("ProcessTimeoutError");
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      await expect.poll(() => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 2_000 }).toBe(false);
    } finally {
      if (existsSync(childPidPath)) {
        const childPid = Number(readFileSync(childPidPath, "utf8"));
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The expected path: the timed-out process group is already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
