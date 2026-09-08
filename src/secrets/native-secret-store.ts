import { createHash } from "node:crypto";
import { win32 } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import { CredentialReference } from "../domain/brand.ts";
import {
  CredentialStorageError,
  HumanActionRequiredError,
  type MachineStateError,
} from "../machine/machine-state.errors.ts";
import { MachineState } from "../machine/machine-state.service.ts";
import type {
  CredentialStorageCapability,
  LoadCredentialInput,
  ProcessEnvironmentEntry,
  StoreCredentialInput,
} from "../machine/machine-state.types.ts";

const maximumCredentialOutputBytes = 1024 * 1024;
const credentialTimeoutMilliseconds = 5_000;
const keychainHexPrefix = "keychain-hex:";
const decode = Schema.decodeUnknownSync;

// SecurityTool's interactive input is limited to 4 KiB. The native framework
// accepts the full secret over stdin; the same host reads its Keychain items.
// Core Foundation constants must become Objective-C objects before dictionary use.
const keychainArguments = ["-l", "JavaScript", "-e", [
  "ObjC.import('Foundation');",
  "ObjC.import('Security');",
  "function run() {",
  "  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));",
  "  const query = $.NSMutableDictionary.dictionary;",
  "  query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));",
  "  query.setObjectForKey($(payload.service), ObjC.castRefToObject($.kSecAttrService));",
  "  query.setObjectForKey($('canonfig'), ObjC.castRefToObject($.kSecAttrAccount));",
  "  if (payload.operation === 'load') {",
  "    query.setObjectForKey($.NSNumber.numberWithBool(true), ObjC.castRefToObject($.kSecReturnData));",
  "    const output = Ref();",
  "    const status = $.SecItemCopyMatching(query, output);",
  "    if (status !== 0) throw Error('Keychain read failed: ' + status);",
  "    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(output[0]), $.NSUTF8StringEncoding));",
  "  }",
  "  const attributes = $.NSMutableDictionary.dictionary;",
  "  attributes.setObjectForKey($(payload.hexadecimal).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData));",
  "  let status = $.SecItemUpdate(query, attributes);",
  "  if (status === -25300) { // errSecItemNotFound",
  "    query.addEntriesFromDictionary(attributes);",
  "    status = $.SecItemAdd(query, null);",
  "  }",
  "  if (status !== 0) throw Error('Keychain write failed: ' + status);",
  "}",
].join("\n")];

export interface NativeCredentialWriteCommand {
  readonly provider: "keychain" | "credential-manager";
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<ProcessEnvironmentEntry>;
  readonly standardInput: Uint8Array;
  readonly reference: typeof CredentialReference.Type;
}

export interface NativeSecretStoreLayerOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly runCommand?: ((
    machine: MachineState["Service"],
    command: NativeCredentialWriteCommand,
  ) => Effect.Effect<number | null, MachineStateError>) | undefined;
}

const failure = (
  provider: NativeCredentialWriteCommand["provider"],
): HumanActionRequiredError =>
  provider === "keychain"
    ? new HumanActionRequiredError({
      action: "unlock macOS Keychain",
      recovery: "Unlock the login Keychain for this user session, then retry.",
    })
    : new HumanActionRequiredError({
      action: "unlock Windows Credential Manager",
      recovery: "Sign in interactively and make Credential Manager available, then retry.",
    });

const runNativeCredentialCommand = (
  machine: MachineState["Service"],
  command: NativeCredentialWriteCommand,
): Effect.Effect<number | null, MachineStateError> =>
  Effect.gen(function*() {
    const executable = yield* machine.normalizePath({
      path: command.executable,
    });
    const result = yield* machine.runProcess({
      executable,
      arguments: command.arguments,
      environment: command.environment,
      standardInput: command.standardInput,
      timeoutMilliseconds: credentialTimeoutMilliseconds,
      maximumOutputBytes: maximumCredentialOutputBytes,
    });
    return result.exitCode;
  });

const keychainStorageReference = (
  reference: typeof CredentialReference.Type,
): typeof CredentialReference.Type | undefined => {
  const text = String(reference);
  if (!text.startsWith(keychainHexPrefix)) return undefined;
  return decode(CredentialReference)(`keychain:${text.slice(keychainHexPrefix.length)}`);
};

const decodeKeychainValue = (
  input: LoadCredentialInput,
  value: Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<string>, CredentialStorageError> =>
  Effect.try({
    try: () => {
      const hexadecimal = Redacted.value(value);
      if (!/^(?:[0-9a-f]{2})+$/u.test(hexadecimal)) {
        throw new Error("invalid Keychain hex payload");
      }
      return Redacted.make(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(hexadecimal, "hex"),
        ),
      );
    },
    catch: () => new CredentialStorageError({
      operation: "load credential",
      reference: String(input.reference),
      message: "the versioned Keychain credential is invalid",
    }),
  });

export const nativeCredentialWriteCommand = (
  capability: Extract<CredentialStorageCapability, {
    readonly kind: "secure-noninteractive";
  }>,
  input: StoreCredentialInput,
  environment: NodeJS.ProcessEnv = process.env,
): NativeCredentialWriteCommand | undefined => {
  if (capability.provider === "secret-service") return undefined;
  const key = createHash("sha256").update(input.name).digest("hex");
  const value = Redacted.value(input.value);

  if (capability.provider === "keychain") {
    const hexadecimalValue = Buffer.from(value, "utf8").toString("hex");
    return {
      provider: "keychain",
      executable: "/usr/bin/osascript",
      arguments: keychainArguments,
      environment: [],
      standardInput: new TextEncoder().encode(
        JSON.stringify({ operation: "store", service: `dev.canonfig.${key}`, hexadecimal: hexadecimalValue }),
      ),
      reference: decode(CredentialReference)(`${keychainHexPrefix}${key}`),
    };
  }

  const powershell = environment.CANONFIG_POWERSHELL
    ?? win32.join(
      environment.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$secret=[Console]::In.ReadToEnd()",
    "$vault=New-Object Windows.Security.Credentials.PasswordVault",
    "$credential=New-Object Windows.Security.Credentials.PasswordCredential("
      + "$env:CANONFIG_TARGET,'canonfig',$secret)",
    "$vault.Add($credential)",
  ].join(";");
  return {
    provider: "credential-manager",
    executable: powershell,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    environment: [{
      name: "CANONFIG_TARGET",
      value: `dev.canonfig.${key}`,
    }],
    standardInput: new TextEncoder().encode(value),
    reference: decode(CredentialReference)(`credential-manager:${key}`),
  };
};

export const nativeSecretStoreLayer = (
  base: Layer.Layer<MachineState>,
  options: NativeSecretStoreLayerOptions = {},
): Layer.Layer<MachineState> =>
  Layer.effect(
    MachineState,
    Effect.map(MachineState, (machine) => ({
      ...machine,
      storeCredential: (input: StoreCredentialInput) =>
        Effect.gen(function*() {
          if (input.name.trim().length === 0) {
            return yield* new CredentialStorageError({
              operation: "store credential",
              reference: "native-store",
              message: "credential name must not be empty",
            });
          }
          const capability = yield* machine.credentialCapability();
          if (capability.kind !== "secure-noninteractive") {
            return yield* machine.storeCredential(input);
          }
          const command = nativeCredentialWriteCommand(
            capability,
            input,
            options.environment,
          );
          if (command === undefined) return yield* machine.storeCredential(input);
          const exitCode = yield* (options.runCommand ?? runNativeCredentialCommand)(
            machine,
            command,
          );
          if (exitCode !== 0) return yield* failure(command.provider);
          return command.reference;
        }),
      loadCredential: (input: LoadCredentialInput) => {
        const reference = String(input.reference);
        if (!reference.startsWith(keychainHexPrefix)) return machine.loadCredential(input);
        return Effect.gen(function*() {
          const executable = yield* machine.normalizePath({ path: "/usr/bin/osascript" });
          const loaded = yield* machine.runProcess({
            executable,
            arguments: keychainArguments,
            standardInput: new TextEncoder().encode(JSON.stringify({
              operation: "load",
              service: `dev.canonfig.${reference.slice(keychainHexPrefix.length)}`,
            })),
            timeoutMilliseconds: credentialTimeoutMilliseconds,
            maximumOutputBytes: maximumCredentialOutputBytes,
          });
          if (loaded.exitCode !== 0) {
            return yield* new CredentialStorageError({
              operation: "load credential",
              reference: String(input.reference),
              message: "the Keychain credential is unavailable",
            });
          }
          return yield* decodeKeychainValue(input, Redacted.make(
            new TextDecoder().decode(loaded.standardOutput).trim(),
          ));
        });
      },
      removeCredential: (reference: typeof CredentialReference.Type) => {
        const storageReference = keychainStorageReference(reference);
        return machine.removeCredential(storageReference ?? reference);
      },
    })),
  ).pipe(Layer.provide(base));
