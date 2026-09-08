import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  createCommandLog,
  type CommandLogFileOperations,
} from "../src/logging/command-log.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeEntrypoint = path.resolve(projectRoot, "src/runtime/main.ts");
const commandLogModule = pathToFileURL(
  path.resolve(projectRoot, "src/logging/command-log.ts"),
).href;
const CommandLogEntrySchema = Schema.Struct({
  schema: Schema.Literal("canonfig.log/v1"),
  timestamp: Schema.String,
  event: Schema.Literals(["command.started", "command.completed"]),
  level: Schema.Literals(["info", "error"]),
  command: Schema.String,
  pid: Schema.Number,
  exitCode: Schema.optional(Schema.Number),
  durationMilliseconds: Schema.optional(Schema.Number),
});
const WindowsAclSchema = Schema.Struct({
  protected: Schema.Boolean,
  ruleCount: Schema.Number,
  identity: Schema.String,
  current: Schema.String,
});
const WINDOWS_ACL_INSPECTION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $env:CANONFIG_LOG_ACL_PATH",
  "$rule = @($acl.Access)[0]",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
  "[Console]::Out.Write((ConvertTo-Json -Compress @{ protected = $acl.AreAccessRulesProtected; ruleCount = @($acl.Access).Count; identity = $rule.IdentityReference.Value; current = $current }))",
].join("; ");
const WINDOWS_ACL_INHERITANCE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $env:CANONFIG_LOG_ACL_PATH",
  "$acl.SetAccessRuleProtection($false, $true)",
  "Set-Acl -LiteralPath $env:CANONFIG_LOG_ACL_PATH -AclObject $acl",
].join("; ");

const readEntries = async (logPath: string) => {
  const content = await readFile(logPath, "utf8");
  return content.trim().split("\n").map((line) =>
    Schema.decodeUnknownSync(CommandLogEntrySchema)(JSON.parse(line))
  );
};

const inspectWindowsAcl = (logPath: string) => {
  const inspected = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_ACL_INSPECTION_SCRIPT,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CANONFIG_LOG_ACL_PATH: logPath },
      windowsHide: true,
    },
  );
  expect(inspected.status, inspected.stderr).toBe(0);
  return Schema.decodeUnknownSync(WindowsAclSchema)(
    JSON.parse(inspected.stdout),
  );
};

const withTemporaryDirectory = async <Value>(
  use: (root: string) => Promise<Value>,
): Promise<Value> => {
  const root = await mkdtemp(path.join(tmpdir(), "canonfig-log-"));
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("command logging", () => {
  it("records command lifecycle data without arguments or output", async () =>
    withTemporaryDirectory(async (root) => {
      const logPath = path.join(root, "canonfig.log");
      const secret = "invitation-secret-that-must-not-be-logged";
      const times = [1_000, 1_125];
      const log = createCommandLog(["follower", "enroll", secret, "--json"], {
        environment: { CANONFIG_LOG_FILE: logPath },
        now: () => times.shift() ?? 1_125,
      });

      log.complete(0);
      log.complete(7);

      const entries = await readEntries(logPath);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        event: "command.started",
        level: "info",
        command: "follower.enroll",
      });
      expect(entries[1]).toMatchObject({
        event: "command.completed",
        level: "info",
        command: "follower.enroll",
        exitCode: 0,
        durationMilliseconds: 125,
      });
      expect(await readFile(logPath, "utf8")).not.toContain(secret);
      if (process.platform !== "win32") {
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
      }
    }));

  it("never interpolates an unrecognized second token", async () =>
    withTemporaryDirectory(async (root) => {
      const logPath = path.join(root, "canonfig.log");
      const secret = "secret-value-passed-where-a-command-was-expected";
      const log = createCommandLog(["follower", secret], {
        environment: { CANONFIG_LOG_FILE: logPath },
      });

      log.complete(2);

      const entries = await readEntries(logPath);
      expect(entries.map((entry) => entry.command)).toEqual([
        "unknown",
        "unknown",
      ]);
      expect(await readFile(logPath, "utf8")).not.toContain(secret);
    }));

  it("restricts a Windows file before the first append", () => {
    const calls: Array<string> = [];
    const fileOperations: CommandLogFileOperations = {
      platform: "win32",
      ensureDirectory: () => calls.push("directory"),
      ensureFile: () => calls.push("file"),
      restrictWindowsAccess: () => {
        calls.push("acl");
        return true;
      },
      restrictPosixAccess: () => calls.push("posix"),
      append: () => calls.push("append"),
    };

    createCommandLog(["status"], {
      environment: { CANONFIG_LOG_FILE: "/tmp/canonfig.log" },
      fileOperations,
      now: () => 0,
    });

    expect(calls).toEqual(["directory", "file", "acl", "append"]);
  });

  it("re-applies Windows access control before every append", () => {
    let restrictions = 0;
    const fileOperations: CommandLogFileOperations = {
      platform: "win32",
      ensureDirectory: () => undefined,
      ensureFile: () => undefined,
      restrictWindowsAccess: () => {
        restrictions += 1;
        return true;
      },
      restrictPosixAccess: () => undefined,
      append: () => undefined,
    };
    const log = createCommandLog(["status"], {
      environment: { CANONFIG_LOG_FILE: "/tmp/canonfig.log" },
      fileOperations,
    });

    log.complete(0);

    expect(restrictions).toBe(2);
  });

  it.runIf(process.platform === "win32")(
    "uses a protected owner-only Windows ACL",
    async () => withTemporaryDirectory(async (root) => {
      const logPath = path.join(root, "canonfig.log");
      const log = createCommandLog(["status"], {
        environment: { CANONFIG_LOG_FILE: logPath },
      });
      log.complete(0);

      const acl = inspectWindowsAcl(logPath);
      expect(acl.protected).toBe(true);
      expect(acl.ruleCount).toBe(1);
      expect(acl.identity.toLowerCase()).toBe(acl.current.toLowerCase());
    }),
  );

  it.runIf(process.platform === "win32")(
    "re-secures a replacement log file before completion", async () =>
      withTemporaryDirectory(async (root) => {
        const logPath = path.join(root, "canonfig.log");
        const log = createCommandLog(["status"], {
          environment: { CANONFIG_LOG_FILE: logPath },
        });

        await rm(logPath, { force: true });
        await writeFile(logPath, "", "utf8");
        const loosened = spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_ACL_INHERITANCE_SCRIPT,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, CANONFIG_LOG_ACL_PATH: logPath },
            windowsHide: true,
          },
        );
        expect(loosened.status, loosened.stderr).toBe(0);
        expect(inspectWindowsAcl(logPath).protected).toBe(false);

        log.complete(0);

        const acl = inspectWindowsAcl(logPath);
        expect(acl.protected).toBe(true);
        expect(acl.ruleCount).toBe(1);
        expect(acl.identity.toLowerCase()).toBe(acl.current.toLowerCase());
      }),
  );

  for (
    const [signal, exitCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const
  ) {
    it.runIf(process.platform !== "win32")(
      `records completion before ${signal} termination`,
      async () => withTemporaryDirectory(async (root) => {
        const logPath = path.join(root, "canonfig.log");
        const source = [
          `import { createCommandLog, registerCommandLogSignalHandlers } from ${JSON.stringify(commandLogModule)};`,
          `const log = createCommandLog(["source", "serve"], { environment: { CANONFIG_LOG_FILE: ${JSON.stringify(logPath)} } });`,
          "registerCommandLogSignalHandlers(log);",
          "process.stdout.write('ready\\n');",
          "setInterval(() => undefined, 1000);",
        ].join("\n");
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
          {
            cwd: projectRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        try {
          const [ready] = await once(child.stdout!, "data");
          expect(String(ready)).toContain("ready");
          expect(child.kill(signal)).toBe(true);
          const [code, observedSignal] = await once(child, "exit");
          expect(code).toBeNull();
          expect(observedSignal).toBe(signal);

          const entries = await readEntries(logPath);
          expect(entries).toHaveLength(2);
          expect(entries[1]).toMatchObject({
            event: "command.completed",
            command: "source.serve",
            exitCode,
          });
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      }),
    );
  }

  it("can be disabled without affecting the command", async () =>
    withTemporaryDirectory(async (root) => {
      const logPath = path.join(root, "canonfig.log");
      const log = createCommandLog(["status"], {
        environment: {
          CANONFIG_LOG: "off",
          CANONFIG_LOG_FILE: logPath,
        },
      });

      log.complete(0);

      await expect(access(logPath)).rejects.toMatchObject({ code: "ENOENT" });
    }));

  it("logs through the shipped runtime entrypoint", async () =>
    withTemporaryDirectory(async (root) => {
      const logPath = path.join(root, "canonfig.log");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", runtimeEntrypoint, "--version"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: { ...process.env, CANONFIG_LOG_FILE: logPath },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("3.1.1");
      expect(await readEntries(logPath)).toEqual([
        expect.objectContaining({
          event: "command.started",
          command: "version",
        }),
        expect.objectContaining({
          event: "command.completed",
          command: "version",
          exitCode: 0,
        }),
      ]);
    }));
});
