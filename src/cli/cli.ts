import { Effect, Option, Schema } from "effect";

import {
  CertificateFingerprint,
  FollowerId,
  GroupName,
  InvitationCode,
  ProfileId,
  ProfileRevisionId,
  ResourceId,
  Timestamp,
} from "../domain/brand.ts";
import { AgentPolicy } from "../domain/identity.ts";
import type { EnrollmentInvitationGrant } from "../enrollment/enrollment.types.ts";
import { isNestedCommandLauncher } from "../agent/agent-resolution.service.ts";
import { ExecutableAuthorizationSchema } from "../domain/synchronization.ts";
import {
  scheduleWeekdays,
  type SyncSchedule,
} from "../schedule/schedule-manager.types.ts";
import {
  AgentHarnessCapability,
  type FollowerAgentHarnessConfiguration,
  SupportedAgentHarness,
} from "../synchronization/follower-sync-config.ts";
import {
  CliExitCode,
  exitCodeForFailure,
  type CliExitCode as CliExitCodeValue,
} from "./exit-codes.ts";
import { FollowerCommands } from "./follower-commands.ts";
import {
  renderCliResult,
  renderUsageFailure,
  type CliOutputFormat,
} from "./render.ts";
import {
  CliCommandFailure,
  SourceCommands,
  type CliPayload,
} from "./source-commands.ts";

export const programName = "canonfig";
export const programDisplayName = "Canonfig";
export const programVersion = "3.1.3";

export const helpText = `${programDisplayName} ${programVersion}

Usage: ${programName} <command> [options]

Source:
  source init
  source scan --file <path> [--file <path>...]
  source publish --proposal <path> --profile <id> --name <name> --reviewer <name>
  source publish --profile-file <profile.jsonc> [--proposal <path>] --reviewer <name>
  source serve [--host <127.0.0.1|::1>] [--port <port>]
  source invite --endpoint <https-url> [--expires <duration>] [--group <name>...]
  source revoke <follower-id>

Follower:
  follower enroll <invite> --name <name> --profile <id> [--replace]
  sync [--plan | --apply] [--no-input]
  recover [--no-input]
  abandon
  status [--follower <id>]
  overlay list
  overlay set <resource-id> --target <path> --key <config.path> [--key <config.path>...]
  overlay remove <resource-id>
  doctor [--no-input] [--timeout-ms <ms>]

Profiles and policy:
  profile list
  profile show <revision-id>
  profile select <profile-id>
  agent policy [deterministic-only|agent-propose|agent-apply]
  agent harness [codex|claude|gemini] --executable <path> [--allow-path <path>...]
    [--allow-leaf-executable <name>...]
    [--allow-origin <https-origin>...]
    [--allow-capability <capability>...] [--maximum-input-bytes <bytes>]

Scheduling:
  schedule set <daily@HH:mm|weekly:Day@HH:mm> [--timezone <IANA>] [--executable <path>]
  schedule status
  schedule remove

Global options:
  -h, --help     Show help
  -V, --version  Show version
  --json         Emit stable machine-readable JSON
`;

export type CliCommand =
  | { readonly _tag: "SourceInit" }
  | { readonly _tag: "SourceScan"; readonly files: ReadonlyArray<{ readonly path: string }> }
  | {
    readonly _tag: "SourcePublish";
    readonly proposalPath?: string | undefined;
    readonly profile?: typeof ProfileId.Type | undefined;
    readonly name?: string | undefined;
    readonly profilePath?: string | undefined;
    readonly reviewer: string;
  }
  | {
    readonly _tag: "SourceServe";
    readonly hostname: "127.0.0.1" | "::1";
    readonly port: number;
  }
  | {
    readonly _tag: "SourceInvite";
    readonly endpoint: string;
    readonly expiresInMilliseconds: number;
    readonly groups: ReadonlyArray<typeof GroupName.Type>;
  }
  | { readonly _tag: "SourceRevoke"; readonly follower: typeof FollowerId.Type }
  | {
    readonly _tag: "FollowerEnroll";
    readonly invitation: EnrollmentInvitationGrant;
    readonly followerName: string;
    readonly selectedProfile?: typeof ProfileId.Type | undefined;
    /** Replace a completed enrollment instead of refusing. */
    readonly replace: boolean;
  }
  | {
    readonly _tag: "Synchronize";
    readonly mode: "plan" | "apply";
    readonly noInput: boolean;
  }
  | { readonly _tag: "Recover"; readonly noInput: boolean }
  | { readonly _tag: "Abandon" }
  | { readonly _tag: "Status"; readonly follower?: typeof FollowerId.Type | undefined }
  | { readonly _tag: "OverlayList" }
  | {
    readonly _tag: "OverlaySet";
    readonly resource: typeof ResourceId.Type;
    readonly target: string;
    readonly keys: ReadonlyArray<string>;
  }
  | { readonly _tag: "OverlayRemove"; readonly resource: typeof ResourceId.Type }
  | {
    readonly _tag: "Doctor";
    readonly noInput: boolean;
    readonly timeoutMilliseconds: number;
  }
  | { readonly _tag: "ProfileList" }
  | {
    readonly _tag: "ProfileShow";
    readonly revision: typeof ProfileRevisionId.Type;
  }
  | {
    readonly _tag: "ProfileSelect";
    readonly profile: typeof ProfileId.Type;
  }
  | { readonly _tag: "AgentPolicyGet" }
  | { readonly _tag: "AgentPolicySet"; readonly policy: typeof AgentPolicy.Type }
  | { readonly _tag: "AgentHarnessGet" }
  | {
    readonly _tag: "AgentHarnessSet";
    readonly configuration: FollowerAgentHarnessConfiguration;
  }
  | {
    readonly _tag: "ScheduleSet";
    readonly schedule: SyncSchedule;
    readonly executable?: string | undefined;
  }
  | { readonly _tag: "ScheduleStatus" }
  | { readonly _tag: "ScheduleRemove" };

export type CliOutcome =
  | { readonly _tag: "Help"; readonly text: string; readonly exitCode: CliExitCodeValue }
  | { readonly _tag: "Version"; readonly text: string; readonly exitCode: CliExitCodeValue }
  | {
    readonly _tag: "Command";
    readonly command: CliCommand;
    readonly format: CliOutputFormat;
    readonly exitCode: CliExitCodeValue;
  }
  | {
    readonly _tag: "InvalidInput";
    readonly message: string;
    readonly format: CliOutputFormat;
    readonly exitCode: CliExitCodeValue;
  };

export interface CliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (exitCode: CliExitCodeValue) => void;
}

interface Options {
  readonly positionals: ReadonlyArray<string>;
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly switches: ReadonlySet<string>;
}

const invalid = (message: string): CliOutcome => ({
  _tag: "InvalidInput",
  message,
  // Overwritten by evaluateCli, which is where the requested format is known.
  format: "human",
  exitCode: CliExitCode.usageOrConfiguration,
});

const command = (
  value: CliCommand,
  format: CliOutputFormat,
): CliOutcome => ({
  _tag: "Command",
  command: value,
  format,
  exitCode: CliExitCode.success,
});

const parseOptions = (
  arguments_: ReadonlyArray<string>,
  valueOptions: ReadonlySet<string>,
  switchOptions: ReadonlySet<string>,
): Options => {
  const positionals: Array<string> = [];
  const values = new Map<string, Array<string>>();
  const switches = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (switchOptions.has(argument)) {
      if (switches.has(argument)) {
        throw new Error(`Option may be specified only once: ${argument}`);
      }
      switches.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`Option requires a value: ${argument}`);
    }
    index += 1;
    const entries = values.get(argument) ?? [];
    entries.push(value);
    values.set(argument, entries);
  }
  return { positionals, values, switches };
};

const one = (
  options: Options,
  name: string,
  required = false,
): string | undefined => {
  const entries = options.values.get(name) ?? [];
  if (entries.length > 1) throw new Error(`Option may be specified only once: ${name}`);
  const value = entries[0];
  if (required && value === undefined) throw new Error(`Missing required option: ${name}`);
  return value;
};

const decodeOption = <Value>(
  decoder: (input: string) => Option.Option<Value>,
  value: string,
  label: string,
): Value => {
  const decoded = decoder(value);
  if (Option.isNone(decoded)) throw new Error(`Invalid ${label}: ${value}`);
  return decoded.value;
};

const parsePositiveInteger = (
  value: string,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return number;
};

const durationMilliseconds = (value: string): number => {
  const match = /^(?<amount>[1-9]\d*)(?<unit>ms|s|m|h)$/u.exec(value);
  if (match?.groups === undefined) throw new Error(`Invalid duration: ${value}`);
  const amount = parsePositiveInteger(match.groups.amount ?? "", "duration");
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match.groups.unit ?? ""
  ];
  if (multiplier === undefined || amount * multiplier > 86_400_000) {
    throw new Error("Invitation duration must not exceed 24h");
  }
  return amount * multiplier;
};

const invitationSchema = Schema.Struct({
  code: InvitationCode,
  nonce: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  sourceFingerprint: CertificateFingerprint,
  tlsFingerprint: CertificateFingerprint,
  groups: Schema.Array(GroupName),
  expiresAt: Timestamp,
});

const decodeInvitation = (encoded: string): EnrollmentInvitationGrant => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid enrollment invitation");
  }
  const decoded = Schema.decodeUnknownOption(invitationSchema)(parsed);
  if (Option.isNone(decoded)) throw new Error("Invalid enrollment invitation");
  return decoded.value;
};

const parseSchedule = (
  calendar: string,
  timezone: string | undefined,
): SyncSchedule => {
  const daily = /^daily@(?<time>(?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(calendar);
  if (daily?.groups?.time !== undefined) {
    const schedule: SyncSchedule = {
      kind: "daily",
      localTime: daily.groups.time,
    };
    return timezone === undefined ? schedule : { ...schedule, timezone };
  }
  const weekly = /^weekly:(?<days>(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)@(?<time>(?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
    calendar,
  );
  const days = weekly?.groups?.days?.split(",");
  const localTime = weekly?.groups?.time;
  const decodedWeekdays = days?.map((day) =>
    decodeOption(
      Schema.decodeUnknownOption(Schema.Literals(scheduleWeekdays)),
      day,
      "schedule weekday",
    )
  );
  if (decodedWeekdays !== undefined && localTime !== undefined) {
    const schedule: SyncSchedule = {
      kind: "weekly",
      weekdays: [...new Set(decodedWeekdays)].sort(
        (left, right) => scheduleWeekdays.indexOf(left) - scheduleWeekdays.indexOf(right),
      ),
      localTime,
    };
    return timezone === undefined ? schedule : { ...schedule, timezone };
  }
  throw new Error(`Invalid schedule calendar: ${calendar}`);
};

/** Parses the `schedule` command area. Extracted to keep evaluateCommand simple. */
const evaluateScheduleCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
      // Separate options from positionals before judging the argument count, so
      // a stray argument is reported as the stray argument rather than making
      // the action itself look unknown.
      if (action === "status" || action === "remove") {
        const options = parseOptions(rest, new Set(), new Set());
        if (options.positionals.length > 0) {
          return invalid(`canonfig schedule ${action} accepts no arguments`);
        }
        return command(
          { _tag: action === "status" ? "ScheduleStatus" : "ScheduleRemove" },
          format,
        );
      }
      if (action === "set") {
        const options = parseOptions(
          rest,
          new Set(["--timezone", "--executable"]),
          new Set(),
        );
        if (options.positionals.length !== 1) {
          return invalid("Usage: canonfig schedule set <calendar>");
        }
        const executable = one(options, "--executable");
        const parsed: CliCommand = {
          _tag: "ScheduleSet",
          schedule: parseSchedule(options.positionals[0]!, one(options, "--timezone")),
        };
        return command(
          executable === undefined ? parsed : { ...parsed, executable },
          format,
        );
      }
      return invalid(`Unknown schedule command: ${action ?? ""}`);
};

const evaluateCommand = (
  arguments_: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  const [area, action, ...rest] = arguments_;
  try {
    if (area === "source") {
      if (action === "init" && rest.length === 0) return command({ _tag: "SourceInit" }, format);
      if (action === "scan") {
        const options = parseOptions(rest, new Set(["--file"]), new Set());
        if (options.positionals.length > 0) return invalid("source scan accepts only --file inputs");
        const files = (options.values.get("--file") ?? []).map((path) => ({ path }));
        if (files.length === 0) return invalid("source scan requires at least one --file");
        return command({ _tag: "SourceScan", files }, format);
      }
      if (action === "publish") {
        const options = parseOptions(
          rest,
          new Set(["--proposal", "--profile", "--name", "--profile-file", "--reviewer"]),
          new Set(),
        );
        if (options.positionals.length > 0) return invalid("source publish accepts only named options");
        const proposalPath = one(options, "--proposal");
        const profilePath = one(options, "--profile-file");
        const profileValue = one(options, "--profile");
        const name = one(options, "--name");
        if (proposalPath === undefined && profilePath === undefined) {
          return invalid("source publish requires --proposal or --profile-file");
        }
        if (profilePath === undefined && (profileValue === undefined || name === undefined)) {
          return invalid("source publish requires --profile and --name without --profile-file");
        }
        return command({
          _tag: "SourcePublish",
          proposalPath,
          profile: profileValue === undefined
            ? undefined
            : decodeOption(Schema.decodeUnknownOption(ProfileId), profileValue, "profile id"),
          name,
          profilePath,
          reviewer: one(options, "--reviewer", true)!,
        }, format);
      }
      if (action === "serve") {
        const options = parseOptions(rest, new Set(["--host", "--port"]), new Set());
        if (options.positionals.length > 0) return invalid("source serve accepts only named options");
        const hostname = one(options, "--host") ?? "127.0.0.1";
        if (hostname !== "127.0.0.1" && hostname !== "::1") {
          return invalid(`Invalid source host: ${hostname}`);
        }
        const port = parsePositiveInteger(one(options, "--port") ?? "17342", "port", 65_535);
        return command({ _tag: "SourceServe", hostname, port }, format);
      }
      if (action === "invite") {
        const options = parseOptions(
          rest,
          new Set(["--endpoint", "--expires", "--group"]),
          new Set(),
        );
        if (options.positionals.length > 0) return invalid("source invite accepts only named options");
        const endpoint = one(options, "--endpoint", true)!;
        let url: URL;
        try {
          url = new URL(endpoint);
        } catch {
          return invalid(`Invalid source endpoint: ${endpoint}`);
        }
        if (url.protocol !== "https:") return invalid("Source endpoint must use HTTPS");
        if (
          url.hostname !== "127.0.0.1"
          && url.hostname !== "[::1]"
          && url.hostname !== "::1"
        ) {
          return invalid("Source endpoint must use a loopback host");
        }
        const groups = (options.values.get("--group") ?? []).map((value) =>
          decodeOption(Schema.decodeUnknownOption(GroupName), value, "group name")
        );
        return command({
          _tag: "SourceInvite",
          endpoint: url.origin,
          expiresInMilliseconds: durationMilliseconds(one(options, "--expires") ?? "15m"),
          groups,
        }, format);
      }
      if (action === "revoke") {
        if (rest.length !== 1) return invalid("Usage: canonfig source revoke <follower-id>");
        return command({
          _tag: "SourceRevoke",
          follower: decodeOption(Schema.decodeUnknownOption(FollowerId), rest[0]!, "follower id"),
        }, format);
      }
      return invalid(`Unknown source command: ${action ?? ""}`);
    }
    if (area === "follower" && action === "enroll") {
      const options = parseOptions(
        rest,
        new Set(["--name", "--profile"]),
        new Set(["--replace"]),
      );
      if (options.positionals.length !== 1) {
        return invalid(
          "Usage: canonfig follower enroll <invite> --name <name> --profile <id>",
        );
      }
      return command({
        _tag: "FollowerEnroll",
        invitation: decodeInvitation(options.positionals[0]!),
        followerName: one(options, "--name", true)!,
        selectedProfile: decodeOption(
          Schema.decodeUnknownOption(ProfileId),
          one(options, "--profile", true)!,
          "profile id",
        ),
        replace: options.switches.has("--replace"),
      }, format);
    }
    if (area === "profile") {
      if (action === "list" && rest.length === 0) return command({ _tag: "ProfileList" }, format);
      if (action === "show" && rest.length === 1) {
        return command({
          _tag: "ProfileShow",
          revision: decodeOption(Schema.decodeUnknownOption(ProfileRevisionId), rest[0]!, "profile revision id"),
        }, format);
      }
      if (action === "select" && rest.length === 1) {
        return command({
          _tag: "ProfileSelect",
          profile: decodeOption(
            Schema.decodeUnknownOption(ProfileId),
            rest[0]!,
            "profile id",
          ),
        }, format);
      }
      return invalid(`Unknown profile command: ${action ?? ""}`);
    }
    if (area === "sync") {
      const options = parseOptions(
        arguments_.slice(1),
        new Set(),
        new Set(["--plan", "--apply", "--no-input"]),
      );
      if (options.positionals.length > 0) return invalid("sync accepts no positional arguments");
      if (options.switches.has("--plan") && options.switches.has("--apply")) {
        return invalid("--plan and --apply are mutually exclusive");
      }
      return command({
        _tag: "Synchronize",
        mode: options.switches.has("--apply") ? "apply" : "plan",
        noInput: options.switches.has("--no-input"),
      }, format);
    }
    if (area === "abandon") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set());
      if (options.positionals.length > 0) {
        return invalid("abandon accepts no arguments");
      }
      return command({ _tag: "Abandon" }, format);
    }
    if (area === "recover") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set(["--no-input"]));
      if (options.positionals.length > 0) return invalid("recover accepts no positional arguments");
      return command({ _tag: "Recover", noInput: options.switches.has("--no-input") }, format);
    }
    if (area === "status") {
      const options = parseOptions(arguments_.slice(1), new Set(["--follower"]), new Set());
      if (options.positionals.length > 0) return invalid("status accepts no positional arguments");
      const follower = one(options, "--follower");
      if (follower === undefined) return command({ _tag: "Status" }, format);
      return command({
        _tag: "Status",
        follower: decodeOption(
          Schema.decodeUnknownOption(FollowerId),
          follower,
          "follower id",
        ),
      }, format);
    }
    if (area === "overlay") {
      if (action === "list" && rest.length === 0) {
        return command({ _tag: "OverlayList" }, format);
      }
      if (action === "remove" && rest.length === 1) {
        return command({
          _tag: "OverlayRemove",
          resource: decodeOption(
            Schema.decodeUnknownOption(ResourceId),
            rest[0]!,
            "resource id",
          ),
        }, format);
      }
      if (action === "set") {
        const options = parseOptions(
          rest,
          new Set(["--target", "--key"]),
          new Set(),
        );
        if (options.positionals.length !== 1) {
          return invalid(
            "Usage: canonfig overlay set <resource-id> --target <path> --key <config.path>",
          );
        }
        const keys = options.values.get("--key") ?? [];
        if (keys.length === 0) return invalid("overlay set requires at least one --key");
        return command({
          _tag: "OverlaySet",
          resource: decodeOption(
            Schema.decodeUnknownOption(ResourceId),
            options.positionals[0]!,
            "resource id",
          ),
          target: one(options, "--target", true)!,
          keys,
        }, format);
      }
      return invalid(`Unknown overlay command: ${action ?? ""}`);
    }
    if (area === "doctor") {
      const options = parseOptions(
        arguments_.slice(1),
        new Set(["--timeout-ms"]),
        new Set(["--no-input"]),
      );
      if (options.positionals.length > 0) return invalid("doctor accepts no positional arguments");
      return command({
        _tag: "Doctor",
        noInput: options.switches.has("--no-input"),
        timeoutMilliseconds: parsePositiveInteger(
          one(options, "--timeout-ms") ?? "5000",
          "doctor timeout",
          300_000,
        ),
      }, format);
    }
    if (area === "agent" && action === "policy") {
      // Reject unknown options before reading the policy, so an option typo is
      // reported as an unknown option rather than as an invalid policy name.
      const options = parseOptions(rest, new Set(), new Set());
      if (options.positionals.length === 0) return command({ _tag: "AgentPolicyGet" }, format);
      if (options.positionals.length === 1) {
        return command({
          _tag: "AgentPolicySet",
          policy: decodeOption(
            Schema.decodeUnknownOption(AgentPolicy),
            options.positionals[0]!,
            "agent policy",
          ),
        }, format);
      }
      return invalid("Usage: canonfig agent policy [policy]");
    }
    if (area === "agent" && action === "harness") {
      if (rest.length === 0) return command({ _tag: "AgentHarnessGet" }, format);
      const [kind, ...harnessArguments] = rest;
      const options = parseOptions(
        harnessArguments,
        new Set([
          "--executable",
          "--allow-path",
          "--allow-leaf-executable",
          "--allow-origin",
          "--allow-capability",
          "--maximum-input-bytes",
        ]),
        new Set(),
      );
      if (options.positionals.length > 0) {
        return invalid("agent harness accepts one adapter kind and named options");
      }
      const origins = options.values.get("--allow-origin") ?? [];
      for (const origin of origins) {
        let url: URL;
        try {
          url = new URL(origin);
        } catch {
          return invalid(`Invalid agent harness origin: ${origin}`);
        }
        if (url.protocol !== "https:" || url.origin !== origin) {
          return invalid(`Agent harness origin must be an exact HTTPS origin: ${origin}`);
        }
      }
      const configuration = Schema.decodeUnknownOption(
        Schema.Struct({
          kind: SupportedAgentHarness,
          executable: Schema.NonEmptyString,
          maximumInputBytes: Schema.Int.check(
            Schema.isGreaterThan(0),
            Schema.isLessThanOrEqualTo(1024 * 1024),
          ),
          allowedPaths: Schema.Array(Schema.NonEmptyString),
          allowedExecutables: Schema.Array(Schema.NonEmptyString),
          executableAuthorizations: Schema.Array(ExecutableAuthorizationSchema),
          allowedOrigins: Schema.Array(Schema.NonEmptyString),
          allowedCapabilities: Schema.Array(AgentHarnessCapability),
        }),
      )({
        kind,
        executable: one(options, "--executable", true),
        maximumInputBytes: parsePositiveInteger(
          one(options, "--maximum-input-bytes") ?? `${1024 * 1024}`,
          "agent harness maximum input bytes",
          1024 * 1024,
        ),
        allowedPaths: options.values.get("--allow-path") ?? [],
        allowedExecutables: [
          ...new Set(options.values.get("--allow-leaf-executable") ?? []),
        ],
        executableAuthorizations: (options.values.get("--allow-leaf-executable") ?? [])
          .map((executable) => ({ executable, behavior: "leaf" as const })),
        allowedOrigins: origins,
        allowedCapabilities: options.values.get("--allow-capability") ?? [],
      });
      if (Option.isNone(configuration)) {
        return invalid("Invalid agent harness configuration");
      }
      const unclassifiable = configuration.value.executableAuthorizations.find(
        (authorization) => isNestedCommandLauncher(authorization.executable),
      );
      if (unclassifiable !== undefined) {
        return invalid(
          `${unclassifiable.executable} launches nested commands that cannot be bounded by an execution model; remove it from the agent harness allowlist`,
        );
      }
      return command({
        _tag: "AgentHarnessSet",
        configuration: configuration.value,
      }, format);
    }
    if (area === "schedule") {
      return evaluateScheduleCommand(action, rest, format);
    }
    return invalid(`Unknown argument: ${area ?? ""}`);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid command input");
  }
};

export const evaluateCli = (arguments_: ReadonlyArray<string>): CliOutcome => {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return { _tag: "Help", text: helpText, exitCode: CliExitCode.success };
  }
  if (arguments_.includes("--version") || arguments_.includes("-V")) {
    return { _tag: "Version", text: programVersion, exitCode: CliExitCode.success };
  }
  const format: CliOutputFormat = arguments_.includes("--json") ? "json" : "human";
  const rest = arguments_.filter((argument) => argument !== "--json");
  const outcome = rest.length === 0
    ? invalid("Missing command")
    : evaluateCommand(rest, format);
  return outcome._tag === "InvalidInput" ? { ...outcome, format } : outcome;
};

const commandName = (value: CliCommand): string => {
  switch (value._tag) {
    case "SourceInit": return "source.init";
    case "SourceScan": return "source.scan";
    case "SourcePublish": return "source.publish";
    case "SourceServe": return "source.serve";
    case "SourceInvite": return "source.invite";
    case "SourceRevoke": return "source.revoke";
    case "FollowerEnroll": return "follower.enroll";
    case "Synchronize": return `sync.${value.mode}`;
    case "Recover": return "recover";
    case "Abandon": return "abandon";
    case "Status": return "status";
    case "OverlayList": return "overlay.list";
    case "OverlaySet": return "overlay.set";
    case "OverlayRemove": return "overlay.remove";
    case "Doctor": return "doctor";
    case "ProfileList": return "profile.list";
    case "ProfileShow": return "profile.show";
    case "ProfileSelect": return "profile.select";
    case "AgentPolicyGet": return "agent.policy.get";
    case "AgentPolicySet": return "agent.policy.set";
    case "AgentHarnessGet": return "agent.harness.get";
    case "AgentHarnessSet": return "agent.harness.set";
    case "ScheduleSet": return "schedule.set";
    case "ScheduleStatus": return "schedule.status";
    case "ScheduleRemove": return "schedule.remove";
  }
};

const executeCommand = Effect.fn("Cli.executeCommand")(function*(
  value: CliCommand,
): Effect.fn.Return<CliPayload, CliCommandFailure, SourceCommands | FollowerCommands> {
  const source = yield* SourceCommands;
  const follower = yield* FollowerCommands;
  switch (value._tag) {
    case "SourceInit": return yield* source.initialize();
    case "SourceScan": return yield* source.scan({ files: value.files });
    case "SourcePublish":
      return yield* source.publish({
        proposalPath: value.proposalPath,
        profile: value.profile,
        name: value.name,
        profilePath: value.profilePath,
        reviewer: value.reviewer,
      });
    case "SourceServe":
      return yield* source.serve({ hostname: value.hostname, port: value.port });
    case "SourceInvite":
      return yield* source.invite({
        endpoint: value.endpoint,
        expiresInMilliseconds: value.expiresInMilliseconds,
        groups: value.groups,
      });
    case "SourceRevoke": return yield* source.revoke(value.follower);
    case "FollowerEnroll":
      return yield* follower.enroll({
        invitation: value.invitation,
        followerName: value.followerName,
        selectedProfile: value.selectedProfile,
        replace: value.replace,
      });
    case "Synchronize":
      return yield* follower.synchronize({
        mode: value.mode,
        noInput: value.noInput,
      });
    case "Recover": return yield* follower.recover({ noInput: value.noInput });
    case "Abandon": return yield* follower.abandon();
    case "Status": return yield* follower.status(value.follower);
    case "OverlayList": return yield* follower.listLocalOverlays();
    case "OverlaySet":
      return yield* follower.setLocalOverlay({
        resource: value.resource,
        target: value.target,
        keys: value.keys,
      });
    case "OverlayRemove": return yield* follower.removeLocalOverlay(value.resource);
    case "Doctor":
      return yield* follower.doctor({
        noInput: value.noInput,
        timeoutMilliseconds: value.timeoutMilliseconds,
      });
    case "ProfileList": return yield* source.listProfiles();
    case "ProfileShow": return yield* source.inspectProfile(value.revision);
    case "ProfileSelect": return yield* follower.selectProfile(value.profile);
    case "AgentPolicyGet": return yield* follower.getAgentPolicy();
    case "AgentPolicySet": return yield* follower.setAgentPolicy(value.policy);
    case "AgentHarnessGet": return yield* follower.getAgentHarness();
    case "AgentHarnessSet":
      return yield* follower.setAgentHarness(value.configuration);
    case "ScheduleSet":
      return yield* follower.setSchedule(
        value.executable === undefined
          ? { schedule: value.schedule }
          : { schedule: value.schedule, executable: value.executable },
      );
    case "ScheduleStatus": return yield* follower.scheduleStatus();
    case "ScheduleRemove": return yield* follower.removeSchedule();
  }
});

export const runCli = Effect.fn("runCli")(function*(
  arguments_: ReadonlyArray<string>,
  io: CliIo,
): Effect.fn.Return<CliExitCodeValue, never, SourceCommands | FollowerCommands> {
  const outcome = evaluateCli(arguments_);
  if (outcome._tag === "Help" || outcome._tag === "Version") {
    yield* Effect.sync(() => {
      io.writeStdout(`${outcome.text}\n`);
      io.setExitCode(outcome.exitCode);
    });
    return outcome.exitCode;
  }
  if (outcome._tag === "InvalidInput") {
    yield* Effect.sync(() => {
      io.writeStderr(renderUsageFailure(outcome.message, outcome.format));
      io.setExitCode(outcome.exitCode);
    });
    return outcome.exitCode;
  }
  const name = commandName(outcome.command);
  const result = yield* executeCommand(outcome.command).pipe(
    Effect.match({
      onFailure: (failure) => ({
        command: name,
        message: failure.message,
        data: failure.details,
        exitCode: exitCodeForFailure(failure.category),
      }),
      onSuccess: (data) => ({
        command: name,
        message: `${name} completed`,
        data,
        exitCode: CliExitCode.success,
      }),
    }),
  );
  yield* Effect.sync(() => {
    const rendered = renderCliResult(result, outcome.format);
    const quietScheduledSuccess = result.exitCode === CliExitCode.success
      && outcome.format === "human"
      && outcome.command._tag === "Synchronize"
      && outcome.command.mode === "apply"
      && outcome.command.noInput;
    if (quietScheduledSuccess) {
      // Native schedulers need no success chatter; failures remain visible.
    } else if (result.exitCode === CliExitCode.success) io.writeStdout(rendered);
    else io.writeStderr(rendered);
    io.setExitCode(result.exitCode);
  });
  return result.exitCode;
});
