import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import type { RenderPayload, RenderGeometry } from "./drawing-renderer.js";

type Asset = { path: string; sha256: string };
const origin = "https://renderer.invalid";
function initializeRenderer(fontPaths: string[]): void {
  const allowed = new Set(fontPaths);
  const NativeFontFace = window.FontFace;
  window.FontFace = class extends NativeFontFace {
    constructor(family: string, source: ConstructorParameters<typeof FontFace>[1], descriptors?: FontFaceDescriptors) {
      if (typeof source === "string" && !(source === "" && ["Helvetica", "Segoe UI Emoji"].includes(family))) {
        const localSources = source.split(",").filter(entry => {
          const match = /url\((.*?)\)/.exec(entry);
          if (!match) return false;
          const path = match[1]!.trim().replace(/^['"]|['"]$/g, "");
          const url = new URL(path, window.location.href);
          return url.origin === window.location.origin && !url.search && allowed.has(url.pathname);
        });
        if (!localSources.length) throw new Error("Font has no supported immutable local asset");
        super(family, localSources.join(","), descriptors);
      } else super(family, source, descriptors);
    }
  };
  window.__rendererCspViolation = "";
  document.addEventListener("securitypolicyviolation", event => { window.__rendererCspViolation = event.effectiveDirective; });
  Object.defineProperty(window, "EXCALIDRAW_ASSET_PATH", { value: `${window.location.origin}/` });
  Object.defineProperty(window, "Worker", { value: undefined });
  Object.defineProperty(window, "SharedWorker", { value: undefined });
}
function rendererHtml(fontPaths: string[]): string {
  const bootstrap = `(${initializeRenderer.toString()})(${JSON.stringify(fontPaths)})`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; font-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body style="margin:0"><script>${bootstrap}</script><script src="/renderer.js"></script></body></html>`;
}

process.once("message", async (message: { endpoint: string; payload: RenderPayload }) => {
  let browser;
  try {
    const inventory = JSON.parse(await readFile(new URL("./renderer-assets.json", import.meta.url), "utf8")) as Record<string, Asset>;
    const assets = new Map<string, Buffer>();
    for (const [path, asset] of Object.entries(inventory)) {
      if (!/^\/(?:renderer\.js|fonts\/[\w./-]+\.woff2)$/.test(path) || !/^(?:renderer\.js|renderer-fonts\/[\w./-]+\.woff2)$/.test(asset.path) || asset.path.includes("..")) throw new Error("Invalid renderer asset inventory");
      const data = await readFile(new URL(asset.path, import.meta.url));
      if (createHash("sha256").update(data).digest("hex") !== asset.sha256) throw new Error("Renderer asset integrity mismatch");
      assets.set(path, data);
    }
    const html = rendererHtml([...assets.keys()].filter(path => path.startsWith("/fonts/")));
    browser = await chromium.connect(message.endpoint);
    const region = message.payload.options.region;
    const viewport = region ? {
      width: Math.max(1, Math.ceil((region.width + message.payload.options.padding * 2) * message.payload.options.scale)),
      height: Math.max(1, Math.ceil((region.height + message.payload.options.padding * 2) * message.payload.options.scale)),
    } : { width: 1280, height: 720 };
    const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true, bypassCSP: false, deviceScaleFactor: 1 });
    let blockedAsset = false;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.search || route.request().method() !== "GET") { blockedAsset = true; return route.abort("blockedbyclient"); }
      if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
      const asset = assets.get(url.pathname);
      if (!asset) { blockedAsset = true; return route.abort("blockedbyclient"); }
      await route.fulfill({ status: 200, contentType: url.pathname.endsWith(".woff2") ? "font/woff2" : "application/javascript", body: asset });
    });
    const page = await context.newPage();
    let scriptError: string | undefined;
    page.on("pageerror", error => { scriptError = error.message; });
    page.on("download", download => { void download.cancel(); });
    page.on("popup", popup => { void popup.close(); });
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 10_000 });
    await page.waitForFunction(() => typeof window.renderScene === "function", null, { timeout: 5000 });
    const result: RenderGeometry & { data: string } = await page.evaluate(payload => window.renderScene(payload), message.payload);
    if (message.payload.options.region && !result.data) {
      if (result.width !== viewport.width || result.height !== viewport.height) throw new Error("Renderer viewport bounds mismatch");
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      result.data = (await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: result.width, height: result.height }, omitBackground: true })).toString("base64");
    }
    if (blockedAsset) throw new Error("Renderer requested an unavailable or external asset; refusing font/image fallback");
    const violation = await page.evaluate(() => window.__rendererCspViolation);
    if (violation) throw new Error(`Renderer CSP blocked ${violation}; refusing font/image fallback`);
    if (scriptError) throw new Error(`Renderer script failed: ${scriptError}`);
    if (result.data.length > Math.ceil(4 * 1024 * 1024 * 4 / 3) + 4) throw new Error("Render output limit is 4 MiB");
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : "Render worker failed" });
  } finally {
    await browser?.close().catch(() => undefined);
    process.disconnect?.();
  }
});
