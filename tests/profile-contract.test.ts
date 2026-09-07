import { readFileSync } from "node:fs";

import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestOf,
  parseJsonc,
  sha256Hex,
  stripJsonc,
} from "../src/profile/profile-codec.ts";
import {
  decodeMachineProfileJsonc,
  digestMachineProfile,
  encodeMachineProfile,
  findDependencyCycle,
  ProfileContractError,
  ProfileResourceInputSchema,
  ResourceSpecInputSchema,
  topologicalOrder,
  validateMachineProfile,
  validateProfileResources,
  type ProfileResourceInput,
} from "../src/domain/profile.ts";
import {
  ActionDetailSchema,
  AgentTaskSchema,
  HumanActionRequiredSchema,
  SynchronizationOutcomeSchema,
  SynchronizationPlanSchema,
  validateSynchronizationPlan,
  type ActionDetail,
  type SynchronizationOutcome,
  type SynchronizationPlan,
} from "../src/domain/synchronization.ts";
import { FileResourceSpec } from "../src/domain/resource.ts";
import { composeTextFile, parseTextComposition, sourceTextEnd, sourceTextStart } from "../src/domain/text-composition.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/profile-contract/${name}`, import.meta.url), "utf8");

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

const fileResource = (id: string, over: Partial<ProfileResourceInput> = {}): ProfileResourceInput => ({
  id,
  kind: "file",
  target: `~/.codex/${id}.txt`,
  spec: { kind: "file", content: "hello" },
  verify: { method: "digest", digest: sha256Hex("hello") },
  ...over,
});

describe("canonical JSON", () => {
  it("sorts keys and drops insignificant whitespace", () => {
    const a = { b: 1, a: [2, { d: true, c: null }] };
    const b = { a: [2, { c: null, d: true }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":[2,{"c":null,"d":true}],"b":1}');
  });

  it("treats equivalent JSONC authoring layouts as the same digest", () => {
    const messy = `
      // canonfig authoring file
      {
        /* block comment */
        "name": "workstation",   // trailing comment
        "resources": [
          { "id": "b", "kind": "file", "target": "~/b", "spec": { "kind": "file", "content": "x" }, "verify": { "method": "digest", "digest": "00" } },
          { "id": "a", "kind": "file", "target": "~/a", "spec": { "kind": "file", "content": "y" }, "verify": { "method": "digest", "digest": "11" }, },
        ],
      }
    `;
    const tidy = `{
      "name": "workstation",
      "resources": [
        { "id": "b", "kind": "file", "target": "~/b", "spec": { "kind": "file", "content": "x" }, "verify": { "method": "digest", "digest": "00" } },
        { "id": "a", "kind": "file", "target": "~/a", "spec": { "kind": "file", "content": "y" }, "verify": { "method": "digest", "digest": "11" } }
      ]
    }`;
    const messyValue = parseJsonc(messy);
    const tidyValue = parseJsonc(tidy);
    expect(digestOf(messyValue)).toBe(digestOf(tidyValue));
  });
});

describe("JSONC parsing", () => {
  it("preserves comment-like text inside strings", () => {
    expect(stripJsonc(`{"a": "not // a comment"}`)).toBe(`{"a": "not // a comment"}`);
    expect(stripJsonc(`{"a": "keep /* this */"}`)).toBe(`{"a": "keep /* this */"}`);
  });

  it("removes trailing commas", () => {
    expect(parseJsonc(`{"a": 1,}`)).toEqual({ a: 1 });
    expect(parseJsonc(`[1, 2,]`)).toEqual([1, 2]);
  });

  it("rejects invalid JSONC", () => {
    expect(() => parseJsonc(`{"a": `)).toThrow();
  });
});

describe("filesystem authoring fidelity", () => {
  it("preserves exact modes and canonicalizes non-semantic symlink permissions", () => {
    const profile = decodeMachineProfileJsonc(JSON.stringify({
      id: "filesystem-fidelity",
      name: "Filesystem fidelity",
      resources: [{
        id: "tree",
        kind: "directory",
        target: "~/.canonfig/tree",
        spec: {
          kind: "directory",
          mode: 0o755,
          directories: [{ path: "empty", mode: 0o750 }],
          files: [{
            path: "tool-link",
            content: "",
            mode: 0o777,
            symlinkTo: "../bin/tool",
          }],
        },
        verify: { method: "digest", digest: digestA },
      }],
    }));

    expect(profile.resources[0]?.spec).toEqual({
      kind: "directory",
      mode: 0o755,
      directories: [{ path: "empty", mode: 0o750 }],
      files: [{
        path: "tool-link",
        content: "",
        mode: 0,
        executable: false,
        symlinkTo: "../bin/tool",
      }],
    });
  });

  it.each([-1, 0o10000])(
    "rejects out-of-range mode %i at authoring and publication boundaries",
    (mode) => {
      expect(() => Schema.decodeUnknownSync(ResourceSpecInputSchema)({
        kind: "file",
        content: "hello",
        mode,
      })).toThrow();
      expect(() => Schema.decodeUnknownSync(FileResourceSpec)({
        kind: "file",
        content: "hello",
        digest: sha256Hex("hello"),
        executable: false,
        mode,
      })).toThrow();
    },
  );
});

describe("append-local text contract", () => {
  it.each(["", "shared", "shared\n", "\uFEFFshared\r\n東京\n"])("preserves exact Source and local payloads: %j", (source) => {
    const local = "\uFEFFlocal\r\n\r\n";
    const bytes = composeTextFile(source, { kind: "unmanaged", local });
    expect(parseTextComposition(bytes)).toEqual({ kind: "managed", source, local });
    expect(composeTextFile(source, parseTextComposition(bytes))).toEqual(bytes);
    expect(parseTextComposition(composeTextFile("new Source", parseTextComposition(bytes))))
      .toEqual({ kind: "managed", source: "new Source", local });
  });

  it("does not duplicate identical adopted text", () => {
    expect(parseTextComposition(composeTextFile("same\n", { kind: "unmanaged", local: "same\n" })))
      .toEqual({ kind: "managed", source: "same\n", local: "" });
  });

  it.each([
    sourceTextStart,
    sourceTextEnd,
    `prefix\n${sourceTextStart}\nshared\n${sourceTextEnd}\n\nlocal`,
    `${sourceTextStart}\nshared\n${sourceTextEnd}\nlocal`,
    `${sourceTextStart}\nshared\n${sourceTextEnd}\n\n${sourceTextStart}`,
    "binary\0text",
  ])("rejects malformed local text without adopting it: %j", (text) => {
    expect(() => parseTextComposition(new TextEncoder().encode(text))).toThrow();
  });

  it("rejects invalid UTF-8 instead of replacing bytes", () => {
    expect(() => parseTextComposition(Uint8Array.of(0xff))).toThrow();
  });

  it.each([
    { content: "text", executable: true },
    { content: "text", mode: 0o610 },
    { content: "text", symlinkTo: "elsewhere" },
    { content: "binary\0text" },
    { content: "invalid\uD800" },
    { content: sourceTextStart },
    { content: sourceTextEnd },
  ])("rejects unsupported Source spec: %j", (spec) => {
    const resource = fileResource("instructions", {
      policy: "append-local", spec: { kind: "file", ...spec },
      verify: { method: "digest", digest: sha256Hex(spec.content) },
    });
    expect(() => Schema.decodeUnknownSync(ProfileResourceInputSchema)(resource)).toThrow();
    expect(validateProfileResources([resource]).map((error) => error._tag)).toContain("InvalidTextCompositionError");
  });

  it("accepts an opt-in ordinary text file and persists the Source baseline", () => {
    expect(Schema.decodeUnknownSync(ProfileResourceInputSchema)(fileResource("instructions", { policy: "append-local" })).policy)
      .toBe("append-local");
    const action = { kind: "write-file", target: "~/AGENTS.md", digest: digestA, previousSourceDigest: digestB };
    expect(Schema.decodeUnknownSync(ActionDetailSchema)(action)).toEqual(action);
  });
});

describe("profile schedule default portability", () => {
  interface CandidateScheduleDefault {
    readonly type: string;
    readonly at?: string | undefined;
    readonly days?: ReadonlyArray<string> | undefined;
    readonly expression?: string | undefined;
    readonly timezone: string;
  }

  /** Builds authoring input, including shapes the decoder must reject. */
  const profileWith = (scheduleDefault: CandidateScheduleDefault) => JSON.stringify({
    id: "workstation",
    version: 2,
    name: "Workstation",
    groups: [],
    resources: [],
    scheduleDefault,
  });

  it("accepts a daily default in the follower timezone", () => {
    expect(() =>
      decodeMachineProfileJsonc(
        profileWith({ type: "daily", at: "03:30", timezone: "local" }),
      )
    ).not.toThrow();
  });

  it.each([
    [{ type: "custom", expression: "*-*-* 03:30:00", timezone: "local" }, "custom calendar"],
    [{ type: "daily", at: "03:30", timezone: "Europe/Paris" }, "named timezone"],
  ])("rejects a default no follower backend can render: %s", (scheduleDefault) => {
    // launchd and Windows Task Scheduler refuse both at apply time. Accepting
    // them at publication only moved the discovery to a follower that then
    // silently ended up with no scheduled synchronization. A follower that
    // wants either sets it locally with `canonfig schedule set`.
    expect(() => decodeMachineProfileJsonc(profileWith(scheduleDefault))).toThrow();
  });
});

describe("agent install bounds", () => {
  interface CandidateBounds {
    readonly paths: ReadonlyArray<string>;
    readonly origins?: ReadonlyArray<string> | undefined;
  }

  /** Builds decoder input, including shapes the decoder must reject. */
  const toolWith = (agentInstall: CandidateBounds) => ({
    kind: "tool",
    toolId: "example",
    recipes: [],
    agentInstall,
  });

  it("accepts exact HTTPS origins", () => {
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({
        paths: ["~/.local/share/canonfig/tools/example"],
        origins: ["https://registry.npmjs.org"],
      }),
    );
    expect(Option.isSome(decoded)).toBe(true);
  });

  it.each([
    ["http://registry.npmjs.org", "cleartext"],
    ["https://registry.npmjs.org/", "trailing slash"],
    ["https://registry.npmjs.org/path", "path"],
    ["https://user:pass@registry.npmjs.org", "credentials"],
    ["registry.npmjs.org", "no scheme"],
  ])("rejects %s (%s)", (origin) => {
    // An origin the harness would filter out before execution cannot
    // authorize anything, so accepting it at publication only defers the
    // discovery to a follower that then reports bounds it does not have.
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({ paths: ["~/.local/bin/example"], origins: [origin] }),
    );
    expect(Option.isNone(decoded)).toBe(true);
  });

  it("requires at least one path", () => {
    const decoded = Schema.decodeUnknownOption(ResourceSpecInputSchema)(
      toolWith({ paths: [] }),
    );
    expect(Option.isNone(decoded)).toBe(true);
  });
});

describe("resource graph validation", () => {
  it("rejects duplicate resource ids precisely", () => {
    const errors = validateProfileResources([fileResource("x"), fileResource("x")]);
    expect(errors.filter((e) => e._tag === "DuplicateResourceError")).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    if (errors[0]?._tag === "DuplicateResourceError") {
      expect(errors[0].id).toBe("x");
    }
  });

  it("rejects missing dependencies with the exact missing id", () => {
    const errors = validateProfileResources([
      fileResource("a", { dependsOn: ["ghost"] }),
    ]);
    expect(errors).toHaveLength(1);
    if (errors[0]?._tag === "MissingDependencyError") {
      expect(errors[0].id).toBe("a");
      expect(errors[0].dependsOn).toBe("ghost");
    }
  });

  it("rejects dependency cycles with a cycle path", () => {
    const errors = validateProfileResources([
      fileResource("a", { dependsOn: ["b"] }),
      fileResource("b", { dependsOn: ["c"] }),
      fileResource("c", { dependsOn: ["a"] }),
    ]);
    const cycle = errors.find((e) => e._tag === "DependencyCycleError");
    expect(cycle).toBeDefined();
    if (cycle?._tag === "DependencyCycleError") {
      expect(cycle.cycle.length).toBeGreaterThanOrEqual(3);
      const [first, ...rest] = cycle.cycle;
      // The cycle closes by repeating its entry node.
      expect(rest[rest.length - 1]).toBe(first);
    }
  });

  it("rejects incompatible policy for a kind", () => {
    const errors = validateProfileResources([
      fileResource("a", { policy: "ensure" }),
    ]);
    expect(errors).toHaveLength(1);
    if (errors[0]?._tag === "PolicyKindMismatchError") {
      expect(errors[0].kind).toBe("file");
      expect(errors[0].policy).toBe("ensure");
    }
  });

  it.each(["mirror-owned", "merge"] as const)(
    "rejects unsupported file policy %s at the authoring schema boundary",
    (policy) => {
      expect(() => Schema.decodeUnknownSync(ProfileResourceInputSchema)({
        ...fileResource("unsupported"),
        policy,
      })).toThrow();
    },
  );

  it.each([
    {
      name: "regular file with symlink verification",
      spec: { kind: "file" as const, content: "hello" },
      verify: { method: "symlink" as const, target: "/tmp/target" },
    },
    {
      name: "regular file with executable verification",
      spec: { kind: "file" as const, content: "hello", executable: true },
      verify: { method: "executable-present" as const, executable: "hello" },
    },
    {
      name: "symlink file with digest verification",
      spec: {
        kind: "file" as const,
        content: "",
        symlinkTo: "/tmp/target",
      },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "symlink file with executable verification",
      spec: {
        kind: "file" as const,
        content: "",
        symlinkTo: "/tmp/target",
      },
      verify: { method: "executable-present" as const, executable: "target" },
    },
  ] as const)("rejects $name", ({ spec, verify }) => {
    const errors = validateProfileResources([fileResource("invalid", { spec, verify })]);
    expect(errors.map((error) => error._tag)).toEqual(["VerificationKindMismatchError"]);
  });

  it.each([
    {
      name: "regular",
      spec: { kind: "file" as const, content: "hello", executable: false },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "executable",
      spec: { kind: "file" as const, content: "hello", executable: true },
      verify: { method: "digest" as const, digest: sha256Hex("hello") },
    },
    {
      name: "symlink",
      spec: { kind: "file" as const, content: "", symlinkTo: "/tmp/target" },
      verify: { method: "symlink" as const, target: "/tmp/target" },
    },
  ] as const)("accepts valid $name file verification", ({ spec, verify }) => {
    expect(validateProfileResources([fileResource("valid", { spec, verify })])).toEqual([]);
  });

  it("accepts default policies for every kind", () => {
    const resources: Array<ProfileResourceInput> = [
      { id: "f", kind: "file", target: "~/f", spec: { kind: "file", content: "x" }, verify: { method: "digest", digest: sha256Hex("x") } },
      { id: "d", kind: "directory", target: "~/d", spec: { kind: "directory", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "c", kind: "config", target: "~/c.toml", spec: { kind: "config", format: "toml", keys: [{ path: "a.b", value: 1 }] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "s", kind: "skill", target: "~/skills/s", spec: { kind: "skill", name: "s", files: [] }, verify: { method: "digest", digest: "d".repeat(64) } },
      { id: "t", kind: "tool", target: "~", spec: { kind: "tool", toolId: "rg", recipes: [] }, verify: { method: "executable-present", executable: "rg" } },
      { id: "cr", kind: "credential", target: "~", spec: { kind: "credential", reference: "gh" }, verify: { method: "credential-present", reference: "gh" } },
    ];
    expect(validateProfileResources(resources)).toEqual([]);
  });

  it("rejects required build policies without complete reviewed bounds", () => {
    const errors = validateProfileResources([{
      id: "native-tool",
      kind: "tool",
      target: "~/.local/bin/native-tool",
      spec: {
        kind: "tool",
        toolId: "native-tool",
        recipes: [{
          platform: "linux",
          method: "npm",
          package: "native-tool",
          version: "1.0.0",
          buildPolicy: {
            mode: "required",
            reviewedBy: "reviewer",
            reviewedAt: "2026-08-16T00:00:00Z",
            executables: [],
            paths: [],
            origins: [],
            capabilities: [],
            steps: [],
          },
        }],
      },
      verify: { method: "executable-present", executable: "native-tool" },
    }]);
    expect(errors.map((error) => error._tag)).toContain("InvalidBuildPolicyError");
  });

  it("rejects invalid targets", () => {
    const errors = validateProfileResources([
      fileResource("a", { target: "~/../escape" }),
      fileResource("b", { target: "" }),
    ]);
    expect(errors.every((e) => e._tag === "InvalidTargetError")).toBe(true);
    expect(errors).toHaveLength(2);
  });

  it("rejects normalized and parent-child resource target conflicts", () => {
    const errors = validateProfileResources([
      fileResource("file", { target: "~/.config/canonfig" }),
      fileResource("alias", { target: "~/.config/./CANONFIG" }),
      {
        id: "directory",
        kind: "directory",
        target: "~/.config/skills",
        spec: {
          kind: "directory",
          files: [{ path: "SKILL.md", content: "managed" }],
        },
        verify: { method: "digest", digest: digestA },
      },
      fileResource("child", { target: "~/.config/skills/SKILL.md" }),
    ]);

    expect(errors.filter((error) =>
      error._tag === "ConflictingResourceTargetError"
    ).map((error) => [error.id, error.conflictsWith])).toEqual([
      ["alias", "file"],
      ["child", "directory"],
    ]);
  });

  it.each([
    {
      name: "duplicate entries",
      platform: "windows" as const,
      paths: ["a", "a"],
      expected: ["ConflictingResourceTargetError"],
    },
    {
      name: "file and descendant entries",
      platform: "windows" as const,
      paths: ["a", "a/b"],
      expected: ["ConflictingResourceTargetError"],
    },
    {
      name: "normalized aliases",
      platform: "windows" as const,
      paths: ["a/b", "a/./b"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "alternate separators",
      platform: "windows" as const,
      paths: ["a\\b"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "reserved Windows names",
      platform: "windows" as const,
      paths: ["CON.txt"],
      expected: ["InvalidTargetError"],
    },
    {
      name: "valid nested files",
      platform: "windows" as const,
      paths: ["nested/one.txt", "nested/deeper/two.txt"],
      expected: [],
    },
  ])("validates intra-resource $name deterministically", ({
    platform,
    paths,
    expected,
  }) => {
    const errors = validateProfileResources([{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        files: paths.map((path) => ({ path, content: path })),
      },
      verify: { method: "digest", digest: digestA },
    }], undefined, platform);
    expect(errors.map((error) => error._tag)).toEqual(expected);
  });

  it("validates explicit directory claims without rejecting their descendants", () => {
    const valid = validateProfileResources([{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        directories: [{ path: "nested", mode: 0o700 }],
        files: [{ path: "nested/file.txt", content: "managed" }],
      },
      verify: { method: "digest", digest: digestA },
    }]);
    expect(valid).toEqual([]);

    const invalid = validateProfileResources([{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        directories: [
          { path: "../escape", mode: 0o700 },
          { path: "collision", mode: 0o700 },
        ],
        files: [{ path: "collision", content: "managed" }],
      },
      verify: { method: "digest", digest: digestA },
    }]);
    expect(invalid.map((error) => error._tag)).toEqual([
      "InvalidTargetError",
      "ConflictingResourceTargetError",
    ]);
  });

  it("rejects filesystem modes that prevent deterministic verification", () => {
    const errors = validateProfileResources([
      {
        id: "file",
        kind: "file",
        target: "~/.canonfig/file",
        spec: { kind: "file", content: "managed", mode: 0o200 },
        verify: { method: "digest", digest: digestA },
      },
      {
        id: "tree",
        kind: "directory",
        target: "~/.canonfig/tree",
        spec: {
          kind: "directory",
          mode: 0o600,
          directories: [{ path: "locked", mode: 0o400 }],
          files: [{ path: "write-only.txt", content: "managed", mode: 0o200 }],
        },
        verify: { method: "digest", digest: digestA },
      },
      {
        id: "link",
        kind: "file",
        target: "~/.canonfig/link",
        spec: { kind: "file", content: "", mode: 0o000, symlinkTo: "target" },
        verify: { method: "symlink", target: "target" },
      },
    ]);

    expect(errors.filter((error) => error._tag === "UnmanageableFilesystemModeError"))
      .toMatchObject([
        { id: "file", path: "~/.canonfig/file", mode: 0o200 },
        { id: "tree", path: "~/.canonfig/tree", mode: 0o600 },
        { id: "tree", path: "locked", mode: 0o400 },
        { id: "tree", path: "write-only.txt", mode: 0o200 },
      ]);
  });

  it("applies case folding only on case-insensitive targets", () => {
    const resources: Array<ProfileResourceInput> = [{
      id: "tree",
      kind: "directory",
      target: "~/.canonfig/tree",
      spec: {
        kind: "directory",
        files: [
          { path: "Readme.md", content: "one" },
          { path: "README.md", content: "two" },
        ],
      },
      verify: { method: "digest", digest: digestA },
    }];
    expect(validateProfileResources(resources, undefined, "linux")).toEqual([]);
    expect(validateProfileResources(resources, undefined, "windows")
      .map((error) => error._tag)).toEqual(["ConflictingResourceTargetError"]);
  });

  it.each([
    { kind: "file" as const, symlinkTo: undefined },
    { kind: "file" as const, symlinkTo: "/outside/target" },
  ])("rejects a $kind resource parent claim before a descendant", ({ symlinkTo }) => {
    const parent = fileResource("parent", {
      target: "~/.canonfig/tree",
      spec: { kind: "file", content: "parent", symlinkTo },
    });
    const child = fileResource("child", {
      target: "~/.canonfig/tree/nested/file.txt",
    });
    expect(validateProfileResources([parent, child])
      .filter((error) => error._tag === "ConflictingResourceTargetError")
      .map((error) => [error.id, error.conflictsWith])).toEqual([
        ["child", "parent"],
      ]);
  });
});
