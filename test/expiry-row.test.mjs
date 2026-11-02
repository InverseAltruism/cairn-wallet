// The propose card's Expires row follows the node's admission rule (compute-substrate src/state/utxo.rs: a Propose
// whose expires_epoch is below the epoch of the next block is refused). A record expiring in the next block's epoch
// is live: the node admits it and the resolver applies a transfer with no expiry check, so calling it "a no-op"
// let a site pass a token transfer off as harmless. Edges at tip 30k+28 and 30k+29, through expiryValue and through
// describe() with the fields approve.ts fills (currentEpoch, currentTip).
// Run: npx tsx test/expiry-row.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { expiryValue, describe } from "../src/popup/clearsign.js";
import { buildTransfer, CAIRNX_DOMAIN } from "../src/core/cairnx.js";

const { check, done } = checker("the Expires row by the node's admission rule:");
const k = 4_233, ep = (tip) => Math.floor(tip / 30);
const PAST = "already past: the node will refuse it; nothing is spent";

let v = expiryValue(k, ep(30 * k + 28), 30 * k + 28);
check(`tip 30k+28, expires k: live for the epoch's last block (${v})`, v === `epoch ${k} (expires at the end of this epoch, in about 1 block)`);
v = expiryValue(k, ep(30 * k + 29), 30 * k + 29);
check(`tip 30k+29, expires k: the next block is in epoch k+1, so refused (${v})`, v.includes(PAST) && v.startsWith(`epoch ${k} `));
v = expiryValue(k + 1, ep(30 * k + 29), 30 * k + 29);
check(`tip 30k+29, expires k+1: live for all 30 blocks of the next epoch (${v})`, v === `epoch ${k + 1} (expires at the end of this epoch, in about 30 blocks)`);
v = expiryValue(k, ep(30 * k), 30 * k);
check(`tip 30k, expires k: live, 29 blocks (${v})`, v === `epoch ${k} (expires at the end of this epoch, in about 29 blocks)`);
v = expiryValue(k - 1, ep(30 * k + 5), 30 * k + 5);
check(`expires an epoch before the tip's: refused (${v})`, v.includes(PAST));
v = expiryValue(k + 24, ep(30 * k + 5), 30 * k + 5);
check(`a later epoch keeps the humanized window (${v})`, v === `epoch ${k + 24} (in ~1 day(s), current epoch ${k})`);
// Without a tip (the read missed) the epoch alone decides what it can: below it is past, equal to it is this epoch.
v = expiryValue(k - 1, k);
check(`no tip, expires below the current epoch: refused (${v})`, v.includes(PAST));
v = expiryValue(k, k);
check(`no tip, expires in the current epoch: live to its end, block count unknown (${v})`, v === `epoch ${k} (expires at the end of this epoch)`);

// describe(), the production call shape: the card shows the transfer rows and the live expiry, with no "no-op".
const t = buildTransfer({ ticker: "CAIRN", amount: "1000", to: "0x" + "77".repeat(20) });
const tip = 30 * k + 10;
const html = describe({ method: "propose", origin: "https://dapp.example", currentEpoch: ep(tip), currentTip: tip, params: { domain: CAIRNX_DOMAIN, uri: t.uri, payloadHash: t.payloadHash, expiresEpoch: k, fee: 25_000_000 } });
check("describe(): a transfer expiring in the next block's epoch reads live, never a no-op", html.includes("expires at the end of this epoch, in about 19 blocks") && !/no-op/.test(html));

done("expiry-row");
