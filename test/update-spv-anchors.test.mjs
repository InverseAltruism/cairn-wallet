// scripts/update-spv-anchors.mjs: every refusal writes nothing, the honest path writes the walked table, and the CI
// check mode refuses a table the served chain or the public RPC does not back. Offline: the walk runs the real
// vendored LightClient over 192 real headers (29,888 to 30,079), with a 64-height chunk and page so that fixture
// spans two chunk tops (30,015 and 30,079).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";
import { generate, check, renderTable, parseTable, getJson } from "../scripts/update-spv-anchors.mjs";
import { CP } from "../src/core/namespv.ts";

const t = checker("update-spv-anchors: generator refusals, honest path, CI check");
const ROWS = JSON.parse(readFileSync(new URL("./fixtures/headers-29888-30079.json", import.meta.url), "utf8"));
const at = (h) => ROWS.find((r) => r.height === h);
const CHUNK = 64, PAGE = 64;
const TOP1 = 30015, TOP2 = 30079;
const quiet = { sleep: async () => {} };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
// Serves /api/headers from the fixture; `tamper(from, rows)` may rewrite one page.
function headersFetch(tamper = (_f, rows) => rows, log = []) {
  return async (url) => {
    log.push(url);
    const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(url);
    if (!m) return json({ ok: false }, 404);
    const from = Number(m[1]), n = Number(m[2]);
    const rows = ROWS.filter((r) => r.height >= from && r.height < from + n).map((r) => structuredClone(r));
    return json({ ok: true, from, count: n, headers: tamper(from, rows) });
  };
}
const rpcFetch = ({ tip = TOP2 + 2000, answer = (h) => ({ ok: true, height: h, hash: at(h).hash }) } = {}) => async (url) => {
  const b = /\/block\/height\/(\d+)$/.exec(url);
  if (b) { const a = answer(Number(b[1])); return a instanceof Response ? a : json(a); }
  if (url.endsWith("/tip")) return json({ height: tip });
  return headersFetch()(url);
};

function table(anchors = []) {
  const p = join(mkdtempSync(join(tmpdir(), "spvanchors-")), "spvanchors.ts");
  writeFileSync(p, renderTable({ floor: CP, chunk: CHUNK, anchors }));
  return p;
}
const c1 = (over = {}) => JSON.stringify({
  v: 1, height: TOP2, hash: at(TOP2).hash, tip: TOP2 + 1000, margin: 1000,
  sources: [{ role: "node", answer: "yes" }, { role: "miner", answer: "yes" }, { role: "third", answer: "yes", routing: "primary" }],
  ...over,
});
const gen = (tablePath, c1Text, fetch = headersFetch()) => generate({ c1Text, tablePath, base: "http://h.test", write: true, chunk: CHUNK, pageSize: PAGE, paceMs: 0, io: { ...quiet, fetch } });

async function refuses(name, tablePath, run, msgRe) {
  const before = readFileSync(tablePath);
  let err = null;
  try { await run(); } catch (e) { err = e; }
  t.check(`${name}: refused (${err?.message ?? "no error"})`, !!err && msgRe.test(err.message));
  t.check(`${name}: table bytes unchanged`, readFileSync(tablePath).equals(before));
}

// Honest path: the real walk writes both chunk tops, and the file round-trips through the strict parser.
{
  const p = table();
  const r = await gen(p, c1());
  const back = parseTable(readFileSync(p, "utf8"));
  t.check("honest: 2 entries written, newest 30079", r.entries === 2 && r.newest === TOP2);
  t.check("honest: entries are the walked hashes at 30015 and 30079", back.anchors[0] === at(TOP1).hash && back.anchors[1] === at(TOP2).hash);
  t.check("honest: floor carried forward from the committed table", back.floor.hash === CP.hash && back.floor.height === CP.height);
  const dry = table();
  const before = readFileSync(dry);
  await generate({ c1Text: c1(), tablePath: dry, base: "http://h.test", chunk: CHUNK, pageSize: PAGE, paceMs: 0, io: { ...quiet, fetch: headersFetch() } });
  t.check("honest dry run (no --write): nothing written", readFileSync(dry).equals(before));
}

// Each C1 JSON rule.
const BAD_C1 = [
  ["empty stdout", "", /empty or not JSON/],
  ["not JSON", "{oops", /empty or not JSON/],
  ["v 2", c1({ v: 2 }), /v must be 1/],
  ["two sources", c1({ sources: [{ role: "node", answer: "yes" }, { role: "third", answer: "yes", routing: "primary" }] }), /exactly three sources/],
  ["role repeated", c1({ sources: [{ role: "node", answer: "yes" }, { role: "node", answer: "yes" }, { role: "third", answer: "yes", routing: "primary" }] }), /exactly three sources/],
  ["miner says no", c1({ sources: [{ role: "node", answer: "yes" }, { role: "miner", answer: "no" }, { role: "third", answer: "yes", routing: "primary" }] }), /answer yes/],
  ["third unreachable", c1({ sources: [{ role: "node", answer: "yes" }, { role: "miner", answer: "yes" }, { role: "third", answer: "unreachable", routing: "primary" }] }), /answer yes/],
  ["third routing unknown", c1({ sources: [{ role: "node", answer: "yes" }, { role: "miner", answer: "yes" }, { role: "third", answer: "yes", routing: "unknown" }] }), /primary backend/],
  ["margin 999", c1({ margin: 999 }), /margin must be at least 1000/],
  ["height 999 below tip", c1({ tip: TOP2 + 999 }), /below tip/],
  ["uppercase hash", c1({ hash: at(TOP2).hash.toUpperCase().replace("0X", "0x") }), /lowercase hex/],
  ["height not a chunk top", c1({ height: TOP2 - 1, hash: at(TOP2 - 1).hash }), /chunk top/],
  ["height below the first chunk top", c1({ height: 29951, tip: 31000, hash: at(29951).hash }), /first chunk top/],
];
for (const [name, text, re] of BAD_C1) { const p = table(); await refuses(`C1 ${name}`, p, () => gen(p, text), re); }

// The walk, and the pages it reads.
{
  let p = table();
  await refuses("walk does not reach the corroborated hash", p, () => gen(p, c1({ hash: at(TOP2 - 1).hash })), /not the corroborated/);
  p = table();
  await refuses("short page", p, () => gen(p, c1(), headersFetch((f, rows) => (f === 29952 ? rows.slice(0, 63) : rows))), /63 rows, want 64/);
  p = table();
  await refuses("non-contiguous page", p, () => gen(p, c1(), headersFetch((f, rows) => (f === 29952 ? [...rows.slice(0, 5), rows[6], rows[5], ...rows.slice(7)] : rows))), /row 5 is not height 29957/);
  p = table();
  await refuses("served header that does not hash to its row", p, () => gen(p, c1(), headersFetch((f, rows) => { if (f === 30016) rows[3].header.nonce ^= 1; return rows; })), /hash mismatch at 30019/);
  p = table(["0x" + "11".repeat(32)]);
  await refuses("new table does not extend the committed one", p, () => gen(p, c1()), /does not extend the committed one \(first difference at entry 0\)/);
  const log = [];
  await gen(table(), c1(), headersFetch(undefined, log));
  t.check(`every request is one aligned page (${log.join(" ")})`, log.length === 3 && log.every((u) => /\/api\/headers\/(29888|29952|30016)\/64$/.test(u)));
}

// Check mode (the CI job).
{
  const ck = (tablePath, opts = {}) => check({ tablePath, headers: "http://h.test", rpc: "http://rpc.test", pageSize: PAGE, paceMs: 0, io: { ...quiet, fetch: rpcFetch(opts) } });
  const good = table([at(TOP1).hash, at(TOP2).hash]);
  const r = await ck(good);
  t.check("check honest: passes with 2 entries", r.entries === 2 && r.newest === TOP2);
  t.check("check honest: tip exactly 6000 above the newest entry passes", (await ck(good, { tip: TOP2 + 6000 })).tip === TOP2 + 6000);
  await refuses("check: newest entry more than 6000 below the tip", good, () => ck(good, { tip: TOP2 + 6001 }), /more than 6000 below/);
  const forged = table([at(TOP1).hash, at(TOP2 - 1).hash]);
  await refuses("check: an entry the walk does not reach", forged, () => ck(forged), /entry 1 \(height 30079\)/);
  await refuses("check: the public RPC names another hash", good, () => ck(good, { answer: (h) => ({ ok: true, height: h, hash: at(h - 1).hash }) }), /answers "no" for entry 0/);
  await refuses("check: the public RPC answers for another height", good, () => ck(good, { answer: (h) => ({ ok: true, height: h + 1, hash: at(h).hash }) }), /answers "no"/);
  await refuses("check: the public RPC cannot answer", good, () => ck(good, { answer: () => json({ error: "x" }, 500) }), /answers "unreachable"/);
  const edited = table([at(TOP1).hash, at(TOP2).hash]);
  writeFileSync(edited, readFileSync(edited, "utf8").replace("];", "  ];"));
  await refuses("check: a hand-edited table", edited, () => ck(edited), /hand-edited/);
}

// Pacing: a 429 waits the server's Retry-After before the retry.
{
  const waits = [];
  let n = 0;
  const fetch = async () => (n++ === 0 ? json({}, 429, { "retry-after": "7" }) : json({ ok: true }));
  const r = await getJson("http://x.test/a", { fetch, sleep: async (ms) => { waits.push(ms); } });
  t.check("429 honours Retry-After (7 s) then succeeds", r.ok === true && waits.length === 1 && waits[0] === 7000);
}

t.done("update-spv-anchors");
