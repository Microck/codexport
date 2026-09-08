import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  BlobId,
  ContentDigest,
  FollowerId,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
} from "../src/domain/brand.ts";
import type { ProfileRevision, PublishedResource } from "../src/domain/profile.ts";
import type {
  ApplyPolicy,
  RecipeMethod,
  ResourceKind,
} from "../src/domain/resource.ts";
import type {
  AppliedResourceRecord,
  ObservedResourceState,
} from "../src/domain/synchronization.ts";
import { ObservedResourceStateSchema } from "../src/domain/synchronization.ts";
import {
  directoryEntriesDigest,
  sha256Hex,
} from "../src/profile/profile-codec.ts";
import {
  getConfigPath,
  parseConfigDocument,
  serializeConfigDocument,
  setConfigPath,
} from "../src/synchronization/config-codec.ts";
import { planSynchronization } from "../src/synchronization/planner.ts";
import { detectSkillDrift } from "../src/synchronization/resource-plans.ts";
import type {
  DesiredResource,
  SynchronizationPlannerInput,
} from "../src/synchronization/synchronization.types.ts";

const decode = Schema.decodeUnknownSync;
const digestA = decode(ContentDigest)("a".repeat(64));
const digestB = decode(ContentDigest)("b".repeat(64));
const digestC = decode(ContentDigest)("c".repeat(64));
const blobA = decode(BlobId)("d".repeat(64));
const blobB = decode(BlobId)("e".repeat(64));
const follower = decode(FollowerId)("follower-1");

describe("observed resource state schema", () => {
  it("preserves exact regular-file modes", () => {
    expect(decode(ObservedResourceStateSchema)({
      state: "present",
      digest: digestA,
      executable: true,
      mode: 0o750,
      objectKind: "regular",
    })).toMatchObject({ mode: 0o750 });
  });
});

const desiredForKind = (kind: ResourceKind): DesiredResource => {
  switch (kind) {
    case "file":
      return { kind, digest: digestA, executable: false, mode: 0o600 };
    case "directory":
      return {
        kind,
        mode: 0o700,
        directories: [],
        files: [{ path: "one.txt", digest: digestA, executable: false, mode: 0o600 }],
      };
    case "config":
      return {
        kind,
        digest: digestA,
        format: "json",
        keys: ["editor.theme", "mcp.github"],
      };
    case "skill":
      return {
        kind,
        digest: digestA,
        mode: 0o700,
        directories: [],
        files: [{ path: "SKILL.md", digest: digestA, executable: false, mode: 0o600 }],
      };
    case "tool":
      return {
        kind,
        toolId: "ripgrep",
        recipes: [{
          platform: "linux",
          method: "apt",
          package: "ripgrep",
          version: "14.1.0",
        }],
        loginRequired: false,
      };
    case "credential":
      return {
        kind,
        reference: "github-token",
        instructions: "Run canonfig credential set github-token, then retry.",
      };
  }
};

const verificationFor = (
  desired: DesiredResource,
) => {
  switch (desired.kind) {
    case "file":
      return desired.symlinkTo === undefined
        ? { method: "digest" as const, digest: digestA }
        : { method: "symlink" as const, target: desired.symlinkTo };
    case "config":
      return { method: "digest" as const, digest: digestA };
    case "directory":
    case "skill":
      return { method: "digest" as const, digest: digestA };
    case "tool":
      return { method: "executable-present" as const, executable: desired.toolId };
    case "credential":
      return { method: "credential-present" as const, reference: desired.reference };
  }
};

const resource = (
  id: string,
  kind: ResourceKind,
  policy: ApplyPolicy,
  dependencies: ReadonlyArray<string> = [],
  blobs: ReadonlyArray<string> = [],
): PublishedResource => ({
  id: decode(ResourceId)(id),
  kind,
  policy,
  target: `~/.canonfig/${id}`,
  dependsOn: dependencies.map((dependency) => decode(ResourceId)(dependency)),
  blobs: blobs.map((blob) => decode(BlobId)(blob)),
});

describe("configuration codecs", () => {
  it.each([
    ["json", "{\n  \"local\": true\n}\n"],
    ["toml", "local = true\n"],
    ["yaml", "local: true\n"],
  ] as const)("preserves local keys and applies dotted paths in %s", (format, source) => {
    const document = parseConfigDocument(format, source);
    setConfigPath(document, "agent.model", "review-model");
    const encoded = serializeConfigDocument(format, document);
    const decoded = parseConfigDocument(format, encoded);

    expect(getConfigPath(decoded, "local")).toBe(true);
    expect(getConfigPath(decoded, "agent.model")).toBe("review-model");
    expect(Object.hasOwn(decoded, "agent.model")).toBe(false);
  });
});

const revision = (resources: ReadonlyArray<PublishedResource>): ProfileRevision => ({
  id: decode(ProfileRevisionId)("revision-1"),
  profileId: decode(ProfileId)("profile-1"),
  sequence: 1,
  canonicalBytes: "{}",
  digest: digestA,
  signature: "test-signature",
  publishedAt: "2026-08-15T00:00:00Z",
  resources,
  groups: [],
});

const plannerInput = (
  resources: ReadonlyArray<PublishedResource>,
  options: {
    readonly desired?: ReadonlyArray<DesiredResource> | undefined;
    readonly observed?: ReadonlyArray<ObservedResourceState> | undefined;
    readonly applied?: ReadonlyArray<AppliedResourceRecord> | undefined;
    readonly availableBlobs?: ReadonlyArray<string> | undefined;
  } = {},
): SynchronizationPlannerInput => ({
  revision: {
    ...revision(resources),
    desired: resources.map((entry, index) => ({
      resource: entry.id,
      desired: options.desired?.[index] ?? desiredForKind(entry.kind),
      verification: verificationFor(options.desired?.[index] ?? desiredForKind(entry.kind)),
    })),
    blobs: [
      { id: blobA, bytes: 100 },
      { id: blobB, bytes: 200 },
    ],
  },
  follower,
  observedState: {
    platform: "linux",
    resources: resources.map((entry, index) => ({
      resource: entry.id,
      observed: options.observed?.[index] ?? { state: "absent" },
    })),
    availableBlobs: (options.availableBlobs ?? []).map((blob) => decode(BlobId)(blob)),
  },
  localOverlay: [],
  appliedResources: options.applied ?? [],
});

const runPlan = (input: SynchronizationPlannerInput) =>
  Effect.runSync(planSynchronization(input));

describe("resource and Apply Policy coverage", () => {
  const cases: ReadonlyArray<{
    readonly kind: ResourceKind;
    readonly policy: ApplyPolicy;
    readonly action: string;
  }> = [
    { kind: "file", policy: "replace", action: "write-file" },
    { kind: "file", policy: "replace-if-unmodified", action: "write-file" },
    { kind: "directory", policy: "mirror-owned", action: "mirror-directory" },
    { kind: "directory", policy: "replace", action: "mirror-directory" },
    { kind: "config", policy: "merge", action: "write-config" },
    { kind: "config", policy: "replace", action: "write-file" },
    { kind: "skill", policy: "replace-if-unmodified", action: "mirror-directory" },
    { kind: "skill", policy: "replace", action: "mirror-directory" },
    { kind: "tool", policy: "ensure", action: "install-tool" },
    { kind: "credential", policy: "require-local", action: "human-action" },
  ];

  for (const entry of cases) {
    it(`plans ${entry.kind}/${entry.policy}`, () => {
      const plan = runPlan(plannerInput([
        resource("subject", entry.kind, entry.policy),
      ]));
      expect(plan.actions.map((action) => action.kind)).toEqual([entry.action]);
    });
  }

  it.each(["mirror-owned", "merge"] as const)(
    "rejects unsupported file policy %s before planning",
    (policy) => {
      const error = Effect.runSync(Effect.flip(planSynchronization(
        plannerInput([resource("file", "file", policy)]),
      )));
      expect(error._tag).toBe("PlannerPolicyKindMismatchError");
    },
  );

  it("produces an explicit no-op when desired state is already present", () => {
    const plan = runPlan(plannerInput(
      [resource("file", "file", "replace")],
      { observed: [{ state: "present", digest: digestA, executable: false }] },
    ));
    expect(plan.actions[0]?.detail).toEqual({ kind: "no-op" });
  });

  it("observes empty directory roots directly", () => {
    const desired: DesiredResource = {
      kind: "directory",
      mode: 0o700,
      directories: [],
      files: [],
    };
    const observed = {
      state: "directory" as const,
      objectKind: "directory" as const,
      mode: 0o700,
      files: [],
    };
    const existing = runPlan(plannerInput(
      [resource("empty", "directory", "replace")],
      { desired: [desired], observed: [observed] },
    ));
    expect(existing.actions.map((action) => action.kind)).toEqual(["no-op"]);

    const missing = runPlan(plannerInput(
      [resource("empty", "directory", "replace")],
      { desired: [desired] },
    ));
    expect(missing.actions.map((action) => action.kind)).toEqual(["mirror-directory"]);
  });

  it("plans absent directory members as additions without treating them as drift", () => {
    const subject = resource("missing-member", "directory", "mirror-owned");
    const desired: DesiredResource = {
      kind: "directory",
      mode: 0o700,
      directories: [],
      files: [{ path: "new.txt", digest: digestA, executable: false, mode: 0o600 }],
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "directory",
        mode: 0o700,
        files: [{ path: "new.txt", state: "absent" }],
      }],
    }));

    expect(plan.actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: ["new.txt"],
      removes: [],
    });
  });

  it("does not remove an already-missing previously owned member", () => {
    const subject = resource("missing-owned", "directory", "mirror-owned");
    const previous = { path: "owned.txt", digest: digestA, executable: false };
    const plan = runPlan(plannerInput([subject], {
      desired: [{ kind: "directory", mode: 0o700, directories: [], files: [] }],
      observed: [{
        state: "directory",
        mode: 0o700,
        files: [{ path: "owned.txt", state: "absent" }],
      }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: [previous],
      }],
    }));

    expect(plan.actions.map((action) => action.kind)).toEqual(["no-op"]);
  });

  it("preserves an unverifiable directory observation as drift", () => {
    const subject = resource("mixed-error", "directory", "mirror-owned");
    const plan = runPlan(plannerInput([subject], {
      observed: [{
        state: "unverifiable",
        reason: "permission denied: unreadable member",
      }],
    }));

    expect(plan.actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
  });

  it("plans a non-directory root as drift instead of applying a mirror", () => {
    const desired: DesiredResource = {
      kind: "directory",
      mode: 0o700,
      directories: [],
      files: [],
    };
    const plan = runPlan(plannerInput(
      [resource("root-conflict", "directory", "replace")],
      {
        desired: [desired],
        observed: [{
          state: "present",
          objectKind: "regular",
          digest: digestA,
          executable: false,
        }],
      },
    ));
    expect(plan.actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
  });

  it.each(["directory", "skill"] as const)(
    "preserves implicit parent directories when replacing a %s",
    (kind) => {
      const subject = resource("tree", kind, "replace");
      const input = plannerInput([subject], {
        desired: [{
          kind,
          digest: digestA,
          directories: [],
          files: [{ path: "references/nested/keep.md", digest: digestA }],
        }],
        observed: [{
          state: "directory",
          files: [
            { path: "references", digest: sha256Hex("canonfig:directory"), objectKind: "directory" },
            { path: "references/nested", digest: sha256Hex("canonfig:directory"), objectKind: "directory" },
            { path: "references/nested/keep.md", digest: digestB, objectKind: "regular" },
            { path: "obsolete", digest: sha256Hex("canonfig:directory"), objectKind: "directory" },
            { path: "obsolete/drop.md", digest: digestB, objectKind: "regular" },
          ],
        }],
      });
      const plan = runPlan(input);
      expect(plan.actions[0]?.detail).toMatchObject({
        kind: "mirror-directory",
        adds: ["references/nested/keep.md"],
        removes: ["obsolete", "obsolete/drop.md"],
      });
      const converged = runPlan({
        ...input,
        observedState: {
          ...input.observedState,
          resources: [{
            resource: subject.id,
            observed: {
              state: "directory",
              files: [
                { path: "references", digest: sha256Hex("canonfig:directory"), objectKind: "directory" },
                { path: "references/nested", digest: sha256Hex("canonfig:directory"), objectKind: "directory" },
                { path: "references/nested/keep.md", digest: digestA, objectKind: "regular" },
              ],
            },
          }],
        },
      });
      expect(converged.actions.map((action) => action.kind)).toEqual(["no-op"]);
    },
  );

  it("treats an exact relative symlink as converged", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [{
        path: "link",
        digest: digestA,
        executable: true,
        mode: 0o777,
        symlinkTo: "../target",
      }],
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "directory",
        mode: 0o700,
        files: [{
          path: "link",
          digest: digestA,
          executable: false,
          objectKind: "symlink",
          symlinkTo: "../target",
        }],
      }],
    }));

    expect(plan.actions.map((action) => action.kind)).toEqual(["no-op"]);
  });

  it("plans exact member and root permission changes", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o750,
      directories: [],
      files: [{
        path: "settings.json",
        digest: digestA,
        executable: false,
        mode: 0o600,
      }],
    };
    const memberMode = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "directory",
        mode: desired.mode,
        files: [{
          path: "settings.json",
          digest: digestA,
          executable: false,
          mode: 0o640,
          objectKind: "regular",
        }],
      }],
    }));
    expect(memberMode.actions[0]?.detail).toMatchObject({
      kind: "mirror-directory",
      adds: ["settings.json"],
      removes: [],
    });

    const rootMode = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "directory",
        mode: 0o700,
        files: [{
          path: "settings.json",
          digest: digestA,
          executable: false,
          mode: 0o600,
          objectKind: "regular",
        }],
      }],
    }));
    expect(rootMode.actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: [],
    });
  });

  it.each([
    {
      name: "regular to executable",
      desiredExecutable: true,
      observedExecutable: false,
      appliedExecutable: false,
      action: "write-file",
    },
    {
      name: "executable to regular",
      desiredExecutable: false,
      observedExecutable: true,
      appliedExecutable: true,
      action: "write-file",
    },
    {
      name: "local executable drift",
      desiredExecutable: false,
      observedExecutable: true,
      appliedExecutable: false,
      action: "drift-conflict",
    },
    {
      name: "matching executable intent",
      desiredExecutable: true,
      observedExecutable: true,
      appliedExecutable: true,
      action: "no-op",
    },
  ] as const)("plans same-byte executable mode state: $name", ({
    desiredExecutable,
    observedExecutable,
    appliedExecutable,
    action,
  }) => {
    const subject = resource("file", "file", "replace-if-unmodified");
    const desired = {
      kind: "file" as const,
      digest: digestA,
      executable: desiredExecutable,
    };
    const planned = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "present",
        digest: digestA,
        executable: observedExecutable,
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "file",
        policy: "replace-if-unmodified",
        target: subject.target,
        executable: appliedExecutable,
      }],
    }));
    expect(planned.actions[0]?.kind).toBe(action);
    if (action === "write-file") {
      expect(planned.actions[0]?.detail).toMatchObject({
        executable: desiredExecutable,
      });
    }
    if (action === "drift-conflict") {
      expect(planned.actions[0]?.detail).toMatchObject({
        desiredExecutable,
        observedExecutable,
      });
    }
  });

  it("treats a same-byte exact mode change as remote intent", () => {
    expect(detectSkillDrift({
      desiredDigest: digestA,
      observedDigest: digestA,
      lastAppliedDigest: digestA,
      desiredMode: 0o644,
      observedMode: 0o600,
      lastAppliedMode: 0o600,
    })).toBe("remote-only");
  });

  it("does not remove a file whose exact mode changed after apply", () => {
    const subject = resource("removed-file", "file", "replace");
    const input = plannerInput([subject], {
      desired: [{
        kind: "file",
        digest: digestA,
        executable: false,
        mode: 0o600,
      }],
      observed: [{
        state: "present",
        digest: digestA,
        executable: false,
        mode: 0o640,
        objectKind: "regular",
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "file",
        policy: "replace",
        target: subject.target,
        executable: false,
        mode: 0o600,
      }],
    });
    const plan = runPlan({
      ...input,
      revision: {
        ...input.revision,
        removedResources: [subject.id],
      },
    });
    expect(plan.actions).toEqual([]);
  });

  it("ignores meaningless symlink modes for drift and removal safety", () => {
    const subject = resource("managed-link", "file", "replace-if-unmodified");
    const desired = {
      kind: "file" as const,
      digest: digestA,
      executable: false,
      mode: 0o600,
      symlinkTo: "../target",
    };
    const applied = {
      resource: subject.id,
      revision: "previous",
      digest: digestA,
      appliedAt: "2026-08-15T00:00:00Z",
      kind: "file" as const,
      policy: "replace-if-unmodified" as const,
      target: subject.target,
      executable: false,
      mode: 0o600,
      symlinkTo: "../target",
    };
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "present",
        digest: digestA,
        executable: false,
        objectKind: "symlink",
        symlinkTo: "../target",
      }],
      applied: [applied],
    });

    expect(runPlan(input).actions[0]?.kind).toBe("no-op");
    expect(runPlan({
      ...input,
      revision: { ...input.revision, removedResources: [subject.id] },
    }).actions[0]?.kind).toBe("remove-resource");
  });

  it("applies a remote-only skill root mode change", () => {
    const subject = resource("skill-mode", "skill", "replace-if-unmodified");
    const treeDigest = directoryEntriesDigest([{
      path: "SKILL.md",
      digest: digestA,
      executable: false,
      mode: 0o600,
      objectKind: "regular",
    }]);
    const desired = {
      kind: "skill" as const,
      digest: treeDigest,
      mode: 0o750,
      directories: [],
      files: [{ path: "SKILL.md", digest: digestA, executable: false, mode: 0o600 }],
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "directory",
        mode: 0o700,
        objectKind: "directory",
        files: [{
          path: "SKILL.md",
          digest: digestA,
          executable: false,
          mode: 0o600,
          objectKind: "regular",
        }],
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: treeDigest,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "skill",
        policy: "replace-if-unmodified",
        target: subject.target,
        mode: 0o700,
      }],
    }));

    expect(plan.actions[0]?.kind).toBe("mirror-directory");
  });

  it.each([
    ["file", "file"],
    ["skill", "skill"],
  ] as const)(
    "reinstalls a missing previously applied %s under replace-if-unmodified",
    (_name, kind) => {
      // Absence is not a local edit. Refusing to reinstall meant deleting a
      // managed skill stopped every run forever with `is missing or
      // unverifiable`, and Canonfig would never put it back.
      const subject = resource(kind, kind, "replace-if-unmodified");
      const plan = runPlan(plannerInput([subject], {
        desired: [desiredForKind(kind)],
        observed: [{ state: "absent" }],
        applied: [{
          resource: subject.id,
          revision: "previous",
          digest: digestA,
          appliedAt: "2026-08-15T00:00:00Z",
          kind,
          policy: "replace-if-unmodified",
          target: subject.target,
        }],
      }));
      expect(plan.actions.map((action) => action.kind)).toEqual([
        kind === "skill" ? "mirror-directory" : "write-file",
      ]);
      expect(plan.actions[0]?.detail).toMatchObject(kind === "skill"
        ? { kind: "mirror-directory", target: subject.target, adds: ["SKILL.md"], removes: [] }
        : { kind: "write-file", target: subject.target, digest: digestA });
    },
  );

  it.each([
    ["file", "file"],
    ["skill", "skill"],
  ] as const)(
    "still refuses to overwrite an unverifiable %s under replace-if-unmodified",
    (_name, kind) => {
      // Something is there and Canonfig cannot read it, which is a different
      // case from nothing being there at all.
      const subject = resource(kind, kind, "replace-if-unmodified");
      const plan = runPlan(plannerInput([subject], {
        desired: [desiredForKind(kind)],
        observed: [{ state: "unverifiable", reason: "permission denied" }],
        applied: [{
          resource: subject.id,
          revision: "previous",
          digest: digestA,
          appliedAt: "2026-08-15T00:00:00Z",
          kind,
          policy: "replace-if-unmodified",
          target: subject.target,
        }],
      }));
      // A skill reports this as drift, a file as a human action. Either way
      // Canonfig refuses to write over something it cannot read.
      expect(plan.actions.map((action) => action.kind)).toEqual([
        kind === "skill" ? "drift-conflict" : "human-action",
      ]);
      expect(plan.actions.some((action) =>
        action.kind === "write-file" || action.kind === "mirror-directory"
      )).toBe(false);
    },
  );

  it("reports a missing applied skill member as drift without rewriting the skill", () => {
    const subject = resource("skill", "skill", "replace-if-unmodified");
    const desired = {
      kind: "skill" as const,
      digest: digestA,
      mode: 0o700,
      directories: [],
      files: [{ path: "SKILL.md", digest: digestA, executable: false, mode: 0o600 }],
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", mode: 0o700, files: [] }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: desired.digest,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "skill",
        policy: "replace-if-unmodified",
        target: subject.target,
        ownedFiles: desired.files,
      }],
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual(["drift-conflict"]);
    expect(plan.actions.some((action) => action.kind === "mirror-directory")).toBe(false);
  });

  it.each([
    ["symlink", "replace"],
    ["directory", "replace"],
    ["special", "replace"],
    ["symlink", "replace-if-unmodified"],
  ] as const)(
    "does not converge a %s at a regular-file target under %s",
    (objectKind, policy) => {
      const subject = resource("file", "file", policy);
      const plan = runPlan(plannerInput([subject], {
        observed: [{
          state: "present",
          digest: digestA,
          executable: false,
          objectKind,
          symlinkTo: objectKind === "symlink" ? "/outside" : undefined,
        }],
        applied: policy === "replace-if-unmodified"
          ? [{
            resource: subject.id,
            revision: "previous",
            digest: digestA,
            appliedAt: "2026-08-15T00:00:00Z",
            kind: "file",
            policy,
            target: subject.target,
            executable: false,
          }]
          : [],
      }));
      expect(plan.actions[0]?.kind).not.toBe("no-op");
      expect(plan.actions[0]?.kind).toBe(
        policy === "replace-if-unmodified" ? "drift-conflict" : "write-file",
      );
    },
  );

  it("preserves non-conflicting Local Overlay keys and reports conflicts", () => {
    const base = plannerInput([resource("config", "config", "merge")]);
    const preserved = runPlan({
      ...base,
      localOverlay: [{ resource: decode(ResourceId)("config"), keys: ["local.theme"] }],
    });
    expect(preserved.actions[0]?.kind).toBe("write-config");

    const conflict = runPlan({
      ...base,
      localOverlay: [{ resource: decode(ResourceId)("config"), keys: ["mcp.github"] }],
    });
    expect(conflict.actions[0]?.kind).toBe("human-action");
  });

  it("removes unchanged files recorded as owned by the previous revision", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [{ path: "kept.txt", digest: digestA, executable: false, mode: 0o600 }],
    };
    const previouslyOwned = [
      { path: "kept.txt", digest: digestA, executable: false, mode: 0o600 },
      { path: "removed.txt", digest: digestB, executable: false, mode: 0o600 },
    ];
    const previousDigest = decode(ContentDigest)(sha256Hex(
      previouslyOwned
        .map((file) => `${file.path}\0${file.digest}\0-`)
        .join("\n"),
    ));
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", mode: 0o700, files: previouslyOwned }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: previousDigest,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: previouslyOwned.map(({ path, digest, mode }) => ({
          path,
          digest,
          mode,
        })),
      }],
    });

    const plan = runPlan(input);
    expect(plan.actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: ["removed.txt"],
    });
  });

  it("preserves an owned directory that contains desired descendants", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [{
        path: "locked/keep.txt",
        digest: digestA,
        executable: false,
        mode: 0o600,
      }],
    };
    const previouslyOwned = [
      {
        path: "locked",
        digest: sha256Hex("canonfig:directory"),
        executable: true,
        mode: 0o500,
        objectKind: "directory" as const,
      },
      {
        path: "locked/keep.txt",
        digest: digestA,
        executable: false,
        mode: 0o600,
      },
      {
        path: "locked/obsolete.txt",
        digest: digestB,
        executable: false,
        mode: 0o600,
      },
    ];
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", mode: 0o700, files: previouslyOwned }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: previouslyOwned,
      }],
    });

    expect(runPlan(input).actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: ["locked/obsolete.txt"],
    });
  });

  it("removes an owned regular file that blocks a desired descendant", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [{
        path: "blocked/value.txt",
        digest: digestA,
        executable: false,
        mode: 0o600,
      }],
    };
    const blockingFile = {
      path: "blocked",
      digest: digestB,
      executable: false,
      mode: 0o600,
      objectKind: "regular" as const,
    };
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", mode: 0o700, files: [blockingFile] }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: digestB,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: [blockingFile],
      }],
    });

    expect(runPlan(input).actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: ["blocked/value.txt"],
      removes: ["blocked"],
    });
  });

  it("evaluates mirror removal ownership and drift per file", () => {
    const subject = resource("directory", "directory", "mirror-owned");
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [{ path: "kept.txt", digest: digestA, executable: false, mode: 0o600 }],
    };
    const observed = [
      { path: "kept.txt", digest: digestA, executable: false, mode: 0o600 },
      { path: "clean.txt", digest: digestB, executable: false, mode: 0o600 },
      { path: "modified.txt", digest: digestC, executable: false, mode: 0o600 },
      { path: "unowned.txt", digest: digestC, executable: false, mode: 0o600 },
    ];
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{ state: "directory", mode: 0o700, files: observed }],
      applied: [{
        resource: subject.id,
        revision: "revision-previous",
        digest: digestA,
        appliedAt: "2026-08-15T00:00:00Z",
        ownedFiles: [
          { path: "kept.txt", digest: digestA, mode: 0o600 },
          { path: "clean.txt", digest: digestB, mode: 0o600 },
          { path: "modified.txt", digest: digestB, mode: 0o600 },
        ],
      }],
    });

    expect(runPlan(input).actions[0]?.detail).toEqual({
      kind: "mirror-directory",
      target: subject.target,
      adds: [],
      removes: ["clean.txt"],
    });
  });
});

describe("transfer and apply separation", () => {
  it("requires each missing blob once even when multiple resources reuse it", () => {
    const resources = [
      resource("a", "file", "replace", [], [blobA]),
      resource("b", "file", "replace", [], [blobA, blobB]),
    ];
    const plan = runPlan(plannerInput(resources));
    expect(plan.requiredBlobs).toEqual([blobA, blobB]);
    expect(plan.actions.filter((action) => action.kind === "transfer-blob")).toHaveLength(2);
    expect(plan.actions.filter((action) => action.kind === "write-file")).toHaveLength(2);
  });

  it("prunes a config key the revision no longer declares", () => {
    // A merge config that declared canonical.removed and then dropped it left
    // the key on the follower with its old value, and the plan read no-op.
    // Only removing the whole resource ever removed an owned key.
    const subject = resource("settings", "config", "merge");
    const desired = desiredForKind("config");
    const plan = runPlan(plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "present",
        digest: digestB,
        executable: false,
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: digestB,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "config",
        policy: "merge",
        target: subject.target,
        ownedKeys: [...(desired.kind === "config" ? desired.keys : []), "canonical.removed"],
      }],
    }));

    expect(plan.actions.map((action) => action.kind)).toEqual(["write-config"]);
    expect(plan.actions[0]?.detail).toMatchObject({
      kind: "write-config",
      removes: ["canonical.removed"],
    });
  });

  it("keeps a dropped config key the follower claimed in its Local Overlay", () => {
    // A key the follower claimed is the follower's, not Canonfig's, so it
    // survives the profile dropping it.
    const subject = resource("settings", "config", "merge");
    const desired = desiredForKind("config");
    const input = plannerInput([subject], {
      desired: [desired],
      observed: [{
        state: "present",
        digest: digestB,
        executable: false,
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: digestB,
        appliedAt: "2026-08-15T00:00:00Z",
        kind: "config",
        policy: "merge",
        target: subject.target,
        ownedKeys: [...(desired.kind === "config" ? desired.keys : []), "canonical.removed"],
      }],
    });
    const plan = runPlan({
      ...input,
      localOverlay: [{ resource: subject.id, keys: ["canonical.removed"] }],
    });

    // The write still happens for the declared keys, but the claimed key is
    // not pruned.
    expect(plan.actions.map((action) => action.kind)).toEqual(["write-config"]);
    expect(plan.actions[0]?.detail).not.toMatchObject({
      removes: expect.arrayContaining(["canonical.removed"]),
    });
  });

  it("plans two resources whose content is identical", () => {
    // A blob's id is the digest of its content, so two resources with the same
    // published specification share one blob. The planner rejected the repeat,
    // which made every plan fail for such a profile and left the follower
    // unable to converge or to remove anything.
    const resources = [
      resource("a-file", "file", "replace", [], [blobA]),
      resource("c-file", "file", "replace", [], [blobA]),
    ];
    const input = plannerInput(resources);
    const planned = Effect.runSync(planSynchronization({
      ...input,
      revision: {
        ...input.revision,
        blobs: [
          { id: blobA, bytes: 100 },
          { id: blobA, bytes: 100 },
          { id: blobB, bytes: 200 },
        ],
      },
    }));

    // The shared blob transfers once and both files are written from it, which
    // is the point of addressing a blob by its content.
    expect(planned.actions.map((action) => `${action.resource}:${action.kind}`)).toEqual([
      "a-file:transfer-blob",
      "a-file:write-file",
      "c-file:write-file",
    ]);
  });

  it("rejects one blob id claiming two different sizes", () => {
    // Two different contents cannot share a digest, so this is an integrity
    // problem rather than the sharing above.
    const input = plannerInput([resource("a-file", "file", "replace", [], [blobA])]);
    const error = Effect.runSync(Effect.flip(planSynchronization({
      ...input,
      revision: {
        ...input.revision,
        blobs: [
          { id: blobA, bytes: 100 },
          { id: blobA, bytes: 101 },
        ],
      },
    })));

    expect(error._tag).toBe("DuplicatePlannerInputError");
  });

  it("reuses cached blobs without changing Apply Policy behavior", () => {
    const subject = resource("file", "file", "replace", [], [blobA]);
    const plan = runPlan(plannerInput(
      [subject],
      {
        observed: [{ state: "present", digest: digestA, executable: false }],
        availableBlobs: [blobA],
      },
    ));
    expect(plan.requiredBlobs).toEqual([]);
    expect(plan.actions.map((action) => action.kind)).toEqual(["no-op"]);
  });

  it("still transfers a missing blob when apply is a no-op", () => {
    const subject = resource("file", "file", "replace", [], [blobA]);
    const plan = runPlan(plannerInput(
      [subject],
      { observed: [{ state: "present", digest: digestA, executable: false }] },
    ));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "transfer-blob",
      "no-op",
    ]);
    expect(plan.actions[1]?.before).toEqual([`transfer:${blobA}`]);
  });

  it.each([
    ["duplicate", ["a", "a"], "PlannerConflictingResourcePathError"],
    ["file-parent", ["a", "a/b"], "PlannerConflictingResourcePathError"],
    ["normalized-alias", ["a/./b"], "PlannerInvalidResourcePathError"],
  ] as const)("rejects an intra-resource %s before creating actions", (
    _name,
    paths,
    expectedTag,
  ) => {
    const subject = resource("tree", "directory", "mirror-owned", [], [blobA]);
    const base = plannerInput([subject], {
      desired: [{
        kind: "directory",
        mode: 0o700,
        directories: [],
        files: paths.map((path) => ({
          path,
          digest: digestA,
          executable: false,
          mode: 0o600,
        })),
      }],
    });
    const error = Effect.runSync(Effect.flip(planSynchronization(base)));
    expect(error._tag).toBe(expectedTag);
  });

  it("uses the follower platform case rules before planning a mirror", () => {
    const subject = resource("tree", "directory", "mirror-owned", [], [blobA]);
    const desired = {
      kind: "directory" as const,
      mode: 0o700,
      directories: [],
      files: [
        { path: "Readme.md", digest: digestA, executable: false, mode: 0o600 },
        { path: "README.md", digest: digestB, executable: false, mode: 0o600 },
      ],
    };
    const linuxInput = plannerInput([subject], { desired: [desired] });
    expect(runPlan(linuxInput).actions.map((action) => action.kind))
      .toEqual(["transfer-blob", "mirror-directory"]);
    const windowsInput = {
      ...linuxInput,
      observedState: { ...linuxInput.observedState, platform: "windows" as const },
    };
    const error = Effect.runSync(Effect.flip(planSynchronization(windowsInput)));
    expect(error._tag).toBe("PlannerConflictingResourcePathError");
    expect(error).toMatchObject({ resource: "tree", conflictsWith: "tree" });
  });

  it("rejects missing metadata for a required blob", () => {
    const input = plannerInput([
      resource("file", "file", "replace", [], [digestC]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("MissingBlobMetadataError");
  });
});

describe("dependency ordering", () => {
  it("topologically orders resources and action prerequisites deterministically", () => {
    const resources = [
      resource("leaf", "file", "replace", ["middle"]),
      resource("root", "file", "replace"),
      resource("middle", "file", "replace", ["root"]),
    ];
    const plan = runPlan(plannerInput(resources));
    expect(plan.actions.map((action) => action.resource)).toEqual([
      "root",
      "middle",
      "leaf",
    ]);
    expect(plan.actions[1]?.before).toEqual([plan.actions[0]?.id]);
    expect(plan.actions[2]?.before).toEqual([plan.actions[1]?.id]);
  });

  it("rejects missing resource dependencies", () => {
    const input = plannerInput([
      resource("leaf", "file", "replace", ["missing"]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("PlannerMissingDependencyError");
  });

  it("rejects resource dependency cycles", () => {
    const input = plannerInput([
      resource("a", "file", "replace", ["b"]),
      resource("b", "file", "replace", ["a"]),
    ]);
    const error = Effect.runSync(Effect.flip(planSynchronization(input)));
    expect(error._tag).toBe("PlannerDependencyCycleError");
    if (error._tag === "PlannerDependencyCycleError") {
      expect(error.cycle).toEqual(["a", "b", "a"]);
    }
  });
});

describe("three-way skill drift", () => {
  it.each([
    { name: "Source path move", desiredPath: "new/SKILL.md", declaredParent: false, observedMode: 0o700, observedDigest: digestA, action: "mirror-directory" },
    { name: "Source declares an implicit parent", desiredPath: "old/SKILL.md", declaredParent: false, observedMode: 0o700, observedDigest: digestA, action: "mirror-directory" },
    { name: "local file edit", desiredPath: "new/SKILL.md", declaredParent: false, observedMode: 0o700, observedDigest: digestB, action: "drift-conflict" },
    { name: "local declared-directory mode edit", desiredPath: "new/SKILL.md", declaredParent: true, observedMode: 0o755, observedDigest: digestA, action: "drift-conflict" },
  ])("handles $name against the correct tree", (entry) => {
    const subject = resource("skill", "skill", "replace-if-unmodified");
    const parent = { path: "old", digest: sha256Hex("canonfig:directory"), objectKind: "directory" as const, mode: 0o700, executable: true };
    const appliedFile = { path: "old/SKILL.md", digest: digestA, objectKind: "regular" as const, mode: 0o600, executable: false };
    const ownedFiles = [...(entry.declaredParent ? [parent] : []), appliedFile];
    const plan = runPlan(plannerInput([subject], {
      desired: [{
        kind: "skill",
        digest: digestB,
        mode: 0o700,
        directories: entry.desiredPath === "old/SKILL.md" ? [{ path: "old", mode: 0o750 }] : [],
        files: [{ ...appliedFile, path: entry.desiredPath }],
      }],
      observed: [{
        state: "directory",
        objectKind: "directory",
        mode: 0o700,
        files: [{ ...parent, mode: entry.observedMode }, { ...appliedFile, digest: entry.observedDigest }],
      }],
      applied: [{
        resource: subject.id,
        revision: "previous",
        digest: directoryEntriesDigest(ownedFiles),
        ownedFiles,
        mode: 0o700,
        appliedAt: "2026-08-14T00:00:00Z",
      }],
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual([entry.action]);
  });

  const cases = [
    {
      name: "unchanged",
      desired: digestA,
      observed: digestA,
      applied: digestA,
      expected: "unchanged",
      action: "no-op",
    },
    {
      name: "local-only",
      desired: digestA,
      observed: digestB,
      applied: digestA,
      expected: "local-only",
      action: "drift-conflict",
    },
    {
      name: "remote-only",
      desired: digestB,
      observed: digestA,
      applied: digestA,
      expected: "remote-only",
      action: "mirror-directory",
    },
    {
      name: "converged",
      desired: digestB,
      observed: digestB,
      applied: digestA,
      expected: "converged",
      action: "no-op",
    },
    {
      name: "conflicting",
      desired: digestC,
      observed: digestB,
      applied: digestA,
      expected: "conflicting",
      action: "drift-conflict",
    },
  ] as const;

  for (const entry of cases) {
    it.each(["SKILL.md", "references/SKILL.md"])(`distinguishes ${entry.name} skill state at %s`, (path) => {
      expect(detectSkillDrift({
        desiredDigest: entry.desired,
        observedDigest: entry.observed,
        lastAppliedDigest: entry.applied,
      })).toBe(entry.expected);
      const subject = resource("skill", "skill", "replace-if-unmodified");
      const treeDigest = (digest: typeof digestA) => directoryEntriesDigest([{
        path,
        digest,
        executable: false,
        mode: 0o600,
        objectKind: "regular",
      }]);
      const plan = runPlan(plannerInput(
        [subject],
        {
          desired: [{
            kind: "skill",
            digest: entry.desired,
            mode: 0o700,
            directories: [],
            files: [{
              path,
              digest: entry.desired,
              executable: false,
              mode: 0o600,
            }],
          }],
          observed: [{
            state: "directory",
            mode: 0o700,
            objectKind: "directory",
            files: [...(path.includes("/") ? [{
              path: "references",
              digest: sha256Hex("canonfig:directory"),
              objectKind: "directory" as const,
              mode: 0o700,
              executable: true,
            }] : []), {
              path,
              digest: entry.observed,
              executable: false,
              mode: 0o600,
              objectKind: "regular",
            }],
          }],
          applied: [{
            resource: subject.id,
            revision: "previous",
            digest: treeDigest(entry.applied),
            ownedFiles: [{ path, digest: entry.applied, executable: false, mode: 0o600, objectKind: "regular" }],
            appliedAt: "2026-08-14T00:00:00Z",
          }],
        },
      ));
      expect(plan.actions.map((action) => action.kind)).toEqual([entry.action]);
      if (entry.action === "drift-conflict") {
        expect(plan.actions.some((action) => action.kind === "write-file")).toBe(false);
      }
    });
  }
});

describe("stable planning and bounded resolution", () => {
  it("is invariant to every unordered input collection", () => {
    const resources = [
      resource("b", "config", "merge", ["a"], [blobB]),
      resource("a", "file", "replace", [], [blobA]),
    ];
    const input = plannerInput(resources);
    const first = runPlan(input);
    const second = runPlan({
      ...input,
      revision: {
        ...input.revision,
        resources: [...input.revision.resources].reverse(),
        desired: [...input.revision.desired].reverse(),
        blobs: [...input.revision.blobs].reverse(),
      },
      observedState: {
        ...input.observedState,
        resources: [...input.observedState.resources].reverse(),
        availableBlobs: [...input.observedState.availableBlobs].reverse(),
      },
      appliedResources: [...input.appliedResources].reverse(),
    });
    expect(second).toEqual(first);
    expect(first.digest).toBe(sha256Hex(first.encoded));
  });

  it("refuses to invent bounds for a tool that declares none", () => {
    // The task used to be given the resource target as its only writable path,
    // which for a tool is the bare executable name, and no origins at all, so
    // the controlled executor could authorize no install action and the task
    // could only succeed if the tool was already present.
    const subject: PublishedResource = {
      ...resource("mac-only", "tool", "ensure"),
      target: "mac-only",
    };
    const plan = runPlan(plannerInput([subject], {
      desired: [{
        kind: "tool",
        toolId: "mac-only",
        recipes: [],
        loginRequired: false,
      }],
      observed: [{ state: "absent" }],
    }));

    expect(plan.actions.map((action) => action.kind)).toEqual(["human-action"]);
    expect(plan.agentTasks).toEqual([]);
    expect(plan.actions[0]?.detail).toMatchObject({
      reason: expect.stringContaining("no declared agent installation bounds"),
    });
  });

  it("creates a stable bounded Agent Task only when deterministic installation is unavailable", () => {
    const subject = resource("tool", "tool", "ensure");
    const input = plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "custom-tool",
          recipes: [],
          loginRequired: false,
          // Bounds are authored. Without them there is nowhere the agent may
          // install, so no task is created.
          agentInstall: {
            paths: ["~/.local/share/canonfig/tools/custom-tool"],
            origins: ["https://registry.npmjs.org"],
          },
        }],
      },
    );
    const plan = runPlan(input);
    expect(plan.actions[0]?.kind).toBe("agent-task");
    expect(plan.agentTasks).toEqual([{
      id: "agent:tool:0",
      resource: "tool",
      summary: "Find an installation recipe for custom-tool",
      desiredOutcome: "Converge tool tool",
      observedEvidence: ["Observed state: absent"],
      allowedPaths: ["~/.local/share/canonfig/tools/custom-tool"],
      allowedExecutables: ["custom-tool"],
      executableAuthorizations: [{
        executable: "custom-tool",
        behavior: "leaf",
      }],
      allowedOrigins: ["https://registry.npmjs.org"],
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 300,
      outputLimitBytes: 65_536,
      verification: { command: ["custom-tool", "--version"] },
    }]);
  });

  it("carries deterministic recipe versions into canonical install actions", () => {
    const subject = resource("tool", "tool", "ensure");
    const versioned = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "ripgrep",
          recipes: [{
            platform: "linux",
            method: "apt",
            package: "ripgrep",
            version: "14.1.0",
            source: "package-lock.json",
          }],
          loginRequired: false,
        }],
      },
    ));
    const unversioned = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "ripgrep",
          recipes: [{
            platform: "linux",
            method: "apt",
            package: "ripgrep",
          }],
          loginRequired: false,
        }],
      },
    ));

    expect(versioned.actions[0]?.detail).toEqual({
      kind: "install-tool",
      toolId: "ripgrep",
      method: "apt",
      package: "ripgrep",
      version: "14.1.0",
      source: "package-lock.json",
    });
    expect(JSON.parse(versioned.encoded).actions[0].detail.version).toBe("14.1.0");
    expect(unversioned.actions[0]?.detail).toEqual({
      kind: "human-action",
      reason: "Installing ripgrep requires a deterministic apt version",
      instructions: "The reviewed apt recipe for ripgrep has no exact version. Add a deterministic version to the profile, or install the tool manually, then rerun synchronization.",
    });
    expect(JSON.parse(unversioned.encoded).actions[0].detail.kind).toBe("human-action");
  });

  it("routes remote npm-family artifacts without integrity to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "tool",
            version: "1.2.3",
            source: "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          reason: "Installing tool requires a reviewed npm artifact integrity",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it("routes reviewed source recipes to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "source-tool",
          recipes: [{
            platform: "linux",
            method: "source",
            package: "https://github.com/example/source-tool",
            version: "v7.0.0",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing source-tool from source requires Human Action Required",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it.each([
    "HTTPS://registry.npmjs.org/tool/-/tool-1.2.3.tgz",
    "https://REGISTRY.NPMJS.ORG/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org:443/tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/../tool/-/tool-1.2.3.tgz",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz%23fragment",
    "https://registry.npmjs.org/tool/-/tool-1.2.3.tgz#fragment",
    "https://user:password@registry.npmjs.org/tool/-/tool-1.2.3.tgz",
  ])("rejects noncanonical npm artifact sources before planning: %s", (source) => {
    const subject = resource("tool", "tool", "ensure");
    expect(() => runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: "tool",
            version: "1.2.3",
            source: { source, integrity: "sha512-c2FtcGxl" },
          }],
          loginRequired: false,
        }],
      },
    ))).toThrow();
  });

  it("routes a bun tarball recipe to Human Action Required at planning", () => {
    // The executor always refuses this recipe, because bun has no guaranteed
    // offline mode. Planning it as install-tool meant the refusal failed the
    // whole run and rolled back every action before it, unlike every other
    // unrunnable recipe, which becomes a human action at planning.
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "bun-tool",
          recipes: [{
            platform: "linux",
            method: "bun",
            package: "bun-tool",
            version: "1.2.3",
            source: {
              source: "https://registry.npmjs.org/bun-tool/-/bun-tool-1.2.3.tgz",
              integrity: "sha512-c2FtcGxl",
            },
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing bun-tool with bun requires Human Action Required",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it("routes Cargo scripts-disabled recipes to Human Action Required", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "cargo-tool",
          recipes: [{
            platform: "linux",
            method: "cargo",
            package: "cargo-tool",
            version: "1.2.3",
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing cargo-tool with Cargo requires Human Action Required",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });


  it.each([
    ["npm", "@scope/tool", "latest"],
    ["pnpm", "@scope/tool", "^1.2.3"],
    ["bun", "@scope/tool", "1.2"],
    ["brew", "tool", "1.2/3"],
    ["homebrew", "tool", "1.2/3"],
    ["winget", "Example.Tool", "1.2/3"],
    ["uv", "tool", "1.2/3"],
    ["cargo", "tool", "latest"],
    ["apt", "tool", "1.2/3"],
    ["source", "tool", "../bad"],
  ] as const)(
    "rejects malformed %s recipe versions before creating an install action",
    (method, packageName, version) => {
      const subject = resource("tool", "tool", "ensure");
      const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
        [subject],
        {
          desired: [{
            kind: "tool",
            toolId: "tool",
            recipes: [{
              platform: "linux",
              method,
              package: packageName,
              version,
            }],
            loginRequired: false,
          }],
        },
      ))));
      expect(error._tag).toBe("PlannerInvalidRecipeError");
    },
  );

  it.each([undefined, "1.2.3"] as const)(
    "rejects unknown %s recipe methods before creating an install action",
    (version) => {
      const subject = resource("tool", "tool", "ensure");
      const recipe = {
        platform: "linux",
        method: "apt" satisfies RecipeMethod,
        package: "tool",
      };
      // SAFETY: Deliberately mutates a valid recipe to verify hostile planner
      // input is rejected at runtime.
      Object.assign(recipe, {
        method: "unknown-installer",
      });
      const candidate = version === undefined
        ? recipe
        : Object.assign(recipe, { version });
      const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
        [subject],
        {
          desired: [{
            kind: "tool",
            toolId: "tool",
            recipes: [candidate],
            loginRequired: false,
          }],
        },
      ))));
      expect(error._tag).toBe("PlannerInvalidRecipeError");
    },
  );

  it.each([
    ["dist-tag", "@scope/tool", "latest"],
    ["range", "@scope/tool", "^1.2.3"],
    ["URL", "@scope/tool", "https://registry.npmjs.org/tool.tgz"],
    ["Git", "@scope/tool", "git+https://github.com/example/tool.git#v1.2.3"],
    ["GitHub", "@scope/tool", "github:example/tool"],
    ["alias", "alias@npm:real-tool", "1.2.3"],
    ["file", "@scope/tool", "file:../tool"],
    ["workspace", "@scope/tool", "workspace:*"],
    ["link", "@scope/tool", "link:../tool"],
    ["encoded", "@scope/tool", "1.2.3%2Ftool"],
    ["option", "@scope/tool", "--ignore-scripts"],
    ["separator", "@scope/tool", "1.2.3;--ignore-scripts"],
  ])("rejects npm %s recipe before creating an install action", (_name, packageName, version) => {
    const subject = resource("tool", "tool", "ensure");
    const error = Effect.runSync(Effect.flip(planSynchronization(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "tool",
          recipes: [{
            platform: "linux",
            method: "npm",
            package: packageName,
            version,
          }],
          loginRequired: false,
        }],
      },
    ))));
    expect(error._tag).toBe("PlannerInvalidRecipeError");
  });
  it("escalates reviewed build-hook recipes when descendants cannot be sandboxed", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
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
              executables: ["node-gyp"],
              paths: ["/tmp/native-tool"],
              origins: ["https://registry.npmjs.org"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [{
                executable: "node-gyp",
                arguments: ["rebuild"],
              }],
            },
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing native-tool requires reviewed build hooks",
        }),
      }),
    ]);
  });

  it("routes a reviewed uv sdist recipe to Human Action Required before execution", () => {
    const subject = resource("tool", "tool", "ensure");
    const plan = runPlan(plannerInput(
      [subject],
      {
        desired: [{
          kind: "tool",
          toolId: "sdist-tool",
          recipes: [{
            platform: "linux",
            method: "uv",
            package: "sdist-tool",
            version: "2.0.0",
            buildPolicy: {
              mode: "required",
              reviewedBy: "reviewer",
              reviewedAt: "2026-08-16T00:00:00Z",
              executables: ["python"],
              paths: ["/tmp/sdist-tool"],
              origins: ["https://pypi.org"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [{
                executable: "python",
                arguments: ["-m", "build"],
              }],
            },
          }],
          loginRequired: false,
        }],
      },
    ));
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "human-action",
        detail: expect.objectContaining({
          kind: "human-action",
          reason: "Installing sdist-tool requires reviewed build hooks",
        }),
      }),
    ]);
    expect(plan.actions.some((action) => action.kind === "install-tool")).toBe(false);
  });

  it("rejects duplicate planner evidence rather than depending on input order", () => {
    const input = plannerInput([resource("file", "file", "replace")]);
    const duplicate = {
      ...input,
      observedState: {
        ...input.observedState,
        resources: [
          input.observedState.resources[0],
          input.observedState.resources[0],
        ],
      },
    };
    const error = Effect.runSync(Effect.flip(planSynchronization(duplicate)));
    expect(error._tag).toBe("DuplicatePlannerInputError");
  });
});
