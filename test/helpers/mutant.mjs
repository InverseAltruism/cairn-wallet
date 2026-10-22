// Red-first mutation runs against the Wallet: copy the src/core module that carries `marker` with that one line
// removed, load a Wallet that runs the copy, and delete every copy afterwards. The marker may sit in wallet.ts
// or in a module wallet.ts imports directly; in the second case a copy of wallet.ts with that one import pointed
// at the mutant is loaded, so `mod.Wallet` runs the mutated guard either way.
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core");

function dropMarkerLine(src, marker, file) {
  const lines = src.split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`marker ${marker} must match exactly one line in ${file} (matched ${lines.length - kept.length})`);
  return kept.join("\n");
}

export async function withWalletMutant(marker, run) {
  const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts") && !f.startsWith("__") && readFileSync(path.join(coreDir, f), "utf8").includes(marker));
  if (files.length !== 1) throw new Error(`marker ${marker} must sit in exactly one src/core module (found in ${files.join(", ") || "none"})`);
  const file = files[0];
  const stamp = `${process.pid}_${Date.now()}`;
  const mutant = `__mutant_${path.basename(file, ".ts")}_${stamp}`;
  const written = [path.join(coreDir, mutant + ".ts")];
  writeFileSync(written[0], dropMarkerLine(readFileSync(path.join(coreDir, file), "utf8"), marker, file));
  try {
    let entry = written[0];
    if (file !== "wallet.ts") {
      const wsrc = readFileSync(path.join(coreDir, "wallet.ts"), "utf8");
      const spec = `from "./${path.basename(file, ".ts")}.js";`;
      if (wsrc.split(spec).length !== 2) throw new Error(`wallet.ts must import ./${file} on exactly one line`);
      entry = path.join(coreDir, `__mutant_wallet_${stamp}.ts`);
      written.push(entry);
      writeFileSync(entry, wsrc.replace(spec, `from "./${mutant}.js";`));
    }
    return await run(await import(pathToFileURL(entry).href));
  } finally {
    for (const f of written) unlinkSync(f);
  }
}
