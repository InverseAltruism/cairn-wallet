// The lowest height the chain can be at for this release and this install. A leaf: it imports only the generated
// height, so the approval window's bundle can use it without the anchor table or the light client
// (test/chainbound.test.mjs checks both bundles).
import { SPV_NEWEST_HEIGHT } from "./spvnewest.js";

/** A served tip or a stored floor as a height: a positive safe integer, or 0 for anything else (a fraction, a negative,
 *  NaN, an infinity, a non-number), which every caller treats as absent. Each place a served or stored height enters the
 *  wallet's arithmetic reads it through this, so a value such as 139263.5 can neither be stored as the floor nor turn a
 *  comparison into one that drops the bound. */
export function heightOf(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/** The stored floor (namespv.ts floorAdvance) or the release's newest anchor, whichever is higher. Every chain this
 *  release accepts contains the anchor, a light-client checkpoint, so no served value can put the chain below it. A
 *  floor that is not a height (heightOf) counts as 0. The offer-id fill checks, fee pricing and the approval window's
 *  fee, V28 and fill-card lines compare against it. */
export function lowestChainHeight(floor: unknown): number {
  return Math.max(heightOf(floor), SPV_NEWEST_HEIGHT);
}
