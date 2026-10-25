// Post to Cairn and Seal a claim.
import { explorerLink } from "../core/explorer.js";
import { parseUnits, CAIRNX_PROPOSE_FEE } from "../core/cairnx.js";
import { escapeHtml } from "./clearsign.js";
import { call, refusedCopy, thrownCopy } from "./popup-bridge.js";
import { $, busy, msg, val } from "./popup-dom.js";
import { currentExplorer } from "./popup-state.js";
import { openPanel } from "./popup-panels.js";
import { refreshBalance } from "./popup-balance.js";

$("btn-post-t").addEventListener("click", () => { if (openPanel("post-form")) populateDomains(); });
// Fill the category dropdown from the live Cairn board (/api/domains), with a
// "+ new category…" option for open domains. Falls back to the built-in vocabulary
// offline. Cached per popup so reopening is instant.
let domainsCache: string[] | null = null;
const FALLBACK_DOMAINS = ["csd:apps", "csd:features", "csd:bugs", "csd:bounties", "csd:docs", "csd:tools", "csd:integrations", "csd:signals", "csd:quests"];
async function populateDomains() {
  const sel = $("p-domain") as HTMLSelectElement;
  const custom = $("p-domain-custom") as HTMLInputElement;
  custom.hidden = true;
  let domains = domainsCache || FALLBACK_DOMAINS;
  if (!domainsCache) {
    try {
      const st = await call("status");
      const j = await (await fetch(`${st.api}/api/domains`)).json();
      if (j && Array.isArray(j.domains) && j.domains.length) { domains = j.domains.map((d: any) => d.key); domainsCache = domains; }
    } catch { /* offline → fallback vocabulary */ }
  }
  sel.innerHTML = domains.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("") + `<option value="__custom__">+ new category…</option>`;
  sel.value = domains.includes("csd:apps") ? "csd:apps" : (domains[0] ?? "");   // an empty list selects no option either way
  sel.onchange = () => { const isCustom = sel.value === "__custom__"; custom.hidden = !isCustom; if (isCustom) custom.focus(); };
}

$("btn-seal-t").addEventListener("click", () => { if (openPanel("seal-form")) renderSealed(); });
$("btn-seal").addEventListener("click", async () => {
  const claim = val("seal-claim").trim(); if (!claim) return msg("enter a claim to seal", "err");
  const domain = val("seal-domain").trim() || "csd:sealed";
  try { busy("sealing…"); const r = await call("sealClaim", { domain, claim });
    if (r.ok) { msg(`seal submitted · ${String(r.txid).slice(0, 12)}…; you can reveal it once it is mined`, "ok"); (($("seal-claim")) as HTMLTextAreaElement).value = ""; renderSealed(); refreshBalance(); }
    else {
      const o = refusedCopy(r, "seal");
      if (o.maybe) { (($("seal-claim")) as HTMLTextAreaElement).value = ""; renderSealed(); refreshBalance(); }
      msg(o.text, o.cls);
    }
  } catch (e: any) { const o = thrownCopy(e, "seal"); msg(o.text, o.cls); }
});
export async function renderSealed() {
  const list: any[] = await call("sealedClaims");
  const el = $("seal-list");
  if (!list.length) { el.innerHTML = `<div class="dim" style="padding:6px 0">No sealed claims yet. Seal one above; it stays secret until you reveal.</div>`; return; }
  el.innerHTML = list.map((s) => {
    const when = s.committedTs ? new Date(s.committedTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    // a maybe-path seal's anchor may never have landed (0.2.57): say so; revealing it would fail
    // its on-chain commit check, and the honest state is "verify the anchor first".
    const status = s.revealed ? `<span style="color:var(--green)">✅ revealed</span>`
      : s.maybe ? `🔒 sealed <span class="dim">(anchor may not have landed: check the txid on the explorer)</span>` : `🔒 sealed`;
    const right = s.revealed
      ? `<a href="${escapeHtml(explorerLink(currentExplorer, "tx", String(s.txid)))}" target="_blank" rel="noopener noreferrer">${String(s.txid).slice(0, 10)}… ↗</a>`
      : `<button class="mini" data-reveal="${escapeHtml(String(s.txid))}">Reveal</button>`;
    return `<div class="tx"><div class="tx-top"><span class="tx-kind">${status}</span><span class="dim">${when}</span></div>
      <div class="tx-sub"><span class="dim">${escapeHtml(String(s.claim).slice(0, 44))}</span>${right}</div></div>`;
  }).join("");
  el.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", async () => {
    const id = (b as HTMLElement).dataset.reveal!; busy("revealing…");
    const r = await call("revealClaim", id);
    (r && r.ok) ? msg("revealed ✓: now public + provably committed earlier", "ok") : msg("reveal failed: " + ((r && r.error) || "?"), "err");
    renderSealed();
  }));
}

$("btn-post").addEventListener("click", async () => {
  const sel = ($("p-domain") as HTMLSelectElement).value;
  const domain = (sel === "__custom__" ? val("p-domain-custom").trim() : sel);
  if (!/^csd:[a-z0-9:_-]+$/i.test(domain)) return msg("pick a category or enter one like csd:tools", "err");
  if (!val("p-title").trim()) return msg("enter a title", "err");
  try {
    const feeStr = parseUnits((val("p-fee").trim() || "0.25"), 8); // strict parse (audit AMT-1); no "1e3"/"1,000"/half-sat
    if (feeStr === null) return msg("enter a valid fee (e.g. 0.25)", "err");
    const feeNum = Number(feeStr);
    if (!Number.isSafeInteger(feeNum)) return msg("fee out of range", "err"); // parity with the send-amount path (safe-integer backstop)
    const fee = Math.max(feeNum, CAIRNX_PROPOSE_FEE);
    busy("posting…");
    const r = await call("cairnPost", { domain, title: val("p-title"), body: val("p-body"), fee });
    if (r.ok) { msg("posted · " + String(r.txid).slice(0, 12) + "… (shows on Cairn once it is mined)", "ok"); refreshBalance(); }
    else {
      const o = refusedCopy(r, "post");
      if (o.maybe) refreshBalance();
      msg(o.text, o.cls);
    }
  } catch (e: any) { const o = thrownCopy(e, "post"); msg(o.text, o.cls); }
});
