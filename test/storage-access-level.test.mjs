// The service worker restricts BOTH storage areas to trusted contexts at startup. chrome.storage.local holds the
// encrypted vault and the header snapshot; by default a content script (injected on every https page) can read and
// write it, so a compromised page renderer could take the vault ciphertext or poison the snapshot.
// Run: node --import tsx test/storage-access-level.test.mjs   (offline)
import assert from "node:assert/strict";

const calls = [];
const area = (name) => ({
  get: async () => ({}), set: async () => {}, remove: async () => {},
  setAccessLevel: async (o) => { calls.push([name, o && o.accessLevel]); },
});
globalThis.chrome = {
  storage: { local: area("local"), session: area("session"), onChanged: { addListener() {} } },
  runtime: { getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onConnect: { addListener() {} }, id: "x" },
  alarms: { create() {}, onAlarm: { addListener() {} }, clear: async () => true },
  windows: { create: async () => ({ id: 1 }), remove: async () => {}, onRemoved: { addListener() {} }, update: async () => {} },
  tabs: { query: async () => [], sendMessage: async () => {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  permissions: { contains: async () => true, request: async () => true },
};
await import("../src/background.ts");

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok ", name); };
ok("storage.local is restricted to trusted contexts", () => assert.ok(calls.some(([a, l]) => a === "local" && l === "TRUSTED_CONTEXTS"), JSON.stringify(calls)));
ok("storage.session stays restricted (unchanged)", () => assert.ok(calls.some(([a, l]) => a === "session" && l === "TRUSTED_CONTEXTS"), JSON.stringify(calls)));
console.log(`storage-access-level: ${pass} passed, 0 failed`);
