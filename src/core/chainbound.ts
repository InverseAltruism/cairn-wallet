// The lowest height the chain can be at for this release and this install. A leaf: it imports only the generated
// height, so the approval window's bundle can use it without the anchor table or the light client
// (test/chainbound.test.mjs checks both bundles).
import { SPV_NEWEST_HEIGHT } from "./spvnewest.js";

/** The stored floor (namespv.ts floorAdvance) or the release's newest anchor, whichever is higher. Every chain this
 *  release accepts contains the anchor, a light-client checkpoint, so no served value can put the chain below it. A
 *  non-finite floor counts as 0. The offer-id fill checks, fee pricing and the approval window's fee, V28 and fill-card
 *  lines compare against it. */
export function lowestChainHeight(floor: number): number {
  return Math.max(Number.isFinite(floor) ? floor : 0, SPV_NEWEST_HEIGHT);
}
