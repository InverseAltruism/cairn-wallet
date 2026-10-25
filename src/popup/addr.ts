// Address display shared by the popup's views.
import { escapeHtml } from "./clearsign.js";

export const short = (a: string) => a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a;

// An address in groups of four for comparing by eye; the spans hold no spaces, so its text is the raw address.
export const groupedAddr = (a: string) => (a.match(/^0x.{0,4}|.{1,4}/g) || []).map((g) => `<span>${escapeHtml(g)}</span>`).join("");
