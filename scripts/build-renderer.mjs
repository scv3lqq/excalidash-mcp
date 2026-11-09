import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = new URL("node_modules/@excalidraw/excalidraw/", root);
if (JSON.parse(await readFile(new URL("package.json", pkg), "utf8")).version !== "0.18.1") {
  throw new Error("Renderer requires the audited @excalidraw/excalidraw@0.18.1");
}
await mkdir(new URL("dist/", root), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/renderer-entry.ts", root))],
  outfile: fileURLToPath(new URL("dist/renderer.js", root)),
  bundle: true, platform: "browser", format: "iife", target: "chrome120",
  define: { "process.env.NODE_ENV": '"production"' }, minify: true,
  legalComments: "eof", loader: { ".woff2": "file" },
  assetNames: "renderer-fonts/[name]",
});
await cp(new URL("dist/prod/fonts/", pkg), new URL("dist/renderer-fonts/", root), { recursive: true });
// The route handler accepts this immutable build inventory, never caller paths.
const assets = {};
async function collect(relative) {
  for (const entry of await readdir(new URL(`dist/${relative}`, root), { withFileTypes: true })) {
    const path = `${relative}${entry.name}`;
    if (entry.isDirectory()) await collect(`${path}/`);
    else if (path.endsWith(".woff2")) assets[`/fonts/${path.slice("renderer-fonts/".length)}`] = path;
  }
}
await collect("renderer-fonts/");
assets["/renderer.js"] = "renderer.js";
const inventory = {};
for (const [url, path] of Object.entries(assets)) {
  inventory[url] = { path, sha256: createHash("sha256").update(await readFile(new URL(`dist/${path}`, root))).digest("hex") };
}
await writeFile(new URL("dist/renderer-assets.json", root), `${JSON.stringify(inventory)}\n`);
await cp(new URL("assets/excalidraw-NOTICES.txt", root), new URL("dist/excalidraw-NOTICES.txt", root));
