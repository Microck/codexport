import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface SkillContract {
  readonly name: string;
  readonly descriptionTerms: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly bodyTerms: ReadonlyArray<string>;
}

const projectRoot = resolve(import.meta.dirname, "../..");

const contracts: ReadonlyArray<SkillContract> = [
  {
    name: "install-canonfig",
    descriptionTerms: ["Linux", "macOS", "Windows", "enroll"],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/linux.md",
      "references/macos.md",
      "references/windows.md",
    ],
    bodyTerms: [
      "Node.js 24",
      "@microck/canonfig@3.1.1",
      "canonfig source init",
      "canonfig follower enroll",
      "pinned trust",
      "Human Action Required",
      "Secret Service",
      "Keychain",
      "Credential Manager",
      "systemd",
      "launchd",
      "Task Scheduler",
    ],
  },
  {
    name: "sync-harnesses",
    descriptionTerms: ["Codex", "Claude Code", "Antigravity", "Simple", "Advanced", "remote"],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/choices.md",
      "references/native-import.md",
      "references/local.md",
      "references/remote.md",
      "references/verification.md",
      "assets/codex-project.example.toml",
      "assets/harness.example.json",
    ],
    bodyTerms: [
      "Exactly two modes: Simple and Advanced",
      "Other (type your own)",
      "Why it matters:",
      "Use recommendations",
      "There is no native import command",
      "retained-native",
      "canonfig harness plan",
      "canonfig harness apply",
      "Ordinary follower sync does not run",
      "handoff prepared — not executed",
      "Never infer fleet completion from local evidence",
    ],
  },
  {
    name: "setup-canonfig",
    descriptionTerms: [
      "Linux",
      "macOS",
      "Windows",
      "questions",
      "recommended answers",
      "Simple",
      "Advanced",
      "Tailscale",
    ],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/questions.md",
      "references/configuration-choices.md",
      "references/tailscale-discovery.md",
      "scripts/discover-tailscale.mjs",
      "scripts/discover-tailscale.test.mjs",
      "references/source-setup.md",
      "references/follower-setup.md",
      "references/harness-setup.md",
      "references/completion.md",
    ],
    bodyTerms: [
      "Inspect before asking",
      "Use recommendations",
      "Why it matters",
      "Detected",
      "Recommended",
      "Other (type your own)",
      "### Simple",
      "### Advanced",
      "tailscale status --json",
      "number-to-ID mapping",
      "Node.js 24",
      "@microck/canonfig@3.1.1",
      "canonfig source init",
      "canonfig follower enroll",
      "canonfig sync --plan",
      "canonfig harness validate",
      "Human Action Required",
      "Follower Drift",
      "Secret Service",
      "Keychain",
      "Credential Manager",
      "systemd",
      "launchd",
      "Task Scheduler",
    ],
  },
  {
    name: "operate-canonfig",
    descriptionTerms: [
      "publication",
      "revocation",
      "synchronization",
      "Human Action Required",
      "recovery",
    ],
    files: [
      "SKILL.md",
      "agents/openai.yaml",
      "references/source-operations.md",
      "references/follower-operations.md",
      "references/platform-boundaries.md",
    ],
    bodyTerms: [
      "canonfig source scan",
      "canonfig source publish",
      "canonfig source invite",
      "canonfig source revoke",
      "canonfig profile select",
      "canonfig sync --plan",
      "canonfig sync --apply --no-input",
      "canonfig agent policy",
      "canonfig agent harness",
      "canonfig schedule set",
      "canonfig doctor",
      "Follower Drift",
      "Human Action Required",
      "canonfig recover",
      "Secret Service",
      "Keychain",
      "Credential Manager",
    ],
  },
];

const assertIncludes = (
  text: string,
  expected: string,
  location: string,
): void => {
  if (!text.includes(expected)) {
    throw new Error(`${location} must include ${JSON.stringify(expected)}`);
  }
};

const validateFrontmatter = (
  skillName: string,
  skillMarkdown: string,
): string => {
  const match = /^---\nname: (?<name>[a-z0-9-]+)\ndescription: (?<description>[^\n]+)\n---\n/u.exec(
    skillMarkdown,
  );
  if (match?.groups === undefined) {
    throw new Error(`${skillName}/SKILL.md has invalid frontmatter`);
  }
  if (match.groups.name !== skillName) {
    throw new Error(`${skillName}/SKILL.md frontmatter name does not match its directory`);
  }
  if (match.groups.description.trim().length < 80) {
    throw new Error(`${skillName}/SKILL.md description is not a useful trigger pointer`);
  }
  return match.groups.description;
};

for (const contract of contracts) {
  const skillRoot = resolve(projectRoot, "skills", contract.name);
  for (const relativePath of contract.files) {
    const path = resolve(skillRoot, relativePath);
    const fileStatus = await stat(path);
    if (!fileStatus.isFile()) {
      throw new Error(`${path} must be a file`);
    }
  }

  const skillPath = resolve(skillRoot, "SKILL.md");
  const skillMarkdown = await readFile(skillPath, "utf8");
  const description = validateFrontmatter(contract.name, skillMarkdown);
  if (skillMarkdown.split(/\r?\n/u).length > 500) {
    throw new Error(`${skillPath} exceeds the 500-line progressive-disclosure limit`);
  }
  if (skillMarkdown.includes("TODO")) {
    throw new Error(`${skillPath} contains an unresolved template marker`);
  }
  for (const term of contract.descriptionTerms) {
    assertIncludes(description, term, `${skillPath} description`);
  }

  const disclosedText = (
    await Promise.all(
      contract.files
        .filter((relativePath) => relativePath.endsWith(".md"))
        .map((relativePath) => readFile(resolve(skillRoot, relativePath), "utf8")),
    )
  ).join("\n");
  for (const term of contract.bodyTerms) {
    assertIncludes(disclosedText, term, skillRoot);
  }

  const agentMetadata = await readFile(
    resolve(skillRoot, "agents/openai.yaml"),
    "utf8",
  );
  assertIncludes(agentMetadata, `$${contract.name}`, `${contract.name}/agents/openai.yaml`);
}

process.stdout.write(`Validated ${contracts.length} Canonfig skill structures.\n`);
