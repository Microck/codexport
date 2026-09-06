import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const limits = Object.freeze({ timeout: 5000, maxBuffer: 1024 * 1024 });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string"
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 253)
  : "";
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const result = (status, message, extra = {}) => ({
  schema: "canonfig.setup.peers/v1",
  status,
  message,
  self: null,
  peers: [],
  ...extra,
});
const invalid = () => result("unavailable", "Tailscale status could not be read safely. Enter a machine manually or skip discovery.");

// Project only display fields; never return the raw map, user directory, keys,
// public endpoints, tags, routes, or backend errors.
const device = (value) => {
  if (!record(value) || typeof value.ID !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.ID)) return null;
  const dnsName = text(value.DNSName).replace(/\.$/u, "");
  const name = text(value.HostName) || dnsName || "Unnamed device";
  const addresses = Array.isArray(value.TailscaleIPs)
    ? [...new Set(value.TailscaleIPs.filter((ip) => typeof ip === "string" && isIP(ip) !== 0))].sort(compare)
    : [];
  return {
    id: value.ID,
    name,
    dnsName,
    os: text(value.OS) || "unknown",
    addresses,
    online: typeof value.Online === "boolean" ? value.Online : null,
  };
};

/** Normalize a local status snapshot. Missing fields never imply capability. */
export const summarizeStatus = (input) => {
  if (!record(input) || typeof input.BackendState !== "string") return invalid();
  if (input.BackendState !== "Running") {
    return result("unavailable", "Tailscale is not running or needs sign-in. Enter a machine manually or skip discovery; setup will not change Tailscale.");
  }
  if (input.Peer !== undefined && input.Peer !== null && !record(input.Peer)) return invalid();
  const self = device(input.Self);
  const byId = new Map();
  let omitted = 0;
  for (const value of Object.values(input.Peer ?? {})) {
    const peer = device(value);
    if (peer === null) {
      omitted += 1;
      continue;
    }
    if (peer.id === self?.id) continue;
    const previous = byId.get(peer.id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(peer)) {
      // A contradictory identity snapshot must not become a selectable target.
      return invalid();
    }
    byId.set(peer.id, peer);
  }
  const peers = [...byId.values()].sort((left, right) =>
    compare(left.name.toLowerCase(), right.name.toLowerCase()) || compare(left.id, right.id)
  );
  return result(peers.length > 0 ? "ready" : "empty",
    "Only peers visible to this client are listed. Online status is not proof of reachability, SSH access, or Canonfig enrollment.",
    { self, peers, omitted });
};

/** The only subprocess is one bounded, read-only local Tailscale status call. */
export const discover = async (run = execute, platform = process.platform) => {
  try {
    const executable = platform === "win32" ? "tailscale.exe" : "tailscale";
    const { stdout } = await run(executable, ["status", "--json"], {
      ...limits, encoding: "utf8", windowsHide: true, shell: false,
    });
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > limits.maxBuffer) return invalid();
    return summarizeStatus(JSON.parse(stdout));
  } catch {
    return invalid();
  }
};

// Importing this file performs no discovery. Run the CLI only after consent.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node discover-tailscale.mjs\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(await discover(), null, 2)}\n`);
  }
}
