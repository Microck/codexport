import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateCli,
  programDisplayName,
  programName,
  programVersion,
} from "../src/cli/cli.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

const executeCli = (arguments_: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--import", "tsx", runtimeEntrypoint, ...arguments_], {
    cwd: projectRoot,
    encoding: "utf8",
  });

describe("Canonfig foundation CLI", () => {
  it("renders Canonfig help with a successful outcome", () => {
    const outcome = evaluateCli(["--help"]);
    expect(outcome._tag).toBe("Help");
    if (outcome._tag === "Help") {
      expect(outcome.text).toContain(`${programDisplayName} ${programVersion}`);
      expect(outcome.text).toContain(`Usage: ${programName}`);
      expect(outcome.exitCode).toBe(0);
    }
  });

  it("renders the package version with a successful outcome", () => {
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "3.1.2",
      exitCode: 0,
    });
  });

  it("uses Canonfig naming at the CLI and package boundaries", () => {
    const packageManifest = readFileSync(resolve(projectRoot, "package.json"), "utf8");
    expect(programName).toBe("canonfig");
    expect(programDisplayName).toBe("Canonfig");
    expect(packageManifest).toContain('"name": "@microck/canonfig"');
    expect(packageManifest).toContain('"canonfig": "dist/runtime/main.js"');
  });

  it("maps invalid input to exit code 2 and stderr", () => {
    const result = executeCli(["unsupported"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown argument: unsupported");
    expect(result.stderr).toContain("canonfig --help");
  });

  it("runs help and version through the Effect runtime entrypoint", () => {
    const help = executeCli(["--help"]);
    const version = executeCli(["--version"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: canonfig");
    expect(help.stderr).toBe("");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("3.1.2");
    expect(version.stderr).toBe("");
  }, 60_000);

  it("does not depend on the legacy src/index.ts entrypoint", () => {
    const cliSource = readFileSync(resolve(projectRoot, "src/cli/cli.ts"), "utf8");
    const runtimeSource = readFileSync(runtimeEntrypoint, "utf8");
    const compilerConfig = readFileSync(resolve(projectRoot, "tsconfig.json"), "utf8");
    expect(`${cliSource}\n${runtimeSource}`).not.toContain("index.ts");
    expect(compilerConfig).toContain('"exclude": ["src/index.ts"]');
  });
});
