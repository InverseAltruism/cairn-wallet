// The checks a page's request passes before background.ts queues it and opens the approval window.
import { attestRequestRefusal, fillRefusal } from "./fillpreflight.js";
import { proposeFeeRefusal, proposeRefusal, sendRefusal } from "./node.js";
import { attestFields, fillFields, proposeFields, revealFields, sealFields, sendFields } from "./signfields.js";
import { siwcParamsRefusal } from "./siwcparams.js";

/** Why the wallet refuses a page's request before it is queued, or undefined: the refusal the signer gives it after
 *  approval, from the same function. A function of the method, the parameters and (for a sign-in) the origin alone: no
 *  read, no wait and no wallet state, so the answer tells a page nothing about the wallet. What needs coins or reads
 *  (the proportional fee cap, the balance, the fill preflight, the stored seal) stays at signing. Every method whose
 *  request the window paints is here or takes no parameters, and the window paints every request that passes
 *  (test/request-shape-fuzz.test.mjs). */
export function prequeueRefusal(method: string, params: unknown, origin: string): string | undefined {
  switch (method) {
    case "signinWithCsd": return siwcParamsRefusal(params, origin) ?? undefined;
    case "propose": return proposeRefusal(proposeFields(params))?.error;
    case "sealClaim": { const sf = sealFields(params); return sf.refused ?? proposeFeeRefusal(sf.fee)?.error; }
    case "send": return sendRefusal(sendFields(params))?.error;
    case "fillOffer": return fillRefusal(fillFields(params))?.error;
    case "attest": return attestRequestRefusal(attestFields(params))?.error;
    case "revealClaim": return revealFields(params).shape;
    default: return undefined;
  }
}
