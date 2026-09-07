import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateCli } from "../src/cli/cli.ts";

const projectRoot = resolve(import.meta.dirname, "..");

const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), "utf8");

const installSkill = readProjectFile("skills/install-canonfig/SKILL.md");
const setupSkill = readProjectFile("skills/setup-canonfig/SKILL.md");
const setupQuestions = readProjectFile(
  "skills/setup-canonfig/references/questions.md",
);
const setupSource = readProjectFile(
  "skills/setup-canonfig/references/source-setup.md",
);
const setupFollower = readProjectFile(
  "skills/setup-canonfig/references/follower-setup.md",
);
const setupHarness = readProjectFile(
  "skills/setup-canonfig/references/harness-setup.md",
);
const setupCompletion = readProjectFile(
  "skills/setup-canonfig/references/completion.md",
);
const operationsSkill = readProjectFile("skills/operate-canonfig/SKILL.md");
const followerOperations = readProjectFile(
  "skills/operate-canonfig/references/follower-operations.md",
);
const platformBoundaries = readProjectFile(
  "skills/operate-canonfig/references/platform-boundaries.md",
);

describe("Canonfig skill platform scenarios", () => {
  it.each([
    {
      platform: "Linux",
      reference: "skills/install-canonfig/references/linux.md",
      credentialProvider: "Secret Service",
      scheduler: "systemd user timer",
      recipe: "apt",
      install: "npm install --global @microck/canonfig@3.1.0",
    },
    {
      platform: "macOS",
      reference: "skills/install-canonfig/references/macos.md",
      credentialProvider: "Keychain",
      scheduler: "launchd user agent",
      recipe: "Homebrew",
      install: "npm install --global @microck/canonfig@3.1.0",
    },
    {
      platform: "Windows",
      reference: "skills/install-canonfig/references/windows.md",
      credentialProvider: "Credential Manager",
      scheduler: "per-user Task Scheduler",
      recipe: "winget",
      install: "npm install --global @microck/canonfig@3.1.0",
    },
  ])(
    "installs and operates safely on $platform",
    ({ reference, credentialProvider, scheduler, recipe, install }) => {
      const branch = readProjectFile(reference);
      expect(branch).toContain("Node.js 24");
      expect(branch).toContain("@microck/canonfig@3.1.0");
      expect(branch).toContain(install);
      expect(branch).toContain(credentialProvider);
      expect(branch).toContain(scheduler);
      expect(branch).toContain("Human Action Required");
      expect(branch).toMatch(/Do not|do not/u);
      expect(installSkill).toContain(reference.replace("skills/install-canonfig/", ""));
      expect(platformBoundaries).toContain(credentialProvider);
      expect(platformBoundaries).toContain(scheduler);
      expect(platformBoundaries).toContain(recipe);
      expect(operationsSkill).toContain("references/platform-boundaries.md");
    },
  );
});

describe("Canonfig guided setup experience", () => {
  it("observes the environment before asking the operator", () => {
    expect(setupSkill).toContain("Inspect before asking");
    expect(setupSkill).toContain("Do not ask for facts already established");
    expect(setupSkill).toContain("Ask no more than four related unresolved questions");
    expect(setupSkill).toContain("If every remaining value has a safe, reversible default");
  });

  it("explains every question and recommends a justified answer", () => {
    expect(setupQuestions).toContain("Question:");
    expect(setupQuestions).toContain("Why it matters:");
    expect(setupQuestions).toContain("Detected:");
    expect(setupQuestions).toContain("Recommended:");
    expect(setupQuestions).toContain("No automatic recommendation");
    expect(setupQuestions).toContain("Never disguise an inference as a detected fact");
  });

  it("supports compact acceptance and targeted overrides", () => {
    expect(setupSkill).toContain("Use recommendations");
    expect(setupSkill).toContain("Skip optional");
    expect(setupSkill).toContain("Show advanced options");
    expect(setupQuestions).toContain("override answers by question number or field name");
    expect(setupQuestions).toContain("Accept terse corrections");
  });

  it("keeps recommendations separate from security and mutation approval", () => {
    expect(setupSkill).toContain("A recommendation is not approval");
    expect(setupQuestions).toContain("never approves future publication");
    expect(setupSource).toContain("Publication gate");
    expect(setupFollower).toContain("Apply this exact synchronization plan?");
    expect(setupHarness).toContain("Approval for one collision does not authorize blanket");
  });

  it("avoids optional-feature interrogation and secret collection", () => {
    expect(setupSkill).toContain("Do not ask about optional shared secrets");
    expect(setupHarness).toContain("Do not ask the user to define empty optional sections");
    expect(setupSkill).toContain("Never request passwords, tokens, private keys");
    expect(setupFollower).toContain("Do not ask for the invitation payload in chat");
  });

  it("requires evidence before reporting completion", () => {
    expect(setupCompletion).toContain("A command completing is not proof");
    expect(setupCompletion).toContain("complete");
    expect(setupCompletion).toContain("incomplete — Human Action Required");
    expect(setupCompletion).toContain("Do not call a degraded, partially applied");
  });
});

describe("Canonfig skill safety scenarios", () => {
  it("refuses trust bypass and requests fresh enrollment material", () => {
    expect(installSkill).toContain("Refuse an expired, replayed");
    expect(installSkill).toContain("Request a new invitation");
    expect(installSkill).toContain("never reset trust or suppress verification");
  });

  it("preserves Human Action Required instead of embedding a credential", () => {
    expect(installSkill).toContain("preserve the Human Action");
    expect(installSkill).toContain("Keep secrets out of command arguments");
    expect(followerOperations).toContain("Present the recorded reason, exact instructions");
    expect(followerOperations).toContain("Keep tokens off the command line");
  });

  it("preserves a follower-modified skill instead of forcing convergence", () => {
    expect(operationsSkill).toContain("Preserve modified follower skills");
    expect(followerOperations).toContain("preserve it and report the conflict");
    expect(followerOperations).toContain("Unattended agents do not make this");
  });

  it("keeps scheduled apply noninteractive and failures visible", () => {
    const outcome = evaluateCli(["sync", "--apply", "--no-input", "--json"]);
    expect(outcome._tag).toBe("Command");
    expect(operationsSkill).toContain("Scheduled runs never wait for approval");
    expect(operationsSkill).toContain("Keep failure output visible");
  });

  it("keeps recovery on the persisted journal", () => {
    const outcome = evaluateCli(["recover", "--no-input", "--json"]);
    expect(outcome._tag).toBe("Command");
    expect(followerOperations).toContain("resumes the recorded plan");
    expect(followerOperations).toContain("preserve SQLite state and the action journal");
  });
});

const setupCatalogue = readProjectFile("skills/setup-canonfig/references/configuration-choices.md");
const setupDiscovery = readProjectFile("skills/setup-canonfig/references/tailscale-discovery.md");

describe("Canonfig choice-first setup contract", () => {
  it("offers two modes without resetting answers or changing permission boundaries", () => {
    expect(setupSkill).toContain("### Simple");
    expect(setupSkill).toContain("### Advanced");
    expect(setupSkill).toContain("There are exactly two modes");
    expect(setupSkill).toContain("Switch without restarting or losing answers");
    expect(setupSkill).toContain("Simple and Advanced change interview depth, never");
    expect(setupQuestions).toContain("A bare `2` is valid only for one active question");
    expect(setupQuestions).toContain("comma-separated numbers");
    expect(setupQuestions).toContain("Exclude consent/approval questions from");
  });

  it("gives every question example explained, consecutive choices ending in custom input", () => {
    const texts = [setupSkill, setupQuestions, setupSource, setupFollower, setupHarness, setupDiscovery];
    let checked = 0;
    for (const text of texts) {
      for (const match of text.matchAll(/```text\n([\s\S]*?)```/gu)) {
        const body = match[1]!;
        if (!body.includes("Question:")) continue;
        expect(body).toContain("Why it matters:");
        expect(body).toContain("Recommended:");
        expect(body).toContain("Options:");
        const options = [...body.matchAll(/^(\d+)\. (.+)$/gmu)];
        expect(options.length).toBeGreaterThanOrEqual(3);
        expect(options.map((entry) => Number(entry[1]))).toEqual(options.map((_, index) => index + 1));
        expect(options.at(-1)?.[2]).toContain("Other (type your own)");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("covers nested configurable fields without forcing empty optional sections", () => {
    for (const field of ["Apply Policy", "Dependencies", "Local Overlay", "Verification", "Build policy", "Invitation", "Agent policy", "Maximum input bytes", "Schedule", "MCP:", "Hooks:", "Agents:", "Commands:", "Permissions:", "Extensions:"]) {
      expect(setupCatalogue).toContain(field);
    }
    expect(setupCatalogue).toContain("Apply the same\nmenu rule recursively");
    expect(setupCatalogue).toContain("Other (type your own)");
  });

  it("keeps discovery opt-in, privacy-minimized, and distinct from direct connectivity", () => {
    expect(setupDiscovery).toContain("After consent");
    expect(setupDiscovery).toContain("not a full\ntailnet inventory");
    expect(setupDiscovery).toContain("Freeze the\nnumber-to-ID mapping");
    expect(setupDiscovery).toContain("Do not scan subnets");
    expect(setupDiscovery).toContain("loopback HTTPS origins");
    expect(setupDiscovery).toContain("Discovery creates no tunnel");
    expect(setupDiscovery).toContain("Never claim fleet completion from local status");
  });

  it("runs discovery fixture tests without contacting a tailnet", () => {
    const output = execFileSync(process.execPath, [
      "--test", "--test-reporter=tap", resolve(projectRoot, "skills/setup-canonfig/scripts/discover-tailscale.test.mjs"),
    ], { encoding: "utf8", timeout: 15_000 });
    expect(output).toContain("# fail 0");
  });
});
