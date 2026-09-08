import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CredentialReference } from "../../src/domain/brand.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { CredentialStorageError } from "../../src/machine/machine-state.errors.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import {
  nativeCredentialWriteCommand,
  nativeSecretStoreLayer,
} from "../../src/secrets/native-secret-store.ts";
import { applyTransferredSecrets } from "../../src/secrets/secret-store.ts";

const ManifestSchema = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({
    name: Schema.String,
    reference: CredentialReference,
  })),
  retiredReferences: Schema.optional(Schema.Array(CredentialReference)),
});

const readManifest = async (home: string) =>
  Schema.decodeUnknownSync(ManifestSchema)(
    JSON.parse(
      await readFile(join(home, ".canonfig", "secrets.json"), "utf8"),
    ),
  );

describe("shared-secret cleanup retry", () => {
  it("does not create another credential while retired cleanup is blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-secret-retry-"));
    const home = join(root, "home");
    const base = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: home },
        { name: "PATH", value: join(root, "bin") },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
    });
    const secure = Layer.effect(
      MachineState,
      Effect.map(MachineState, (machine) => ({
        ...machine,
        credentialCapability: () =>
          Effect.succeed({
            kind: "secure-noninteractive" as const,
            provider: "secret-service" as const,
          }),
      })),
    ).pipe(Layer.provide(base));
    let credentialWrites = 0;
    const blocked = Layer.effect(
      MachineState,
      Effect.map(MachineState, (machine) => ({
        ...machine,
        storeCredential: (input: Parameters<typeof machine.storeCredential>[0]) =>
          machine.storeCredential(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                credentialWrites += 1;
              })
            ),
          ),
        removeCredential: (reference: typeof CredentialReference.Type) =>
          Effect.fail(new CredentialStorageError({
            operation: "remove credential",
            reference: String(reference),
            message: "injected persistent removal failure",
          })),
      })),
    ).pipe(Layer.provide(secure));

    try {
      await Effect.runPromise(
        applyTransferredSecrets({
          schemaVersion: 1,
          secrets: [{ name: "rotated", value: "first" }],
        }).pipe(Effect.provide(secure)),
      );

      await expect(
        Effect.runPromise(
          applyTransferredSecrets({
            schemaVersion: 1,
            secrets: [{ name: "rotated", value: "second" }],
          }).pipe(Effect.provide(blocked)),
        ),
      ).rejects.toMatchObject({
        category: "storage",
        operation: "replace shared secrets",
      });
      const afterFirstFailure = await readManifest(home);
      const activeReference = afterFirstFailure.secrets[0]!.reference;
      expect(credentialWrites).toBe(1);
      expect(afterFirstFailure.retiredReferences).toHaveLength(1);

      await expect(
        Effect.runPromise(
          applyTransferredSecrets({
            schemaVersion: 1,
            secrets: [{ name: "rotated", value: "third" }],
          }).pipe(Effect.provide(blocked)),
        ),
      ).rejects.toMatchObject({
        category: "storage",
        operation: "clean retired secrets",
      });
      const afterSecondFailure = await readManifest(home);
      expect(credentialWrites).toBe(1);
      expect(afterSecondFailure.secrets[0]!.reference).toBe(activeReference);
      expect(afterSecondFailure.retiredReferences).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes bounded standard input through the machine process boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-process-input-"));
    const layer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: process.env.PATH ?? "" },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
    });
    const input = "bounded-standard-input";

    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({
            path: process.execPath,
          });
          return yield* machine.runProcess({
            executable,
            arguments: [
              "-e",
              "process.stdin.pipe(process.stdout)",
            ],
            standardInput: new TextEncoder().encode(input),
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 4_096,
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.standardOutput).toString("utf8")).toBe(input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized standard input before starting a process", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonfig-process-limit-"));
    const layer = linuxMachineStateLayer({
      environment: [
        { name: "HOME", value: join(root, "home") },
        { name: "PATH", value: process.env.PATH ?? "" },
      ],
      credentialPolicy: {
        kind: "local-file",
        path: join(root, "credentials"),
      },
    });

    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function*() {
            const machine = yield* MachineState;
            const executable = yield* machine.normalizePath({
              path: process.execPath,
            });
            return yield* machine.runProcess({
              executable,
              arguments: ["-e", "process.exit(0)"],
              standardInput: new Uint8Array(64 * 1024 + 1),
              timeoutMilliseconds: 5_000,
              maximumOutputBytes: 4_096,
            });
          }).pipe(Effect.provide(layer)),
        ),
      ).rejects.toMatchObject({
        _tag: "ProcessStartError",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps macOS secret values out of arguments and environment", () => {
    const secret = "mac-secret-value-not-process-metadata";
    const command = nativeCredentialWriteCommand(
      { kind: "secure-noninteractive", provider: "keychain" },
      { name: "canonfig-secret", value: Redacted.make(secret) },
    );

    expect(command).toBeDefined();
    if (command === undefined) throw new Error("expected a Keychain command");
    const metadata = JSON.stringify({
      arguments: command.arguments,
      environment: command.environment,
    });
    const input = Buffer.from(command.standardInput).toString("utf8");
    expect(metadata).not.toContain(secret);
    expect(command.executable).toBe("/usr/bin/osascript");
    expect(command.arguments.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(command.environment).toEqual([]);
    expect(input).not.toContain(secret);
    expect(input).toContain(Buffer.from(secret, "utf8").toString("hex"));
    expect(JSON.parse(input)).toMatchObject({ operation: "store" });
  });

  it.runIf(process.platform === "darwin").each([
    { label: "ASCII", secret: "macos-keychain-token-round-trip" },
    { label: "hex-looking", secret: "deadbeef1234" },
    { label: "2000-byte", secret: "a".repeat(2000) },
    { label: "16-KiB", secret: "a".repeat(16 * 1024) },
    { label: "multibyte", secret: "é🔐-macos-keychain-round-trip" },
    { label: "quoted multiline", secret: "quote \" and slash \\\nsecond line\n" },
  ])(
    "round-trips a $label secret through macOS Keychain stdin",
    async ({ secret }) => {
      const name = `canonfig-native-secret-${randomUUID()}`;
      const layer = nativeSecretStoreLayer(
        macosMachineStateLayer({
          credentialPolicy: { kind: "secure-store" },
        }),
      );
      let reference: typeof CredentialReference.Type | undefined;

      try {
        reference = await Effect.runPromise(
          Effect.gen(function*() {
            const machine = yield* MachineState;
            return yield* machine.storeCredential({
              name,
              value: Redacted.make(secret),
            });
          }).pipe(Effect.provide(layer)),
        );
        const loaded = await Effect.runPromise(
          Effect.gen(function*() {
            const machine = yield* MachineState;
            return yield* machine.loadCredential({ reference: reference! });
          }).pipe(Effect.provide(layer)),
        );
        expect(Redacted.value(loaded)).toBe(secret);
      } finally {
        if (reference !== undefined) {
          try {
            await Effect.runPromise(
              Effect.gen(function*() {
                const machine = yield* MachineState;
                yield* machine.removeCredential(reference!);
              }).pipe(Effect.provide(layer)),
            );
          } catch {
            // Best-effort cleanup for the ephemeral CI credential.
          }
        }
      }
    },
  );

  it("keeps multibyte Windows secret values out of process metadata", () => {
    const secret = "é🔐-windows-secret-value";
    const command = nativeCredentialWriteCommand(
      { kind: "secure-noninteractive", provider: "credential-manager" },
      { name: "canonfig-secret", value: Redacted.make(secret) },
      { SystemRoot: "C:\\Windows" },
    );

    expect(command).toBeDefined();
    if (command === undefined) {
      throw new Error("expected a Credential Manager command");
    }
    const metadata = JSON.stringify({
      arguments: command.arguments,
      environment: command.environment,
    });
    const script = command.arguments.join(" ");
    expect(metadata).not.toContain(secret);
    expect(metadata).not.toContain("CANONFIG_SECRET");
    expect(Buffer.from(command.standardInput).toString("utf8")).toBe(secret);
    expect(script).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain("[Console]::In.ReadToEnd()");
  });

  it.runIf(process.platform === "win32")(
    "decodes multibyte Windows standard input as UTF-8",
    async () => {
      const secret = "é🔐-windows-round-trip";
      const layer = windowsMachineStateLayer();
      const powershell = win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = [
        "$ErrorActionPreference='Stop'",
        "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "$value=[Console]::In.ReadToEnd()",
        "[Console]::Out.Write($value)",
      ].join(";");

      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const machine = yield* MachineState;
          const executable = yield* machine.normalizePath({ path: powershell });
          return yield* machine.runProcess({
            executable,
            arguments: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              script,
            ],
            standardInput: new TextEncoder().encode(secret),
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 4_096,
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.standardOutput).toString("utf8")).toBe(secret);
      expect(Buffer.from(result.standardError).toString("utf8")).toBe("");
    },
  );
});
