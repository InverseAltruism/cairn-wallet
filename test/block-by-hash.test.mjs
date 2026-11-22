// The SPV source reads a block body by the hash of its verified header (`/block/<hash>`), not by height. The front door
// marks a finalized /api/rpc/block/<hash> answer immutable, so the edge serves it, and it debits no per-height budget;
// /block/height/<h> is never cached. The checks on the body are unchanged: bindBlock still requires the body to hash to
// the verified header's merkle root.
//   RED-FIRST: read by height in namespv.ts blockAt and sections 1 and 2 fail.
//   PAIRED HONEST PATHS: the body read by hash returns the verified header's merkle root, below the newest anchor and
//   above it (1); a body served under that hash that is another block's still fails the merkle bind (3).
// Run: npx tsx test/block-by-hash.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, hashOf, headerOf, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";
import { liveSpvSource } from "../src/core/namespv.ts";
import { bindBlock } from "../src/core/spvbind.ts";

const { check, done } = checker("block bodies by verified hash:");
const API = "https://cairn-substrate.test", RPC = `${API}/api/rpc`;
const net = {};
serveFixture(net);
const urls = [];
{
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { urls.push(String(url)); return inner(url, init); };
}
const kv = new Map();
const src = await liveSpvSource({
  rpcBase: RPC, headersBase: API, anchors: FIX_ANCHORS, store: async () => memStore(), legacy: legacyOf(kv),
  floor: { get: async () => Number(kv.get("spvNodeTipFloor")) || 0, set: async (v) => { kv.set("spvNodeTipFloor", v); } },
});
await src.prepare(FIX_TOP);

// 1. Below the newest anchor (from a walked chunk) and above it (from the light client).
for (const h of [30224, 115100]) {
  urls.length = 0;
  const b = await src.blockAt(h);
  const reads = urls.filter((u) => u.includes("/block/"));
  check(`1. block ${h}: one body read, by its verified hash (${reads.join(", ")})`, reads.length === 1 && reads[0] === `${RPC}/block/${hashOf(h)}`);
  check(`1. honest path: block ${h} returns the verified header's merkle root and the served body`, b.merkle === headerOf(h).merkle && typeof b.body === "string" && b.body.includes(hashOf(h)));
}
// 2. No body is read by height.
check("2. no /block/height/ read was made", !urls.some((u) => u.includes("/block/height/")));
// 3. A body served under the verified hash that is another block's (the real body of 30,224) fails the bind, as before.
{
  const NAME = JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8"));
  net.blocks = new Map([[30224, NAME.block], [30225, { ...NAME.block, height: 30225, hash: hashOf(30225) }]]);
  const honest = await bindBlock(src, 30224);
  check(`3. honest path: block 30224's real body binds to its verified header (${honest.ok})`, honest.ok === true);
  const wrong = await bindBlock(src, 30225).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  check(`3. the same body served as block 30225 is refused by the merkle bind (${JSON.stringify(wrong).slice(0, 120)})`, wrong.ok === false && wrong.kind !== "malformed");
}
done("block-by-hash");
