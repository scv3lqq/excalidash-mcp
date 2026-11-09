import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyConfinement(uid, status) {
  assert.ok(Number.isInteger(uid) && uid > 0, "Browser smoke requires a non-root user");
  const fields = new Map(status.trim().split("\n").map(line => line.split(/:\s*/, 2)));
  assert.equal(fields.get("NoNewPrivs"), "1", "NoNewPrivs must be enabled");
  assert.match(fields.get("CapEff") ?? "", /^0+$/, "Effective capabilities must be empty");
  assert.equal(fields.get("Seccomp"), "2", "Seccomp filtering must be enabled");
}

export function verifySandbox(report) {
  const legacyNamespace = /^Namespace sandbox[ \t]+Yes[ \t]*\r?$/im.test(report);
  const modernNamespace = /^Layer 1 Sandbox[ \t]+Namespace[ \t]*\r?$/im.test(report)
    && /^PID namespaces[ \t]+Yes[ \t]*\r?$/im.test(report)
    && /^Network namespaces[ \t]+Yes[ \t]*\r?$/im.test(report);
  assert.ok(legacyNamespace || modernNamespace, "Namespace sandbox must be enabled with positive PID and network evidence");
  assert.match(report, /^Seccomp-BPF sandbox[ \t]+Yes[ \t]*\r?$/im, "Seccomp-BPF sandbox must be enabled");
}

export function verifyRender(scene, snapshot, result) {
  assert.deepEqual(scene, snapshot, "Rendering must preserve the source scene");
  assert.equal(result.version, snapshot.version, "Rendered version must match the source");
  assert.equal(result.renderer, "@excalidraw/excalidraw@0.18.1");
  assert.ok(result.png.length >= 33 && result.png.length <= 4 * 1024 * 1024);
  assert.equal(result.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(result.png.readUInt32BE(16), result.width);
  assert.equal(result.png.readUInt32BE(20), result.height);
  for (const size of [result.width, result.height]) assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 4096);
  assert.ok(result.width * result.height <= 4_000_000);
  assert.ok(result.bounds.x < 0 && result.bounds.y < 0, "Negative source coordinates must remain visible");
}

export function browserLaunchOptions(executablePath) {
  return {
    executablePath,
    chromiumSandbox: true,
    headless: true,
    timeout: 15_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" },
  };
}

async function main() {
  verifyConfinement(process.getuid?.(), await readFile("/proc/self/status", "utf8"));
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(browserLaunchOptions(chromium.executablePath()));
  try {
    const page = await browser.newPage();
    await page.goto("chrome://sandbox", { timeout: 15_000 });
    verifySandbox(await page.locator("body").innerText());
  } finally {
    await browser.close();
  }

  const { createShapeElement, createTextElement, createArrowElement } = await import("../dist/agent/elementFactory.js");
  const { renderDrawing } = await import("../dist/drawing-renderer.js");
  const scene = {
    version: 3,
    elements: [
      createShapeElement("rectangle", -240, -90, 160, 80),
      createTextElement(-210, -65, "Client"),
      createArrowElement(-75, -50, [[0, 0], [150, 0]], "arrow"),
      createTextElement(-35, -82, "HTTPS"),
      createShapeElement("rectangle", 80, -90, 160, 80),
      createTextElement(130, -65, "API"),
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  const snapshot = structuredClone(scene);
  const result = await renderDrawing(scene);
  verifyRender(scene, snapshot, result);
  console.log(JSON.stringify({
    confinement: { nonRoot: true, noNewPrivileges: true, capabilities: "none", seccomp: "filter" },
    sandbox: { namespace: true, seccompBpf: true },
    render: { mimeType: "image/png", width: result.width, height: result.height, bytes: result.png.length, version: result.version, renderer: result.renderer, sourceUnchanged: true },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
