import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { win32 } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import { MachineState } from "../src/machine/machine-state.service.ts";
import { ActionId, ResourceId, RunId } from "../src/domain/brand.ts";
import { sha256BytesHex } from "../src/profile/profile-codec.ts";
import { defaultSynchronizationExecutionLimits } from "../src/synchronization/executor.ts";
import {
  prepareResourceAction,
  type ResourceExecutionContext,
} from "../src/synchronization/resource-executors.ts";

import {
  decodeWindowsTaskXml,
  windowsMachineStateLayer,
  windowsAccountPrincipal,
  windowsPrivateAclArguments,
  windowsRecurrenceIntervalMatches,
  windowsTaskQueryReportsAbsence,
  windowsTaskProbeReportsAbsence,
  windowsTaskTriggerEnabled,
  windowsWeekdaysMatch,
} from "../src/machine/windows.layer.ts";
import { machineStateContract } from "./contract/machine-state.contract.ts";

// Windows adapter paths must stay Windows-shaped while still addressing real
// host storage. Each contract test supplies its own temporary root; keep a
// stable per-root Windows drive mapping so repeated calls for one root agree,
// which is what the adapter's path normalization and the contract's expected
// values both require.
const windowsRoots = new Map<string, string>();

const windowsRoot = (root: string): string => {
  for (const mapped of windowsRoots.values()) {
    const remainder = win32.relative(mapped, root);
    if (
      remainder === ""
      || (!remainder.startsWith(`..${win32.sep}`)
        && remainder !== ".."
        && !win32.isAbsolute(remainder))
    ) {
      return root;
    }
  }
  const existing = windowsRoots.get(root);
  if (existing !== undefined) return existing;
  const created = win32.join(
    mkdtempSync(join(root, "canonfig-windows-drive-")).replaceAll("/", "\\"),
    "root",
  );
  windowsRoots.set(root, created);
  return created;
};

const environment = (root: string) => {
  const nativeRoot = windowsRoot(root);
  return [
    { name: "USERPROFILE", value: win32.join(nativeRoot, "home") },
    { name: "APPDATA", value: win32.join(nativeRoot, "config") },
    { name: "LOCALAPPDATA", value: win32.join(nativeRoot, "data") },
    { name: "PATH", value: dirname(process.execPath) },
    { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
    { name: "SystemRoot", value: process.env.SystemRoot ?? "C:\\Windows" },
  ];
};

describe.skipIf(process.platform !== "win32")("Windows file permission ownership", () => {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const inspectAcl = async (path: string) => {
    const output = await promisify(execFile)(powershell, [
      "-NoProfile", "-NonInteractive", "-Command",
      // Use .NET directly: PowerShell 7 launchers can pass a module search
      // path that prevents Windows PowerShell from loading Get-Acl.
      "$acl = if ([System.IO.Directory]::Exists($env:CANONFIG_TEST_PATH)) { "
        + "[System.IO.Directory]::GetAccessControl($env:CANONFIG_TEST_PATH) "
        + "} else { [System.IO.File]::GetAccessControl($env:CANONFIG_TEST_PATH) }; "
        + "$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)",
    ], { env: { ...process.env, CANONFIG_TEST_PATH: path } });
    return output.stdout.trim();
  };

  it.each(["file", "directory"] as const)("restores persisted %s permissions in a fresh process", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-native-rollback-"));
    const managed = join(root, "managed");
    const nested = join(managed, "nested");
    const target = join(nested, "settings.json");
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(target, "original content");
      // An administrator token can create files owned by its default group.
      // Capture a user-owned preimage so replacement must restore the owner too.
      await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $path=$env:CANONFIG_TEST_PATH; "
          + "$acl=[IO.File]::GetAccessControl($path); "
          + "$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User); "
          + "[IO.File]::SetAccessControl($path,$acl)",
      ], { env: { ...process.env, CANONFIG_TEST_PATH: target } });
      const ownedPaths = kind === "directory" ? [managed, nested, target] : [target];
      const originalAcls = await Promise.all(ownedPaths.map(inspectAcl));
      const parentAcl = await inspectAcl(root);
      const resource = ResourceId.make("permission-fixture");
      const content = Buffer.from("desired content");
      const digest = sha256BytesHex(content);
      const relative = "nested/settings.json";
      const resourceTarget = kind === "directory" ? managed : target;
      const detail = kind === "directory"
        ? { kind: "mirror-directory" as const, target: managed, adds: [relative], removes: [] }
        : { kind: "write-file" as const, target, digest, executable: false, mode: 0o600 };
      const context: ResourceExecutionContext = {
        run: RunId.make("run-native-permissions"),
        action: { id: ActionId.make("action:native-permissions:0:write"), resource, kind: detail.kind, detail, before: [] },
        resource: { id: resource, kind, policy: kind === "directory" ? "mirror-owned" : "replace",
          target: resourceTarget, dependsOn: [], blobs: [] },
        desired: kind === "directory"
          ? { kind, mode: 0o700, directories: [], files: [{ path: relative, digest, mode: 0o600, executable: false }] }
          : { kind, digest, mode: 0o600, executable: false },
        verification: { method: "digest", digest },
        artifacts: new Map([[digest, { digest, content }]]),
        limits: defaultSynchronizationExecutionLimits,
      };
      const localEnvironment = Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined || name.toUpperCase() === "LOCALAPPDATA" ? [] : [{ name, value }]
      );
      localEnvironment.push({ name: "LOCALAPPDATA", value: join(root, "cache") });
      const layer = () => windowsMachineStateLayer({ environment: localEnvironment });
      const reference = await Effect.runPromise(Effect.gen(function*() {
        const prepared = yield* prepareResourceAction(context);
        yield* prepared.execute;
        return prepared.rollbackReference;
      }).pipe(Effect.provide(layer())));
      if (reference === undefined) throw new Error("expected a persisted rollback journal");
      expect(await readFile(target, "utf8")).toBe("desired content");
      expect(await inspectAcl(target)).not.toBe(originalAcls.at(-1));

      // Reconstruct recovery from disk in a fresh process, then replay it.
      // Compare against native observations, not the adapter's snapshot reader.
      for (let attempt = 0; attempt < 2; attempt++) {
        await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
          import { Effect } from "effect";
          import { windowsMachineStateLayer } from "./src/machine/windows.layer.ts";
          import { restoreRollbackReference } from "./src/synchronization/resource-executors.ts";
          const context = JSON.parse(process.env.CANONFIG_TEST_CONTEXT);
          context.artifacts = new Map();
          await Effect.runPromise(restoreRollbackReference(context, process.env.CANONFIG_TEST_REFERENCE)
            .pipe(Effect.provide(windowsMachineStateLayer())));
        `], {
          cwd: dirname(import.meta.dirname),
          env: { ...process.env, LOCALAPPDATA: join(root, "cache"),
            CANONFIG_TEST_CONTEXT: JSON.stringify({ ...context, artifacts: [] }),
            CANONFIG_TEST_REFERENCE: reference },
          timeout: 30_000,
        });
        expect(await readFile(target, "utf8")).toBe("original content");
        expect(await Promise.all(ownedPaths.map(inspectAcl))).toEqual(originalAcls);
        expect(await inspectAcl(root)).toBe(parentAcl);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([{ parents: [] }, { parents: ["new", "nested"] }])(
    "preserves existing ACLs and protects new file paths ($parents)",
    async ({ parents }) => {
      const root = await mkdtemp(join(tmpdir(), "canonfig-file-permissions-"));
      const target = join(root, ...parents, "settings.json");
      const sibling = join(root, "unmanaged.txt");
      const source = join(root, "source.txt");
      try {
        const parentAcl = await inspectAcl(root);
        if (parents.length > 0) {
          const failingAclEnvironment = Object.entries(process.env).flatMap(([name, value]) =>
            value === undefined || name === "CANONFIG_ICACLS" ? [] : [{ name, value }]
          );
          failingAclEnvironment.push({
            name: "CANONFIG_ICACLS", value: join(root, "missing-icacls.exe"),
          });
          await expect(Effect.runPromise(Effect.gen(function*() {
            const machine = yield* MachineState;
            const path = yield* machine.normalizePath({ path: target });
            yield* machine.atomicWrite({ path, content: Buffer.from("must not be written") });
          }).pipe(Effect.provide(windowsMachineStateLayer({
            environment: failingAclEnvironment,
          }))))).rejects.toThrow();
          expect(await readdir(root)).toEqual([]);
        }
        await writeFile(sibling, "keep sibling");
        await writeFile(source, "file-source content");
        const siblingAcl = await inspectAcl(sibling);
        await Effect.runPromise(Effect.gen(function*() {
          const machine = yield* MachineState;
          const path = yield* machine.normalizePath({ path: target });
          yield* machine.atomicWrite({ path, content: Buffer.from("buffer content") });
          expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("buffer content");
          const sourcePath = yield* machine.normalizePath({ path: source });
          const digest = (yield* machine.digestFile({ path: sourcePath })).value;
          yield* machine.atomicWrite({ path, content: { file: source, digest } });
          expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("file-source content");
        }).pipe(Effect.provide(windowsMachineStateLayer())));
        expect(await inspectAcl(root)).toBe(parentAcl);
        expect(await inspectAcl(sibling)).toBe(siblingAcl);
        expect(await readFile(sibling, "utf8")).toBe("keep sibling");
        expect((await readdir(root)).sort()).toEqual([
          parents[0] ?? "settings.json", "source.txt", "unmanaged.txt",
        ]);
        for (let index = 1; index <= parents.length; index++) {
          const acl = await inspectAcl(join(root, ...parents.slice(0, index)));
          expect(acl).not.toMatch(/;;;(?:WD|AU|BU)\)/u);
        }
        const targetAcl = await inspectAcl(target);
        // Protected DACLs do not regain inherited broad access on publication.
        expect(targetAcl).toContain("D:P");
        expect(targetAcl).not.toMatch(/;;;(?:WD|AU|BU)\)/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("protects a new local credential directory without changing its parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-credential-permissions-"));
    const credentials = join(root, "credentials");
    try {
      const parentAcl = await inspectAcl(root);
      const reference = await Effect.runPromise(Effect.gen(function*() {
        const machine = yield* MachineState;
        return yield* machine.storeCredential({
          name: "acl-fixture",
          value: Redacted.make("public test fixture"),
        });
      }).pipe(Effect.provide(windowsMachineStateLayer({
        credentialPolicy: { kind: "local-file", path: credentials },
      }))));
      const credentialPath = String(reference).slice("local-file:".length);
      expect(await readFile(credentialPath, "utf8")).toBe("public test fixture");
      for (const path of [credentials, credentialPath]) {
        const acl = await inspectAcl(path);
        expect(acl).toContain("D:P");
        expect(acl).not.toMatch(/;;;(?:WD|AU|BU)\)/u);
      }
      expect(await inspectAcl(root)).toBe(parentAcl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Windows ACL command rendering", () => {
  it("renders shell-free current-user-only ACL arguments", () => {
    expect(windowsPrivateAclArguments(
      "C:\\Users\\operator\\secret & echo exposed",
      "DOMAIN\\operator",
      false,
    )).toEqual([
      "C:\\Users\\operator\\secret & echo exposed",
      "/inheritance:r",
      "/grant:r",
      "DOMAIN\\operator:(F)",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
    ]);
    expect(windowsPrivateAclArguments(
      "C:\\Users\\operator\\.canonfig",
      "DOMAIN\\operator",
      true,
    )).toEqual([
      "C:\\Users\\operator\\.canonfig",
      "/inheritance:r",
      "/grant:r",
      "DOMAIN\\operator:(OI)(CI)(F)",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
    ]);
  });

  it("uses the computer account namespace for local OpenSSH users", () => {
    expect(windowsAccountPrincipal([
      { name: "USERNAME", value: "crabbox" },
      { name: "USERDOMAIN", value: "WORKGROUP" },
      { name: "COMPUTERNAME", value: "CANONFIG-ARM64" },
    ], "C:\\Users\\crabbox")).toBe("CANONFIG-ARM64\\crabbox");

    expect(windowsAccountPrincipal([
      { name: "USERNAME", value: "operator" },
      { name: "USERDOMAIN", value: "MICR" },
      { name: "USERDNSDOMAIN", value: "micr.example" },
      { name: "COMPUTERNAME", value: "WORKSTATION" },
    ], "C:\\Users\\operator")).toBe("MICR\\operator");
  });
});

describe("Windows Task Scheduler inspection", () => {
  it("decodes UTF-16LE task exports with a byte-order mark", () => {
    const xml = "<?xml version=\"1.0\"?><Task><Enabled>true</Enabled></Task>";
    const encoded = Buffer.from(`\ufeff${xml}`, "utf16le");
    expect(decodeWindowsTaskXml(encoded)).toBe(xml);
    expect(decodeWindowsTaskXml(Buffer.from(xml, "utf8"))).toBe(xml);
  });

  it("requires the installed weekly trigger to have the exact day set", () => {
    const exact = "<DaysOfWeek><Friday /><Monday /></DaysOfWeek>";
    const extra = "<DaysOfWeek><Monday /><Friday /><Sunday /></DaysOfWeek>";
    expect(windowsWeekdaysMatch(exact, ["Mon", "Fri"])).toBe(true);
    expect(windowsWeekdaysMatch(extra, ["Mon", "Fri"])).toBe(false);
  });

  it("requires daily and weekly recurrence intervals of one", () => {
    expect(windowsRecurrenceIntervalMatches("<DaysInterval>1</DaysInterval>", "daily")).toBe(true);
    expect(windowsRecurrenceIntervalMatches("<DaysInterval>2</DaysInterval>", "daily")).toBe(false);
    expect(windowsRecurrenceIntervalMatches("<WeeksInterval>1</WeeksInterval>", "weekly")).toBe(true);
    expect(windowsRecurrenceIntervalMatches("<WeeksInterval>2</WeeksInterval>", "weekly")).toBe(false);
  });

  it("requires the calendar trigger itself to be enabled", () => {
    expect(windowsTaskTriggerEnabled("<Enabled>true</Enabled>")).toBe(true);
    expect(windowsTaskTriggerEnabled("<Enabled>false</Enabled>")).toBe(false);
    expect(windowsTaskTriggerEnabled("<StartBoundary>2000-01-01T00:00:00</StartBoundary>"))
      .toBe(true);
  });

  it("distinguishes a missing task from scheduler query failures", () => {
    const query = (exitCode: number, standardError: string) => ({
      exitCode,
      standardOutput: new Uint8Array(),
      standardError: Buffer.from(standardError),
    });
    expect(windowsTaskQueryReportsAbsence(
      query(1, "ERROR: 0x80070002"),
    )).toBe(true);
    expect(windowsTaskQueryReportsAbsence(
      query(1, "FEHLER: Das System kann die angegebene Datei nicht finden."),
    )).toBe(false);
    expect(windowsTaskQueryReportsAbsence(
      query(1, "ERROR: Access is denied."),
    )).toBe(false);
    expect(windowsTaskQueryReportsAbsence(query(0, ""))).toBe(false);
    expect(windowsTaskProbeReportsAbsence(query(3, ""))).toBe(true);
    expect(windowsTaskProbeReportsAbsence(query(2, ""))).toBe(false);
  });
});

machineStateContract("Windows", {
  platform: "windows",
  executable: process.execPath,
  nativeOperations: process.platform === "win32",
  pathJoin: (first, ...parts) => win32.join(windowsRoot(first), ...parts),
  expectedUserDirectories: (root) => {
    const nativeRoot = windowsRoot(root);
    return {
      home: win32.join(nativeRoot, "home"),
      config: win32.join(nativeRoot, "config"),
      data: win32.join(nativeRoot, "data"),
      cache: win32.join(nativeRoot, "data"),
    };
  },
  localFileLayer: (root) => {
    const nativeRoot = windowsRoot(root);
    return windowsMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: win32.join(nativeRoot, "credentials"),
      },
      environment: environment(root),
    });
  },
  secureStoreLayer: (root) =>
    windowsMachineStateLayer({
      credentialPolicy: { kind: "secure-store" },
      credentialStoreAccess: "unavailable",
      environment: environment(root),
    }),
  schedulerAssertions: (rendered) => {
    expect(rendered.service).toContain("New-ScheduledTaskAction");
    expect(rendered.service).toContain("\"a value\"");
    expect(rendered.schedule).toContain("New-ScheduledTaskTrigger -Daily -At '00:00'");
    expect(rendered.schedule).toContain("Register-ScheduledTask");
  },
});
