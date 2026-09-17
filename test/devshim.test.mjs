// devshim must throw at module load when the extension message surface exists, and
// must forward the same expectSigner / remove-account password the background does.
let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

const prev = globalThis.chrome;
globalThis.chrome = { runtime: { sendMessage: () => {} } };
let threw = false, msg = "";
try {
  await import(`../src/popup/devshim.ts?throw=${Date.now()}`);
} catch (e) {
  threw = true;
  msg = String(e?.message || e);
} finally {
  if (prev === undefined) delete globalThis.chrome;
  else globalThis.chrome = prev;
}
ok("devshim throws at module load when chrome.runtime.sendMessage exists", threw);
ok("throw names the extension surface", /must not load in the extension/.test(msg));

console.log(`\ndevshim: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
