import assert from "node:assert/strict";
import { test } from "node:test";
import { discover, limits, summarizeStatus } from "./discover-tailscale.mjs";

const peer = (ID, extra = {}) => ({
  ID, HostName: "workstation", DNSName: "workstation.example.ts.net.",
  OS: "linux", TailscaleIPs: ["100.64.0.1"], Online: true, ...extra,
});
const snapshot = (Peer = {}, extra = {}) => ({ BackendState: "Running", Peer, ...extra });

test("projects allowlisted fields and distinguishes self from peers", () => {
  const value = summarizeStatus(snapshot({
    selfKey: peer("self"), peerKey: peer("remote", {
      PublicKey: "PRIVATE-MAP-KEY", UserID: 42, Endpoints: ["PUBLIC-ENDPOINT"], Tags: ["INTERNAL-TAG"],
    }),
  }, { Self: peer("self"), User: { 42: { LoginName: "PRIVATE-EMAIL" } } }));
  assert.equal(value.status, "ready");
  assert.equal(value.self.id, "self");
  assert.deepEqual(value.peers.map((entry) => entry.id), ["remote"]);
  assert.equal(value.peers[0].dnsName, "workstation.example.ts.net");
  for (const forbidden of ["PRIVATE-MAP-KEY", "PUBLIC-ENDPOINT", "INTERNAL-TAG", "PRIVATE-EMAIL", "peerKey"]) {
    assert.ok(!JSON.stringify(value).includes(forbidden));
  }
});

test("sorts duplicate names by stable ID and preserves offline and unknown states", () => {
  const a = peer("a", { Online: false });
  const b = peer("b", { Online: undefined });
  const first = summarizeStatus(snapshot({ z: b, x: a })).peers;
  assert.deepEqual(first, summarizeStatus(snapshot({ x: a, z: b })).peers);
  assert.deepEqual(first.map((entry) => [entry.id, entry.online]), [["a", false], ["b", null]]);
});

test("omits unidentified rows without using public map keys as identities", () => {
  const value = summarizeStatus(snapshot({ "PRIVATE-PUBLIC-KEY": { HostName: "host" }, ok: peer("ok") }));
  assert.equal(value.omitted, 1);
  assert.equal(value.peers.length, 1);
  assert.ok(!JSON.stringify(value).includes("PRIVATE-PUBLIC-KEY"));
});

test("deduplicates matching IDs and rejects contradictory identities", () => {
  assert.equal(summarizeStatus(snapshot({ a: peer("a"), b: peer("a") })).peers.length, 1);
  assert.equal(summarizeStatus(snapshot({ a: peer("a"), b: peer("a", { HostName: "different" }) })).status, "unavailable");
});

test("sanitizes display controls, validates addresses, and tolerates sparse rows", () => {
  const value = summarizeStatus(snapshot({ a: peer("a", {
    HostName: "host\n\u001b\u202e", DNSName: null, OS: null,
    TailscaleIPs: ["100.64.0.1", "100.64.0.1", "::1", "not-an-ip", 5],
  }), b: { ID: "b" } }));
  const a = value.peers.find((entry) => entry.id === "a");
  assert.equal(a.name, "host");
  assert.equal(a.os, "unknown");
  assert.deepEqual(a.addresses, ["100.64.0.1", "::1"]);
  assert.equal(value.peers.find((entry) => entry.id === "b").online, null);
});

test("handles absent peers, empty maps, malformed shapes, and signed-out state", () => {
  assert.equal(summarizeStatus({ BackendState: "Running" }).status, "empty");
  assert.equal(summarizeStatus(snapshot(null)).status, "empty");
  for (const value of [null, [], {}, snapshot([]), { BackendState: "NeedsLogin" }, { BackendState: "Stopped" }]) {
    assert.equal(summarizeStatus(value).status, "unavailable");
  }
});

test("invokes only bounded local status, without a shell or per-peer commands", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify(snapshot({ a: peer("a") })), stderr: "PRIVATE-ERROR" };
  };
  const value = await discover(run, "linux");
  assert.equal(value.status, "ready");
  assert.deepEqual(calls, [["tailscale", ["status", "--json"], {
    ...limits, encoding: "utf8", windowsHide: true, shell: false,
  }]]);
  assert.ok(!JSON.stringify(value).includes("PRIVATE-ERROR"));
  calls.length = 0;
  await discover(run, "win32");
  assert.equal(calls[0][0], "tailscale.exe");
});

test("fails softly on missing binary, timeout, access denial, malformed or oversized output", async () => {
  for (const code of ["ENOENT", "ETIMEDOUT", "EACCES"]) {
    const value = await discover(async () => { throw Object.assign(new Error("SECRET stderr"), { code }); });
    assert.equal(value.status, "unavailable");
    assert.ok(!JSON.stringify(value).includes("SECRET"));
  }
  for (const stdout of ["not-json", "[]", "x".repeat(limits.maxBuffer + 1), Buffer.from("{}")]) {
    const value = await discover(async () => ({ stdout }));
    assert.equal(value.status, "unavailable");
  }
});
