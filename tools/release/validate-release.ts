import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { Schema } from "effect";

const projectRoot = resolve(import.meta.dirname, "../..");
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "canonfig-release-"));
const tarballRoot = resolve(temporaryRoot, "tarball");
const installRoot = resolve(temporaryRoot, "install");
const homeRoot = resolve(temporaryRoot, "home");
const npmCacheRoot = resolve(temporaryRoot, "npm-cache");

const PackedFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  mode: Schema.Int,
});
const PackedArtifact = Schema.Struct({
  filename: Schema.String,
  name: Schema.String,
  version: Schema.String,
  size: Schema.Int,
  unpackedSize: Schema.Int,
  files: Schema.Array(PackedFile),
});
const PackOutput = Schema.Array(PackedArtifact);
const PackageMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.String,
  bin: Schema.Record(Schema.String, Schema.String),
  engines: Schema.Struct({ node: Schema.String }),
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
  exports: Schema.optional(Schema.Unknown),
});

interface Invocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandInput {
  readonly command: string;
  readonly arguments_: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const run = (input: CommandInput): Invocation => {
  const result = spawnSync(input.command, input.arguments_, {
    cwd: input.cwd,
    encoding: "utf8",
    env: input.environment ?? process.env,
    timeout: input.timeoutMilliseconds ?? 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const requireSuccess = (label: string, invocation: Invocation): void => {
  if (invocation.status !== 0) {
    fail(`${label} failed with status ${String(invocation.status)}:\n${invocation.stderr}`);
  }
};

const filesBelow = (root: string): ReadonlyArray<string> => {
  if (!statSync(root).isDirectory()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(root, entry.name);
    if (entry.isDirectory()) return filesBelow(child);
    return entry.isFile() ? [child] : [];
  });
};

const textFilesBelow = (root: string): ReadonlyArray<string> =>
  filesBelow(root).filter((path) =>
    /\.(?:cjs|js|json|jsonc|md|mdx|mjs|toml|ts|tsx|yaml|yml)$/u.test(path)
  );

const legacyProductPattern = new RegExp(["cod", "export"].join(""), "iu");
const legacyAuthorityPattern = new RegExp(`\\b${["mas", "ter"].join("")}\\b`, "iu");
const secretPatterns: ReadonlyArray<Readonly<{ readonly label: string; readonly pattern: RegExp }>> = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/u },
];

const scanNaming = (paths: ReadonlyArray<string>): void => {
  for (const path of paths) {
    const relativePath = relative(projectRoot, path);
    if (legacyProductPattern.test(relativePath)) {
      fail(`legacy product name remains in path: ${relativePath}`);
    }
    const text = readFileSync(path, "utf8");
    if (legacyProductPattern.test(text)) {
      fail(`legacy product name remains in ${relativePath}`);
    }
    const withoutSqliteMetadataTable = text.replaceAll("sqlite_master", "");
    if (legacyAuthorityPattern.test(withoutSqliteMetadataTable)) {
      fail(`legacy authority terminology remains in ${relativePath}`);
    }
  }
};

const scanSecrets = (paths: ReadonlyArray<string>): void => {
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    for (const secret of secretPatterns) {
      if (secret.pattern.test(text)) {
        fail(`${secret.label} pattern found in ${relative(projectRoot, path)}`);
      }
    }
  }
};

const invokeExecutable = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): Invocation =>
  run({
    command: executable,
    arguments_,
    cwd: installRoot,
    environment: {
      ...process.env,
      HOME: homeRoot,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/canonfig-release-validation-bus",
      PATH: `${dirname(executable)}:${process.env.PATH ?? ""}`,
    },
    timeoutMilliseconds: 60_000,
  });

const validatePackageMetadata = (metadataPath: string): void => {
  const metadata = Schema.decodeUnknownSync(PackageMetadata)(
    JSON.parse(readFileSync(metadataPath, "utf8")),
  );
  if (metadata.name !== "@microck/canonfig" || metadata.version !== "3.1.3") {
    fail(`unexpected package identity: ${metadata.name}@${metadata.version}`);
  }
  if (metadata.license !== "MIT") fail(`unexpected package license: ${metadata.license}`);
  if (metadata.engines.node !== ">=24") {
    fail(`unexpected Node.js engine: ${metadata.engines.node}`);
  }
  if (metadata.bin.canonfig !== "dist/runtime/main.js") {
    fail("package bin must map canonfig to dist/runtime/main.js");
  }
  if (metadata.exports !== undefined) {
    fail("the CLI-only package must not expose an unsupported library export");
  }
  const runtimeDependencies = Object.keys(metadata.dependencies).sort();
  const expectedRuntimeDependencies = [
    "@effect/platform-node",
    "@effect/sql-sqlite-node",
    "effect",
    "selfsigned",
    "smol-toml",
    "yaml",
  ];
  if (JSON.stringify(runtimeDependencies) !== JSON.stringify(expectedRuntimeDependencies)) {
    fail(`unexpected runtime dependencies: ${runtimeDependencies.join(", ")}`);
  }
  const developmentDependencies = new Set(Object.keys(metadata.devDependencies));
  for (const dependency of runtimeDependencies) {
    if (developmentDependencies.has(dependency)) {
      fail(`dependency is classified as both runtime and development: ${dependency}`);
    }
  }
};

const validatePackageContents = (
  artifact: typeof PackedArtifact.Type,
): void => {
  if (artifact.name !== "@microck/canonfig" || artifact.version !== "3.1.3") {
    fail(`unexpected packed identity: ${artifact.name}@${artifact.version}`);
  }
  if (artifact.size > 225_000 || artifact.unpackedSize > 1_125_000) {
    fail(
      `package exceeds release budget: ${artifact.size} packed, ${artifact.unpackedSize} unpacked`,
    );
  }
  const paths = artifact.files.map((file) => file.path);
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/runtime/main.js",
  ]) {
    if (!paths.includes(required)) fail(`package omits required file: ${required}`);
  }
  for (const path of paths) {
    if (
      path === "LICENSE"
      || path === "README.md"
      || path === "package.json"
      || /^dist\/.+\.js$/u.test(path)
    ) continue;
    fail(`package contains unintended file: ${path}`);
  }
  if (paths.some((path) => /\.(?:d\.ts|map)$/u.test(path))) {
    fail("CLI package unexpectedly includes declarations or source maps");
  }
  const shippedModules = paths.filter((path) => /^dist\/.+\.js$/u.test(path));
  for (const modulePath of shippedModules) {
    const sourcePath = resolve(
      projectRoot,
      modulePath.replace(/^dist\//u, "src/").replace(/\.js$/u, ".ts"),
    );
    if (!statSync(sourcePath).isFile()) {
      fail(`package contains stale compiled output without source: ${modulePath}`);
    }
  }
  const sourceModules = filesBelow(resolve(projectRoot, "src"))
    .filter((path) => path.endsWith(".ts"))
    .map((path) =>
      `dist/${relative(resolve(projectRoot, "src"), path).replace(/\.ts$/u, ".js")}`
    );
  for (const modulePath of sourceModules) {
    if (!paths.includes(modulePath)) fail(`package omits compiled module: ${modulePath}`);
  }
};

const validateBinary = (executable: string): void => {
  const help = invokeExecutable(executable, ["--help"]);
  requireSuccess("packed executable help", help);
  if (!help.stdout.includes("Usage: canonfig") || help.stderr !== "") {
    fail("packed executable help output is invalid");
  }

  const version = invokeExecutable(executable, ["--version"]);
  requireSuccess("packed executable version", version);
  if (version.stdout !== "3.1.3\n" || version.stderr !== "") {
    fail("packed executable version output is invalid");
  }

  const jsonRoute = invokeExecutable(executable, ["profile", "list", "--json"]);
  requireSuccess("packed executable JSON route", jsonRoute);
  const jsonEnvelope = JSON.parse(jsonRoute.stdout);
  if (
    jsonEnvelope.schema !== "canonfig.cli/v1"
    || jsonEnvelope.command !== "profile.list"
    || jsonEnvelope.status !== "success"
  ) fail("packed executable JSON route returned an invalid envelope");

  const invalid = invokeExecutable(executable, ["sync", "--plan", "--apply"]);
  if (invalid.status !== 2 || invalid.stdout !== "") {
    fail("packed executable did not map invalid input to exit code 2");
  }

  const doctor = invokeExecutable(
    executable,
    ["doctor", "--json", "--no-input", "--timeout-ms", "1000"],
  );
  if (
    (doctor.status !== 0 && doctor.status !== 5)
    || (doctor.status === 0 && doctor.stderr !== "")
    || (doctor.status === 5 && doctor.stdout !== "")
  ) {
    fail("packed executable doctor did not report its clean-home state truthfully");
  }
  const doctorEnvelope = JSON.parse(doctor.status === 0 ? doctor.stdout : doctor.stderr);
  if (
    doctorEnvelope.command !== "doctor"
    || doctorEnvelope.data?.noInput !== true
    || !Array.isArray(doctorEnvelope.data?.probes)
    || doctorEnvelope.data.probes.length !== 7
  ) {
    fail("packed executable doctor returned an invalid envelope");
  }

  const unattended = invokeExecutable(executable, ["sync", "--apply", "--no-input"]);
  if (
    unattended.status !== 2
    || unattended.stdout !== ""
    || !unattended.stderr.includes("not enrolled")
  ) fail("packed executable no-input route was not quiet and truthful");
};

try {
  mkdirSync(tarballRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  const packed = run({
    command: "npm",
    arguments_: [
      "pack",
      "--ignore-scripts=false",
      "--json",
      "--pack-destination",
      tarballRoot,
    ],
    cwd: projectRoot,
  });
  requireSuccess("npm pack", packed);
  const [artifact] = Schema.decodeUnknownSync(PackOutput)(JSON.parse(packed.stdout));
  if (artifact === undefined) fail("npm pack returned no artifact");
  validatePackageContents(artifact);

  const tarballPath = resolve(tarballRoot, artifact.filename);
  const extracted = run({
    command: "tar",
    arguments_: ["-xzf", tarballPath, "-C", temporaryRoot],
    cwd: projectRoot,
  });
  requireSuccess("package extraction", extracted);
  const packageRoot = resolve(temporaryRoot, "package");
  validatePackageMetadata(resolve(packageRoot, "package.json"));
  const shippedTextFiles = textFilesBelow(packageRoot);
  scanNaming(shippedTextFiles);
  scanSecrets(shippedTextFiles);

  const installEnvironment = {
    ...process.env,
    HOME: homeRoot,
    npm_config_cache: npmCacheRoot,
  };
  const installed = run({
    command: "npm",
    arguments_: [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    cwd: temporaryRoot,
    environment: installEnvironment,
  });
  requireSuccess("clean tarball install", installed);
  validateBinary(resolve(installRoot, "node_modules/.bin/canonfig"));

  const repositoryRoots = [
    "CONTEXT.md",
    "README.md",
    "package.json",
    "package-lock.json",
    "docs",
    "skills",
    "src",
    "tests",
    "tools/release",
    "website/content",
    "website/scripts",
  ].map((path) => resolve(projectRoot, path));
  const repositoryTextFiles = repositoryRoots.flatMap(textFilesBelow);
  scanNaming(repositoryTextFiles);
  scanSecrets(repositoryTextFiles);

  process.stdout.write(
    `Release validation passed: ${artifact.files.length} files, `
      + `${artifact.size} packed bytes, ${artifact.unpackedSize} unpacked bytes; `
      + "metadata, naming, secret patterns, clean install, and binary smoke verified.\n",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
