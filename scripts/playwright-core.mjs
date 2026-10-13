// playwright-core is not a dependency of this repo (dev tools and the in-Chrome tests only). Resolution order:
// PLAYWRIGHT_CORE (the package directory or its index.mjs), this repo's node_modules, then normal module
// resolution from here. Returns null when none is found, so a caller can skip with a reason.
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function findChromium() {
  const env = process.env.PLAYWRIGHT_CORE;
  const candidates = [
    env && existsSync(env) && statSync(env).isDirectory() ? join(env, "index.mjs") : env,
    join(ROOT, "node_modules", "playwright-core", "index.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return (await import(pathToFileURL(c).href)).chromium;
  }
  try {
    return (await import(pathToFileURL(createRequire(import.meta.url).resolve("playwright-core")).href)).chromium;
  } catch { return null; /* not installed anywhere on the resolution path */ }
}

export async function loadChromium() {
  const chromium = await findChromium();
  if (!chromium) throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=/path/to/playwright-core or `npm i -D playwright-core`");
  return chromium;
}
