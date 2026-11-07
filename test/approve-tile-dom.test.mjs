// The approval window's requester tile shows the requesting site's initial, never Cairn's own mark: a look-alike origin
// must not sit under the product's mark where the user decides. The origin's host (without "www.") gives the initial;
// the locked view keeps the Cairn mark. Through the REAL approve.ts on helpers/approve-dom.mjs, and approve.html.
// Run: npx tsx test/approve-tile-dom.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("approval window: the requester tile is the site's initial:");
const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "src/popup/approve.html"), "utf8");
const tileTag = /<span[^>]*class="ap-tile"[^>]*>([\s\S]*?)<\/span>/.exec(html);
check("approve.html's requester tile holds no Cairn mark", !!tileTag && !/mark\.svg#mark/.test(tileTag[1]));
check("the locked view keeps the Cairn mark", /<section id="view-locked"[\s\S]*?ui\/mark\.svg#mark/.test(html));

const ME = "0x" + "ab".repeat(20);
const state = { pending: [] };
const { registry } = mountApproveWindow({
  status: () => ({ unlocked: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending, balance: () => ({ confirmed: 5_000_00000000 }), history: () => [],
  tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 116_520, epoch: () => 3_884, tipFloor: () => 0,
  resolve: () => ({ done: true, ok: true }), unlock: () => true,
});
const req = (id, origin) => ({ id, method: "connect", origin, params: {} });
state.pending = [req("t1", "https://evil.example")];
const tick = await loadApprove();
await flush(); await sleep(20); await flush();
const tile = () => registry.get("ap-tile");
check(`https://evil.example: the tile shows "e" (${tile()?.textContent})`, tile()?.textContent === "e" && !/mark/.test(tile()?.innerHTML ?? ""));
for (const [i, [origin, want]] of [["https://www.cairn-substrate.com", "c"], ["http://localhost:5173", "l"], ["https://9lives.example", "9"]].entries()) {
  state.pending = [req("t" + (i + 2), origin)];
  await tick(); await flush();
  check(`${origin}: the tile shows "${want}" (${tile()?.textContent})`, tile()?.textContent === want);
}
done("approve-tile-dom");
