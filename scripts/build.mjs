import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const output = new URL("dist/extension/", root);
await mkdir(output, { recursive: true });
await build({ entryPoints: ["background", "popup"].map(name => fileURLToPath(new URL(`extension/src/${name}.ts`, root))),
  outdir: fileURLToPath(output), bundle: true, format: "iife", target: "chrome120", legalComments: "none",
  // A release download registers its own host binary; a checkout registers through the CLI.
  define: { REGISTRATION_COMMAND: JSON.stringify(process.env.BROWSER_AGENT_REGISTRATION
    || `node "${fileURLToPath(new URL("cli/browserAgent.ts", root))}" register`) } });
const manifest = JSON.parse(await readFile(new URL("extension/manifest.json", root), "utf8"));
manifest.version = JSON.parse(await readFile(new URL("package.json", root), "utf8")).version;
manifest.action.default_popup = "popup.html";
await writeFile(new URL("manifest.json", output), JSON.stringify(manifest, null, 2) + "\n");
await copyFile(new URL("extension/popup.html", root), new URL("popup.html", output));
for (const size of [16, 32, 48, 128])
  await sharp(fileURLToPath(new URL("extension/icon.svg", root))).resize(size, size).png().toFile(fileURLToPath(new URL(`icon${size}.png`, output)));
// Page scripts (`*Hook.ts` beside their tool) become standalone files that tools register by `hooks/<name>.js`.
const sources = fileURLToPath(new URL("extension/src/tools/", root));
const hooks = (await readdir(sources, { recursive: true })).filter(file => /Hook\.ts$/.test(file));
if (hooks.length)
  await build({ entryPoints: hooks.map(file => `${sources}/${file}`), outdir: fileURLToPath(new URL("hooks/", output)), entryNames: "[name]",
    bundle: true, format: "iife", target: "chrome120", legalComments: "none" });
execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: fileURLToPath(new URL("host/", root)), stdio: "inherit" });
console.log("Load unpacked: dist/extension");
console.log("Native host: host/target/release; run node cli/browserAgent.ts register to install it");
