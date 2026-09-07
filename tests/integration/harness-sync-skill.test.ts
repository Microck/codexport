import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HarnessConfigurationCompiler } from "../../src/harness-configuration/core/compiler.ts";
import { applyPlan } from "../../src/harness-configuration/core/planner.ts";
import { validateDocumentation } from "../../website/scripts/validate-commands.ts";

const skillRoot = resolve(import.meta.dirname, "../../skills/sync-harnesses");
const readSkill = (path: string): string => readFileSync(join(skillRoot, path), "utf8");
const main = readSkill("SKILL.md");
const choices = readSkill("references/choices.md");
const migration = readSkill("references/native-import.md");
const local = readSkill("references/local.md");
const remote = readSkill("references/remote.md");
const verification = readSkill("references/verification.md");
const nativeInput = readSkill("assets/codex-project.example.toml");
const canonical = readSkill("assets/harness.example.json");
const targets = ["claude-code", "antigravity"] as const;

// The fixture is a reviewed migration candidate, not an automatic import API.
// Tests use isolated checkouts only: no native executable, MCP, SSH, or tailnet.
const withProject = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-harness-sync-"));
  try {
    await mkdir(join(root, ".canonfig", "instructions"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex", "config.toml"), nativeInput);
    await writeFile(join(root, ".canonfig", "harness.json"), canonical);
    await writeFile(join(root, ".canonfig", "instructions", "AGENTS.md"), "# Project\n\nRun the relevant tests.\n");
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const planProject = (root: string) =>
  new HarnessConfigurationCompiler().plan({ root, targets, strict: true });

const assertReady = (plan: Awaited<ReturnType<typeof planProject>>): void => {
  expect(plan.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  expect(plan.entries.filter((entry) => entry.action === "conflict")).toEqual([]);
};

describe("Harness sync skill contract", () => {
  it("has explained numbered choices, custom input, and two persistent modes", () => {
    expect(main).toContain("name: sync-harnesses");
    expect(main.split(/\r?\n/u).length).toBeLessThanOrEqual(500);
    expect(main).toContain("Exactly two modes: Simple and Advanced");
    expect(main).toContain("switching modes preserves answers");
    expect(choices).toContain("`Use recommendations` excludes consent and approval");
    let checked = 0;
    for (const text of [main, choices, migration, local, remote, verification]) {
      for (const match of text.matchAll(/```text\n([\s\S]*?)```/gu)) {
        const body = match[1]!;
        if (!body.includes("Question:")) continue;
        expect(body).toContain("Why it matters:");
        expect(body).toContain("Recommended:");
        expect(body).toContain("Options:");
        const options = [...body.matchAll(/^(\d+)\. (.+)$/gmu)];
        expect(options.length).toBeGreaterThanOrEqual(3);
        expect(options.map((entry) => Number(entry[1])))
          .toEqual(options.map((_, index) => index + 1));
        expect(options.at(-1)?.[2]).toContain("Other (type your own)");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("distinguishes native migration, projection, remote delivery, and readiness", () => {
    expect(migration).toContain("There is no native import command");
    expect(migration).toContain("retained-native");
    expect(migration).toContain("No generic root-model/provider transfer");
    expect(local).toContain("Common artifacts may be generated even for a subset");
    expect(local).toContain("`--force` applies to the invocation");
    expect(remote).toContain("Ordinary follower sync does not run");
    expect(remote).toContain("Selecting a host is not permission to log in");
    expect(remote).toContain("`.canonfig/.harness-state.json`");
    expect(remote).toContain("Do not let Machine Profiles own the same generated");
    expect(remote).toContain("`handoff prepared — not executed`");
    expect(verification).toContain("Never infer fleet completion from local evidence");
    expect(verification).toContain("can exit 0 with missing results");
  });

  it("uses CLI examples accepted by the documentation validator", async () => {
    const result = await validateDocumentation([skillRoot]);
    expect(result.checked).toBeGreaterThan(10);
  });
});

describe("Prepared harness migration projection", () => {
  it("projects to Claude Code and Antigravity without overwriting Codex, then becomes a no-op", async () =>
    withProject(async (root) => {
      const plan = await planProject(root);
      assertReady(plan);
      expect(plan.targets).toEqual(targets);
      expect(plan.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        "AGENTS.md", "CLAUDE.md", ".mcp.json", ".agents/mcp_config.json",
      ]));
      expect(plan.entries.some((entry) => entry.path === ".codex/config.toml")).toBe(false);
      await expect(readFile(join(root, "CLAUDE.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await applyPlan(plan);
      expect(await readFile(join(root, ".codex/config.toml"), "utf8")).toBe(nativeInput);
      expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
      for (const output of [".mcp.json", ".agents/mcp_config.json"]) {
        const text = await readFile(join(root, output), "utf8");
        expect(text).toContain("https://mcp.example.invalid/mcp");
        expect(text).not.toContain("codex-only-model");
        expect(() => JSON.parse(text)).not.toThrow();
      }
      const repeated = await planProject(root);
      assertReady(repeated);
      expect(repeated.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    }));

  it("reports an existing MCP key collision instead of overwriting it", async () =>
    withProject(async (root) => {
      const existing = JSON.stringify({ mcpServers: { docs: { url: "https://existing.example.invalid/mcp" } } });
      await writeFile(join(root, ".mcp.json"), existing);
      const plan = await planProject(root);
      expect(plan.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".mcp.json", action: "conflict" }),
      ]));
      expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(existing);
    }));

  it("detects external edits to a generated managed instruction block", async () =>
    withProject(async (root) => {
      const plan = await planProject(root);
      assertReady(plan);
      await applyPlan(plan);
      const path = join(root, "CLAUDE.md");
      const original = await readFile(path, "utf8");
      const edited = original.replace("@AGENTS.md", "@LOCAL.md");
      expect(edited).not.toBe(original);
      await writeFile(path, edited);
      const next = await planProject(root);
      expect(next.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "CLAUDE.md", action: "conflict" }),
      ]));
      expect(await readFile(path, "utf8")).toBe(edited);
    }));

  it("keeps ownership independent in two checkouts using identical canonical inputs", async () =>
    withProject(async (first) => withProject(async (second) => {
      const firstPlan = await planProject(first);
      assertReady(firstPlan);
      await applyPlan(firstPlan);
      await expect(readFile(join(second, ".canonfig/.harness-state.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      const existing = JSON.stringify({ mcpServers: { docs: { url: "https://local.example.invalid/mcp" } } });
      await writeFile(join(second, ".mcp.json"), existing);
      const secondPlan = await planProject(second);
      expect(secondPlan.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".mcp.json", action: "conflict" }),
      ]));
      const firstAgain = await planProject(first);
      assertReady(firstAgain);
      expect(firstAgain.entries.every((entry) => entry.action === "unchanged")).toBe(true);
      expect(await readFile(join(second, ".mcp.json"), "utf8")).toBe(existing);
    })));
});
