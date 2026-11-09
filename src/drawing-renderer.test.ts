import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { deflateSync, inflateSync } from "node:zlib";
import test from "node:test";
import type { ExcalidrawElement } from "./agent/elementFactory.js";

type Bounds = { x: number; y: number; width: number; height: number };
type Scene = { version: number; elements: ExcalidrawElement[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
type Options = { scale?: number; background?: boolean; region?: Bounds; elementIds?: string[]; padding?: number };
type Result = { png: Buffer; version: number; bounds: Bounds; width: number; height: number; renderer: string };
type Renderer = { renderDrawing(scene: Scene, options?: Options): Promise<Result> };
const rendererModule = "./drawing-renderer.js";
const loadRenderer = async (): Promise<Renderer> => import(rendererModule) as Promise<Renderer>;
const evidence = "/tmp/excalidash-workflow-evidence";
const region: Bounds = { x: -100, y: -100, width: 500, height: 350 };
const box = (id: string, overrides: Record<string, unknown> = {}): ExcalidrawElement => ({
  id, type: "rectangle", x: 0, y: 0, width: 80, height: 60, angle: 0,
  strokeColor: "#111111", backgroundColor: "#ff0000", fillStyle: "solid", strokeWidth: 2,
  strokeStyle: "solid", roughness: 0, opacity: 100, seed: 42, version: 1,
  versionNonce: 7, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false, roundness: null, ...overrides,
});
const scene = (elements: ExcalidrawElement[], extra: Partial<Scene> = {}): Scene => ({ version: 17, elements, ...extra });

function pixels(result: Result): Buffer {
  const png = result.png;
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), result.width);
  assert.equal(png.readUInt32BE(20), result.height);
  assert.ok(png.length <= 4 * 1024 * 1024);
  assert.equal(result.renderer, "@excalidraw/excalidraw@0.18.1");
  assert.equal(result.version, 17);
  assert.equal(png[24], 8, "8-bit PNG required for independent content checks");
  assert.ok(png[25] === 2 || png[25] === 6, "RGB or RGBA PNG required for independent content checks");
  const channels = png[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = result.width * channels, rgba = Buffer.alloc(stride * result.height);
  assert.equal(raw.length, result.height * (stride + 1));
  for (let y = 0; y < result.height; y++) {
    const filter = raw[y * (stride + 1)]!;
    assert.ok(filter >= 0 && filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rgba[y * stride + x - channels]! : 0;
      const b = y ? rgba[(y - 1) * stride + x]! : 0;
      const c = y && x >= channels ? rgba[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      rgba[y * stride + x] = (raw[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  if (channels === 4) return rgba;
  const expanded = Buffer.alloc(result.width * result.height * 4, 255);
  for (let pixel = 0; pixel < result.width * result.height; pixel++) rgba.copy(expanded, pixel * 4, pixel * 3, pixel * 3 + 3);
  return expanded;
}
function colorCount(rgba: Buffer, predicate: (r: number, g: number, b: number, a: number) => boolean): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) if (predicate(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!)) count++;
  return count;
}
const redCount = (rgba: Buffer): number => colorCount(rgba, (r, g, b, a) => r > 200 && g < 80 && b < 80 && a > 240);
const darkCount = (rgba: Buffer): number => colorCount(rgba, (r, g, b, a) => r < 100 && g < 100 && b < 100 && a > 240);
const save = async (name: string, result: Result): Promise<void> => { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(`${evidence}/${name}.png`, result.png, { mode: 0o600 }); };

test("official renderer exports empty scenes, alpha, valid background and scaled crop bounds", async () => {
  const { renderDrawing } = await loadRenderer();
  const empty = await renderDrawing(scene([]), { padding: 0, background: false });
  assert.deepEqual(empty.bounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(empty.width, 1); assert.equal(empty.height, 1);
  assert.equal(pixels(empty)[3], 0);
  const padded = await renderDrawing(scene([]));
  assert.equal(padded.width, 41); assert.equal(padded.height, 41);
  const green = await renderDrawing(scene([], { appState: { viewBackgroundColor: "#00ff00" } }), { padding: 0 });
  assert.deepEqual([...pixels(green)], [0, 255, 0, 255]);
  await assert.rejects(renderDrawing(scene([], { appState: { viewBackgroundColor: "url(https://invalid.test/x)" } }), { padding: 0 }), /background|color/i);
  const cropped = await renderDrawing(scene([box("negative", { x: -80, y: -70 })]), { region, padding: 5, scale: 2 });
  assert.deepEqual(cropped.bounds, { x: -105, y: -105, width: 510, height: 360 });
  assert.equal(cropped.width, 1020); assert.equal(cropped.height, 720);
  assert.ok(redCount(pixels(cropped)) > 10000, "crop includes negative-position content");
});

test("official bounds contain rotated nodes and preserve immutable source data", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([box("rotated", { x: -120, y: -70, width: 120, height: 50, angle: Math.PI / 4, customData: { preserve: [1, 2] } })], { appState: { viewBackgroundColor: "#ffffff" } });
  const before = structuredClone(input);
  const result = await renderDrawing(input, { padding: 10 });
  assert.deepEqual(input, before);
  assert.ok(result.bounds.x < -120 && result.bounds.y < -70);
  assert.ok(result.bounds.height > 120 && result.bounds.width > 120);
  assert.ok(redCount(pixels(result)) > 3000, "rotation must contain a filled node, not an empty image");
  await save("T3-rotated-official", result);
});

test("selection expands groups, frame children, bound labels and binding endpoints transitively", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([
    box("start", { groupIds: ["group"], boundElements: [{ id: "route", type: "arrow" }, { id: "label", type: "text" }] }),
    box("group-peer", { x: 100, backgroundColor: "#00ff00", groupIds: ["group"], frameId: "frame" }),
    box("frame", { type: "frame", x: 90, y: -10, width: 200, height: 100, backgroundColor: "transparent", groupIds: ["group"] }),
    box("frame-child", { x: 200, backgroundColor: "#0000ff", frameId: "frame" }),
    box("endpoint", { x: 300, backgroundColor: "#ffff00" }),
    box("route", { type: "arrow", x: 80, y: 30, width: 220, height: 0, points: [[0, 0], [220, 0]], backgroundColor: "transparent", startBinding: { elementId: "start", focus: 0, gap: 1 }, endBinding: { elementId: "endpoint", focus: 0, gap: 1 }, startArrowhead: null, endArrowhead: "arrow" }),
    box("label", { type: "text", x: 5, y: 10, width: 65, height: 25, text: "Label", originalText: "Label", fontSize: 20, fontFamily: 5, lineHeight: 1.25, containerId: "start", textAlign: "center", verticalAlign: "middle", autoResize: true, baseline: 18, backgroundColor: "transparent" }),
    box("unrelated", { x: 300, y: 120, backgroundColor: "#ff00ff" }),
  ]);
  const result = await renderDrawing(input, { elementIds: ["route"], padding: 0 });
  const rgba = pixels(result);
  assert.ok(colorCount(rgba, (r, g, b) => g > 220 && r < 50 && b < 50) > 1000);
  assert.ok(colorCount(rgba, (r, g, b) => b > 220 && r < 50 && g < 50) > 1000);
  assert.ok(colorCount(rgba, (r, g, b) => r > 220 && g > 220 && b < 50) > 1000);
  assert.equal(colorCount(rgba, (r, g, b) => r > 220 && b > 220 && g < 50), 0);
  const all = await renderDrawing(input, { padding: 0 });
  assert.ok(colorCount(pixels(all), (r, g, b) => r > 220 && b > 220 && g < 50) > 1000);
  await save("T3-selection-official", result);
});

test("multipoint arrow geometry and arrowheads change independent rendered pixels", async () => {
  const { renderDrawing } = await loadRenderer();
  const route = box("route", { type: "arrow", x: -50, y: -30, width: 260, height: 170, backgroundColor: "transparent", strokeColor: "#ff0000", strokeWidth: 5, points: [[0, 0], [60, 130], [190, 25], [260, 170]], startArrowhead: null, endArrowhead: "triangle", startBinding: null, endBinding: null });
  const full = await renderDrawing(scene([route]), { region, padding: 0 });
  const straight = await renderDrawing(scene([{ ...route, points: [[0, 0], [260, 170]] }]), { region, padding: 0 });
  const noHead = await renderDrawing(scene([{ ...route, endArrowhead: null }]), { region, padding: 0 });
  const rgba = pixels(full);
  assert.ok(redCount(rgba) > 1500, "route content cannot be dropped");
  assert.notDeepEqual(rgba, pixels(straight), "interior bends affect output");
  assert.notDeepEqual(rgba, pixels(noHead), "arrowheads affect output");
  await save("T3-multipoint-official", full);
});

test("locally bundled official fonts render text content and distinct font families", async () => {
  const { renderDrawing } = await loadRenderer();
  const label = box("text", { type: "text", x: -50, y: -30, width: 360, height: 100, text: "Workflow Ж 0123\nReadable labels", originalText: "Workflow Ж 0123\nReadable labels", fontSize: 28, fontFamily: 5, lineHeight: 1.25, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, backgroundColor: "transparent" });
  const output = await renderDrawing(scene([label]), { region, padding: 0 });
  const alternate = await renderDrawing(scene([{ ...label, fontFamily: 1 }]), { region, padding: 0 });
  const blank = await renderDrawing(scene([{ ...label, text: "", originalText: "" }]), { region, padding: 0 });
  assert.ok(darkCount(pixels(output)) > 1000, "font/text content must not disappear");
  assert.notDeepEqual(pixels(output), pixels(alternate), "official font families must not silently share fallback font");
  assert.ok(darkCount(pixels(blank)) < 10);
  await save("T3-fonts-official", output);
});

// A tiny lossless inline PNG is decoded by the real browser, never replaced by a placeholder.
const redPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = box("raster", { type: "image", width: 100, height: 80, fileId: "inline", status: "saved", scale: [1, 1], crop: null });
test("inline raster assets affect actual pixels; SVG, remote, malformed and missing assets reject", async () => {
  const { renderDrawing } = await loadRenderer();
  const rendered = await renderDrawing(scene([image], { files: { inline: { id: "inline", mimeType: "image/png", dataURL: redPng, created: 1 } } }), { padding: 0 });
  assert.ok(redCount(pixels(rendered)) > 7000, "must decode the image rather than draw a placeholder");
  await save("T3-inline-raster-official", rendered);
  for (const file of [
    undefined,
    { id: "inline", mimeType: "image/png", dataURL: "https://invalid.test/secret.png" },
    { id: "inline", mimeType: "image/svg+xml", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" },
    { id: "inline", mimeType: "image/png", dataURL: "data:image/png;base64,PHN2Zy8+" },
    { id: "inline", mimeType: "image/jpeg", dataURL: redPng },
    { id: "inline", mimeType: "image/png", dataURL: `${redPng}${"A".repeat(6 * 1024 * 1024)}` },
  ]) await assert.rejects(renderDrawing(scene([image], { files: file ? { inline: file } : {} })), /asset|image|file|inline|size|limit|signature/i);
});

test("renderer enforces element, option, axis and total pixel limits before browser work", async () => {
  const { renderDrawing } = await loadRenderer();
  await assert.rejects(renderDrawing(scene(Array.from({ length: 2001 }, (_, i) => box(String(i))))), /2000|element.*limit/i);
  for (const options of [
    { scale: 0.09 }, { scale: 4.1 }, { padding: -1 }, { padding: 201 },
    { region: { ...region, width: Number.NaN } }, { region: { ...region, height: 0 } },
    { region, elementIds: ["node"] }, { elementIds: [] },
    { region: { x: 0, y: 0, width: 4097, height: 1 }, padding: 0 },
    { region: { x: 0, y: 0, width: 2100, height: 2000 }, padding: 0 },
  ]) await assert.rejects(renderDrawing(scene([box("node")]), options), /limit|pixel|scale|padding|region|bounds|exclusive|element|invalid/i);
  await assert.rejects(renderDrawing(scene([box("bad", { x: Number.NaN })])), /geometry|coordinate|finite|invalid/i);
  await assert.rejects(renderDrawing(scene([box("bad", { type: "line", points: [[0, 0], [1, Number.NaN]] })])), /geometry|coordinate|finite|point|invalid/i);
});

test("single renderer rejects overlapping requests immediately and recovers after completion", async () => {
  const { renderDrawing } = await loadRenderer();
  const first = renderDrawing(scene([box("node")]));
  const started = performance.now();
  await assert.rejects(renderDrawing(scene([])), /busy|concurren/i);
  assert.ok(performance.now() - started < 1000, "busy errors must not wait for the existing render");
  await first;
  pixels(await renderDrawing(scene([box("after")])));
});

test("scene links, arbitrary app state and unused assets cannot change exported content", async () => {
  const { renderDrawing } = await loadRenderer();
  const clean = scene([box("node")]);
  const hostile = scene([box("node", { link: "javascript:document.body.style.background='magenta'", customData: { html: "<script>throw new Error('executed')</script>" } })], {
    appState: { theme: "dark", scrollX: 100000, scrollY: -100000, zoom: { value: 100 }, customFonts: { 5: "https://invalid.test/font.woff2" }, viewBackgroundColor: "#ffffff" },
    files: { unused: { mimeType: "image/svg+xml", dataURL: "https://invalid.test/unused.svg" } },
  });
  const expected = await renderDrawing(clean, { region, padding: 0 });
  const actual = await renderDrawing(hostile, { region, padding: 0 });
  assert.deepEqual(pixels(actual), pixels(expected));
});

test("valid named and RGB colors preserve pixels; unsafe or invalid styles fail explicitly", async () => {
  const { renderDrawing } = await loadRenderer();
  for (const backgroundColor of ["red", "rgb(255, 0, 0)"]) {
    const result = await renderDrawing(scene([box("color", { backgroundColor })]), { padding: 0 });
    assert.ok(redCount(pixels(result)) > 4000);
  }
  for (const backgroundColor of ["url(https://invalid.test/x)", "var(--injected)", "notacolor", "currentColor"])
    await assert.rejects(renderDrawing(scene([box("bad-color", { backgroundColor })])), /color|style/i);
  await assert.rejects(renderDrawing(scene([box("custom-font", { type: "text", text: "No silent font replacement", fontFamily: 12345 })])), /font/i);
});

test("bounded region exports distant scenes without allocating a global canvas", async () => {
  const { renderDrawing } = await loadRenderer();
  const result = await renderDrawing(scene([box("near"), box("far", { x: 1_000_000, y: 1_000_000 })]), { region: { x: 0, y: 0, width: 80, height: 60 }, padding: 0 });
  assert.equal(result.width, 80); assert.equal(result.height, 60);
  assert.ok(redCount(pixels(result)) > 4000);
  const bomb = Buffer.from(redPng.split(",")[1]!, "base64");
  bomb.writeUInt32BE(100_000, 16); bomb.writeUInt32BE(100_000, 20);
  await assert.rejects(renderDrawing(scene([image], { files: { inline: { mimeType: "image/png", dataURL: `data:image/png;base64,${bomb.toString("base64")}` } } })), /decoded.*pixel|image.*limit/i);
});

test("region crop retains frame children, frame clipping and local official text", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([
    box("frame", { type: "frame", x: 0, y: 0, width: 200, height: 140, backgroundColor: "transparent" }),
    box("child", { x: 150, y: 10, width: 100, height: 60, frameId: "frame" }),
    box("text", { type: "text", x: 10, y: 80, width: 160, height: 40, frameId: "frame", text: "Readable", originalText: "Readable", fontSize: 28, fontFamily: 5, lineHeight: 1.25, textAlign: "left", verticalAlign: "top", containerId: null, backgroundColor: "transparent" }),
  ]);
  const whole = await renderDrawing(input, { padding: 0 });
  const cropped = await renderDrawing(input, { region: { x: 0, y: 0, width: 200, height: 140 }, padding: 0 });
  const expected = pixels(whole), actual = pixels(cropped);
  assert.equal(whole.width, 200); assert.equal(whole.height, 140);
  assert.ok(redCount(actual) > 2000, "region must include frame child");
  assert.ok(darkCount(actual) > 500, "region must include official font glyphs");
  let differing = 0;
  for (let i = 0; i < actual.length; i += 4) if (Math.max(...[0, 1, 2].map(c => Math.abs(actual[i + c]! - expected[i + c]!))) > 60) differing++;
  let textUnion = 0, textIntersection = 0;
  for (let y = 76; y < 125; y++) for (let x = 8; x < 180; x++) {
    const index = (y * 200 + x) * 4;
    const expectedInk = expected[index + 3]! > 240 && expected[index]! < 160 && expected[index + 1]! < 160 && expected[index + 2]! < 160;
    const actualInk = actual[index + 3]! > 240 && actual[index]! < 160 && actual[index + 1]! < 160 && actual[index + 2]! < 160;
    if (expectedInk || actualInk) textUnion++;
    if (expectedInk && actualInk) textIntersection++;
  }
  await save("T3-frame-text-whole", whole);
  await save("T3-frame-text-region", cropped);
  await writeFile(`${evidence}/T3-font-ROI.json`, JSON.stringify({ textIntersection, textUnion, ratio: textIntersection / textUnion, differing }, null, 2), { mode: 0o600 });
  assert.ok(textUnion > 500 && textIntersection > 500, "ROI must contain visible glyphs in both exports");
  assert.ok(textIntersection / textUnion > 0.65, "region glyphs must match the local official Canvas font, allowing raster antialiasing");
  assert.ok(differing / (200 * 140) < 0.08, `official SVG crop differs in ${differing} pixels from official canvas (raster antialias tolerance 8%)`);
  await save("T3-frame-text-region", cropped);
});

test("browser launch receives no ambient credentials or sandbox-disabling arguments", async () => {
  const { renderDrawing } = await loadRenderer();
  const dir = await mkdtemp(`${evidence}/T3-env-probe-`);
  const probe = `${dir}/browser`;
  const output = `${dir}/capture.json`;
  await writeFile(probe, `#!${process.execPath}\nimport('node:fs').then(fs=>{fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({env:process.env,args:process.argv}));process.exit(1)});\n`, { mode: 0o700 });
  await chmod(probe, 0o700);
  const previous = process.env.EXCALIDASH_RENDER_BROWSER;
  process.env.EXCALIDASH_RENDER_BROWSER = probe;
  process.env.EXCALIDASH_TEST_CREDENTIAL = "synthetic-never-forward";
  try {
    await assert.rejects(renderDrawing(scene([])));
    const capture = JSON.parse(await readFile(output, "utf8")) as { env: Record<string, string>; args: string[] };
    assert.equal(capture.env.EXCALIDASH_TEST_CREDENTIAL, undefined);
    assert.equal(capture.env.HOME, undefined);
    assert.equal(capture.env.NODE_OPTIONS, undefined);
    assert.ok(!capture.args.includes("--no-sandbox"));
  } finally {
    if (previous === undefined) delete process.env.EXCALIDASH_RENDER_BROWSER; else process.env.EXCALIDASH_RENDER_BROWSER = previous;
    delete process.env.EXCALIDASH_TEST_CREDENTIAL;
    await rm(dir, { recursive: true, force: true });
  }
});

test("deadline kills independent browser and wedged worker groups without survivors", { timeout: 30_000 }, async () => {
  const exec = promisify(execFile);
  const probe = spawn(process.execPath, ["--input-type=module", "-e", `import {renderDrawing} from ${JSON.stringify(new URL("./drawing-renderer.js", import.meta.url).href)};try{await renderDrawing({version:17,elements:[]});process.send({ok:true})}catch(error){process.send({error:error.message})}`], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, EXCALIDASH_TEST_CREDENTIAL: "synthetic-never-forward" } });
  const completed = new Promise<{ error?: string; ok?: boolean }>((resolve, reject) => { probe.once("message", message => resolve(message as { error?: string })); probe.once("error", reject); });
  const owned = new Set<number>();
  let stopped = false;
  const started = performance.now();
  try {
    for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
      const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,args="]);
      const rows = stdout.trim().split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(row => row !== null);
      const descendants = new Set([probe.pid!]);
      for (let pass = 0; pass < 5; pass++) for (const row of rows) if (descendants.has(Number(row[2]))) descendants.add(Number(row[1]));
      for (const row of rows) if (descendants.has(Number(row[1])) && Number(row[1]) !== probe.pid) {
        owned.add(Number(row[1]));
        if (row[4]!.includes("render-worker.js")) {
          const environment = await exec("ps", ["eww", "-p", row[1]!, "-o", "command="]);
          assert.ok(!environment.stdout.includes("synthetic-never-forward"), "worker must not inherit credentials");
          assert.ok(row[4]!.includes("--max-old-space-size=128"));
          process.kill(Number(row[1]), "SIGSTOP"); stopped = true;
        }
        if (row[4]!.includes("--remote-debugging-pipe")) assert.ok(!row[4]!.includes("--no-sandbox"));
      }
      if (!stopped) await pause(100);
    }
    assert.ok(stopped, "must wedge the real worker after the independently owned browser launches");
    assert.ok(owned.size > 2, "browser and worker process ownership must be observed");
    const outcome = await completed;
    assert.match(outcome.error ?? "", /deadline|15000/i);
    assert.ok(performance.now() - started < 20_000);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let attempt = 0; attempt < 40 && [...owned].some(alive); attempt++) await pause(50);
    const survivors = [...owned].filter(alive);
    await writeFile(`${evidence}/T3-timeout-cleanup.json`, JSON.stringify({ owned: [...owned], survivors, elapsedMs: performance.now() - started, outcome }, null, 2), { mode: 0o600 });
    assert.deepEqual(survivors, [], "no browser/helper/worker may survive the deadline");
  } finally {
    for (const pid of owned) try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
    probe.kill("SIGKILL");
  }
});

test("node selection excludes adjacent arrows while arrow selection includes endpoint nodes", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([
    box("a", { backgroundColor: "#00ff00", boundElements: [{ id: "edge", type: "arrow" }] }),
    box("b", { x: 250, backgroundColor: "#0000ff", boundElements: [{ id: "edge", type: "arrow" }] }),
    box("edge", { type: "arrow", x: 80, y: 30, width: 170, height: 0, points: [[0, 0], [170, 0]], startArrowhead: null, endArrowhead: "arrow", strokeColor: "#ff0000", backgroundColor: "transparent", startBinding: { elementId: "a", focus: 0, gap: 1 }, endBinding: { elementId: "b", focus: 0, gap: 1 } }),
  ]);
  const selectedNode = pixels(await renderDrawing(input, { elementIds: ["a"], padding: 0 }));
  assert.equal(redCount(selectedNode), 0);
  assert.equal(colorCount(selectedNode, (r, g, b) => b > 220 && r < 50 && g < 50), 0);
  const selectedArrow = pixels(await renderDrawing(input, { elementIds: ["edge"], padding: 0 }));
  assert.ok(redCount(selectedArrow) > 100);
  assert.ok(colorCount(selectedArrow, (r, g, b) => b > 220 && r < 50 && g < 50) > 1000);
  assert.ok(colorCount(selectedArrow, (r, g, b) => g > 220 && r < 50 && b < 50) > 1000);
});

test("prototype-shaped image file IDs are validated and rendered as own assets", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([{ ...image, fileId: "constructor" }], { files: { constructor: { id: "constructor", mimeType: "image/png", dataURL: redPng, created: 1 } } });
  assert.ok(redCount(pixels(await renderDrawing(input, { padding: 0 }))) > 7000);
  await assert.rejects(renderDrawing(scene([{ ...image, fileId: "constructor" }], { files: {} })), /asset|image|file/i);
});

function noisePng(size: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const name = Buffer.from(type), checksumInput = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of checksumInput) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, name, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  let seed = 0x12345678;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 3; c++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; scanlines[offset + c] = seed & 255; }
    scanlines[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

test("actual high-entropy PNG output is rejected above the 4 MiB output budget", async () => {
  const { renderDrawing } = await loadRenderer();
  const png = noisePng(500);
  const input = scene([{ ...image, width: 2000, height: 2000 }], { files: { inline: { id: "inline", mimeType: "image/png", dataURL: `data:image/png;base64,${png.toString("base64")}`, created: 1 } } });
  await assert.rejects(renderDrawing(input, { padding: 0 }), /output.*4 MiB|output.*limit/i);
});

test("region preserves transparent configured background alpha", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([box("alpha")], { appState: { viewBackgroundColor: "transparent" } });
  const whole = await renderDrawing(input, { background: true, padding: 20 });
  const cropped = await renderDrawing(input, { background: true, region: { x: -20, y: -20, width: 120, height: 100 }, padding: 0 });
  assert.equal(pixels(whole)[3], 0);
  assert.equal(pixels(cropped)[3], 0);
  assert.ok(redCount(pixels(cropped)) > 4000);
});


test("invalid supplied scene backgrounds fail before browser launch", async () => {
  const { renderDrawing } = await loadRenderer();
  const previous = process.env.EXCALIDASH_RENDER_BROWSER;
  process.env.EXCALIDASH_RENDER_BROWSER = "/unavailable-synthetic-renderer-browser";
  try {
    for (const viewBackgroundColor of ["notacolor", "url(https://invalid.test/x)", "#12345", "rgb(,)", null, 0, undefined]) {
      await assert.rejects(renderDrawing(scene([], { appState: { viewBackgroundColor } })), /background|color/i);
    }
  } finally {
    if (previous === undefined) delete process.env.EXCALIDASH_RENDER_BROWSER; else process.env.EXCALIDASH_RENDER_BROWSER = previous;
  }
});

test("selection scans a long group chain and repeated missing labels only a fixed number of times", async () => {
  const { renderDrawing } = await loadRenderer();
  const elements: ExcalidrawElement[] = Array.from({ length: 2000 }, (_, index) => ({
    id: String(index), type: "rectangle", x: index, y: 0, width: 1, height: 1,
    groupIds: index ? [`g${index - 1}`, `g${index}`] : ["g0"],
  }));
  const missingLabels = Array.from({ length: 100000 }, () => ({ id: "missing", type: "text" }));
  let reads = 0;
  Object.defineProperty(elements[0], "boundElements", {
    enumerable: true,
    get: () => {
      if (++reads > 20) throw new Error("Repeated selection relation scan");
      return missingLabels;
    },
  });
  const serializedBytes = Buffer.byteLength(JSON.stringify(scene(elements)));
  assert.ok(serializedBytes < 4 * 1024 * 1024);
  reads = 0;
  const previous = process.env.EXCALIDASH_RENDER_BROWSER;
  process.env.EXCALIDASH_RENDER_BROWSER = "/unavailable-synthetic-renderer-browser";
  try {
    const started = performance.now();
    await assert.rejects(renderDrawing(scene(elements), { elementIds: ["0"] }), /Rendering unavailable/);
    await writeFile(`${evidence}/T3S-selection-probe.json`, JSON.stringify({ elements: elements.length, missingLabelReferences: missingLabels.length, serializedBytes, relationReads: reads, elapsedMs: performance.now() - started }, null, 2), { mode: 0o600 });
    assert.ok(reads <= 20, `selected root relation collection was read ${reads} times`);
  } finally {
    if (previous === undefined) delete process.env.EXCALIDASH_RENDER_BROWSER; else process.env.EXCALIDASH_RENDER_BROWSER = previous;
  }
});

test("malformed render relationship collections fail explicitly before selection traversal", async () => {
  const { renderDrawing } = await loadRenderer();
  const previous = process.env.EXCALIDASH_RENDER_BROWSER;
  process.env.EXCALIDASH_RENDER_BROWSER = "/unavailable-synthetic-renderer-browser";
  try {
    for (const relationship of [
      { groupIds: {} }, { groupIds: [null] }, { boundElements: {} },
      { boundElements: [null] }, { boundElements: [{ id: 3, type: "text" }] },
      { boundElements: [{ id: "label", type: "rectangle" }] },
      { frameId: [] }, { containerId: 3 }, { startBinding: [] },
    ]) await assert.rejects(renderDrawing(scene([box("root", relationship)]), { elementIds: ["root"] }), /Invalid render reference/i);
  } finally {
    if (previous === undefined) delete process.env.EXCALIDASH_RENDER_BROWSER; else process.env.EXCALIDASH_RENDER_BROWSER = previous;
  }
});

test("render preparation consumes the overall deadline before executable lookup", async () => {
  const { renderDrawing } = await loadRenderer();
  let now = 0;
  const mocked = test.mock.method(performance, "now", () => now);
  const root = box("root");
  Object.defineProperty(root, "boundElements", { enumerable: true, get: () => { now = 15001; return []; } });
  const previous = process.env.EXCALIDASH_RENDER_BROWSER;
  process.env.EXCALIDASH_RENDER_BROWSER = "/unavailable-synthetic-renderer-browser";
  try {
    await assert.rejects(renderDrawing(scene([root]), { elementIds: ["root"] }), /deadline/i);
    await assert.rejects(renderDrawing(scene([])), /Rendering unavailable/);
  } finally {
    mocked.mock.restore();
    if (previous === undefined) delete process.env.EXCALIDASH_RENDER_BROWSER; else process.env.EXCALIDASH_RENDER_BROWSER = previous;
  }
});


test("selection preserves scene stacking order when BFS order differs", async () => {
  const { renderDrawing } = await loadRenderer();
  const input = scene([box("red", { groupIds: ["stack"] }), box("blue", { groupIds: ["stack"], backgroundColor: "#0000ff" })]);
  const rgba = pixels(await renderDrawing(input, { elementIds: ["blue"], padding: 0 }));
  assert.equal(redCount(rgba), 0);
  assert.ok(colorCount(rgba, (r, g, b, a) => b > 220 && r < 50 && g < 50 && a > 240) > 4000);
});
