import { fork, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserServer } from "playwright-core";
import { z } from "zod";
import type { ExcalidrawElement } from "./agent/elementFactory.js";

const boundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().finite(), height: z.number().positive().finite() });
export const renderOptionsSchema = z.object({
  scale: z.number().min(0.1).max(4).default(1),
  background: z.boolean().default(true),
  region: boundsSchema.optional(),
  elementIds: z.array(z.string()).min(1).max(200).optional(),
  padding: z.number().min(0).max(200).default(20),
}).refine(options => !(options.region && options.elementIds), { message: "region and elementIds are mutually exclusive" });
export type RenderOptions = z.input<typeof renderOptionsSchema>;
export type Bounds = z.infer<typeof boundsSchema>;
export type RenderScene = { version: number; elements: ExcalidrawElement[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
export type RenderGeometry = { bounds: Bounds; width: number; height: number; warnings?: string[] };
export type RenderResult = RenderGeometry & { png: Buffer; version: number; renderer: "@excalidraw/excalidraw@0.18.1" };
export type RenderPayload = { scene: { elements: ExcalidrawElement[]; appState: { viewBackgroundColor: string }; files: Record<string, unknown> }; options: z.output<typeof renderOptionsSchema> };
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 15_000;

// A single slot is deliberately process-wide: starting more browsers defeats the host budget.
let rendering = false;
// CSS Color named colors are finite; arbitrary identifiers must never become white.
const namedColors: ReadonlySet<string> = new Set((
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen"
).split(" "));
const numericColorComponent = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;
const hueColorComponent = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn)?$/i;
function color(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100) return undefined;
  const normalized = value.trim().toLowerCase();
  if (namedColors.has(normalized) || /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(normalized)) return value;
  const functional = /^(rgba?|hsla?)\(([\s\S]*)\)$/.exec(normalized);
  if (!functional) return undefined;
  const body = functional[2]!;
  const legacy = body.includes(",");
  if (legacy && body.includes("/")) return undefined;
  const components = legacy ? body.split(",").map(component => component.trim()) : body.split(/\s*\/\s*/);
  let channels: string[], alpha: string | undefined;
  if (legacy) {
    if (components.length !== 3 && components.length !== 4) return undefined;
    channels = components.slice(0, 3); alpha = components[3];
  } else {
    if (components.length > 2) return undefined;
    channels = components[0]!.trim().split(/\s+/); alpha = components[1];
    if (channels.length !== 3) return undefined;
  }
  if (alpha !== undefined && (!numericColorComponent.test(alpha) || !Number.isFinite(Number.parseFloat(alpha)))) return undefined;
  if (functional[1]!.startsWith("rgb")) {
    if (channels.some(channel => !numericColorComponent.test(channel) || !Number.isFinite(Number.parseFloat(channel)))) return undefined;
    if (legacy && channels.some(channel => channel.endsWith("%")) && !channels.every(channel => channel.endsWith("%"))) return undefined;
  } else {
    if (!hueColorComponent.test(channels[0]!) || !Number.isFinite(Number.parseFloat(channels[0]!))) return undefined;
    if (channels.slice(1).some(channel => !numericColorComponent.test(channel) || !channel.endsWith("%") || !Number.isFinite(Number.parseFloat(channel)))) return undefined;
  }
  return value;
}
const elementFields = [
  "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "seed", "version", "versionNonce", "isDeleted", "groupIds", "frameId", "boundElements", "updated", "locked", "roundness", "index",
  "points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed", "fixedSegments", "startIsSpecial", "endIsSpecial",
  "text", "originalText", "fontSize", "fontFamily", "lineHeight", "textAlign", "verticalAlign", "containerId", "autoResize", "baseline",
  "fileId", "status", "scale", "crop", "pressures", "simulatePressure", "name",
] as const;

function relationCollection(element: ExcalidrawElement, key: "groupIds" | "boundElements"): unknown[] {
  const value: unknown = element[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid render reference ${key}`);
  return value;
}

function relationId(element: ExcalidrawElement, key: "frameId" | "containerId"): string | undefined {
  const value: unknown = element[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid render reference ${key}`);
  return value;
}

function bindingId(element: ExcalidrawElement, key: "startBinding" | "endBinding"): string | undefined {
  const value: unknown = element[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) || !("elementId" in value) || typeof value.elementId !== "string") throw new Error(`Invalid render reference ${key}`);
  return value.elementId;
}

function selectElements(elements: ExcalidrawElement[], ids?: string[]): ExcalidrawElement[] {
  const live = elements.filter(element => !element.isDeleted && !element.hidden && element.opacity !== 0);
  const byId = new Map(live.map(element => [element.id, element]));
  const groups = new Map<string, string[]>();
  const frameChildren = new Map<string, string[]>();
  const containerLabels = new Map<string, string[]>();
  const relations = new Map<string, { groups: string[]; labels: string[]; endpoints: string[] }>();
  const index = (collection: Map<string, string[]>, key: string | undefined, id: string): void => {
    if (key === undefined) return;
    const existing = collection.get(key);
    if (existing) existing.push(id); else collection.set(key, [id]);
  };
  // Cache each adjacency once. A long transitive group chain must never rescan
  // large bound-label collections on elements that have already been visited.
  for (const element of live) {
    const groupIds = new Set<string>();
    for (const group of relationCollection(element, "groupIds")) {
      if (typeof group !== "string") throw new Error("Invalid render reference groupIds");
      groupIds.add(group);
    }
    for (const group of groupIds) index(groups, group, element.id);
    const labels = new Set<string>();
    for (const bound of relationCollection(element, "boundElements")) {
      if (!bound || typeof bound !== "object" || Array.isArray(bound) || !("id" in bound) || typeof bound.id !== "string" || !("type" in bound) || (bound.type !== "text" && bound.type !== "arrow")) throw new Error("Invalid render reference boundElements");
      if (bound.type === "text" && byId.has(bound.id)) labels.add(bound.id);
    }
    index(frameChildren, relationId(element, "frameId"), element.id);
    const containerId = relationId(element, "containerId");
    if (element.type === "text") index(containerLabels, containerId, element.id);
    const startId = bindingId(element, "startBinding"), endId = bindingId(element, "endBinding");
    const endpoints = element.type === "arrow" ? [startId, endId].filter((id): id is string => id !== undefined) : [];
    relations.set(element.id, { groups: [...groupIds], labels: [...labels], endpoints });
  }
  if (!ids) return live;
  for (const id of ids) if (!byId.has(id)) throw new Error(`Unknown render element ID: ${id}`);
  const selected = new Set<string>();
  const queue: string[] = [];
  const enqueue = (id: string): void => {
    if (!byId.has(id) || selected.has(id)) return;
    selected.add(id); queue.push(id);
  };
  for (const id of ids) enqueue(id);
  const visitedGroups = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    const adjacent = relations.get(id)!;
    for (const group of adjacent.groups) {
      if (visitedGroups.has(group)) continue;
      visitedGroups.add(group);
      for (const member of groups.get(group) ?? []) enqueue(member);
    }
    for (const child of frameChildren.get(id) ?? []) enqueue(child);
    for (const label of containerLabels.get(id) ?? []) enqueue(label);
    for (const label of adjacent.labels) enqueue(label);
    for (const endpoint of adjacent.endpoints) enqueue(endpoint);
  }
  return live.filter(element => selected.has(element.id));
}

function rasterDimensions(data: Buffer, mime: string): [number, number] {
  if (mime === "image/png" && data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && data.length >= 33 && data.toString("ascii", 12, 16) === "IHDR") return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (mime === "image/jpeg" && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
      offset += size;
    }
  }
  if (mime === "image/webp" && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" && data.length >= 30) {
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X" && !(data[20]! & 2)) return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
    if (kind === "VP8 " && data.toString("hex", 23, 26) === "9d012a") return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    if (kind === "VP8L" && data[20] === 0x2f) return [1 + ((data[21]! | data[22]! << 8) & 0x3fff), 1 + ((data[22]! >> 6 | data[23]! << 2 | data[24]! << 10) & 0x3fff)];
  }
  throw new Error("Invalid inline image signature or unsupported image format");
}

function sanitize(scene: RenderScene, options: z.output<typeof renderOptionsSchema>): RenderPayload {
  if (!Number.isSafeInteger(scene.version) || scene.version < 0 || !Array.isArray(scene.elements)) throw new Error("Invalid render scene");
  if (scene.elements.filter(element => !element.isDeleted).length > 2000) throw new Error("Render element limit is 2000 live elements");
  const elements = selectElements(scene.elements, options.elementIds).map(element => {
    for (const key of ["x", "y", "width", "height"] as const) if (typeof element[key] !== "number" || !Number.isFinite(element[key])) throw new Error(`Invalid render geometry: ${key}`);
    if (element.width < 0 || element.height < 0 || (element.angle !== undefined && !Number.isFinite(element.angle))) throw new Error("Invalid render geometry");
    if (["line", "arrow", "freedraw"].includes(element.type)) {
      if (!Array.isArray(element.points) || element.points.length < 2 || element.points.length > 20000 || element.points.some((point: unknown) => !Array.isArray(point) || point.length !== 2 || point.some(coordinate => typeof coordinate !== "number" || !Number.isFinite(coordinate)))) throw new Error("Invalid render line points");
    } else if (element.width <= 0 || element.height <= 0) throw new Error("Invalid render geometry dimensions");
    if (!["rectangle", "diamond", "ellipse", "text", "line", "arrow", "freedraw", "image", "frame", "magicframe"].includes(element.type)) throw new Error(`Unsupported render element type: ${element.type}`);
    const safe = Object.fromEntries(elementFields.filter(key => Object.hasOwn(element, key)).map(key => [key, structuredClone(element[key])]));
    safe.link = null;
    for (const key of ["strokeColor", "backgroundColor"] as const) {
      if (safe[key] !== undefined && !color(safe[key])) throw new Error(`Invalid render color: ${key}`);
    }
    safe.strokeColor ??= "#1b1b1f";
    safe.backgroundColor ??= "transparent";
    if (element.type === "text" && element.fontFamily !== undefined && ![1, 2, 3, 5, 6, 7, 8, 9].includes(element.fontFamily)) throw new Error("Unsupported render font family");
    return safe;
  });
  const files: Record<string, unknown> = Object.create(null);
  let totalAssetPixels = 0;
  for (const element of elements) if (element.type === "image") {
    const id = element.fileId;
    if (typeof id !== "string") throw new Error("Missing image file ID");
    if (Object.hasOwn(files, id)) continue;
    const file = scene.files?.[id];
    if (!file || typeof file !== "object") throw new Error("Missing inline image asset");
    const { dataURL, mimeType } = file as { dataURL?: unknown; mimeType?: unknown };
    if (typeof dataURL !== "string" || dataURL.length > Math.ceil(MAX_ASSET_BYTES * 4 / 3) + 40) throw new Error("Inline image asset size limit");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataURL);
    if (!match || match[1] !== mimeType) throw new Error("Unsupported inline image asset MIME type");
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length > MAX_ASSET_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid inline image asset encoding or size");
    const [width, height] = rasterDimensions(bytes, match[1]!);
    totalAssetPixels += width * height;
    if (!width || !height || width > 4096 || height > 4096 || totalAssetPixels > 4_000_000) throw new Error("Inline image decoded pixel limit");
    files[id] = { id, mimeType, dataURL, created: 0 };
  }
  const hasBackground = scene.appState !== undefined && Object.hasOwn(scene.appState, "viewBackgroundColor");
  const backgroundColor = hasBackground ? color(scene.appState!.viewBackgroundColor) : "#ffffff";
  if (backgroundColor === undefined) throw new Error("Invalid render scene background color");
  const payload: RenderPayload = { scene: { elements, files, appState: { viewBackgroundColor: backgroundColor } }, options };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SNAPSHOT_BYTES) throw new Error("Render snapshot size limit is 10 MiB");
  if (options.region) {
    const width = Math.ceil((options.region.width + options.padding * 2) * options.scale), height = Math.ceil((options.region.height + options.padding * 2) * options.scale);
    if (width > 4096 || height > 4096 || width * height > 4_000_000) throw new Error("Render pixel limit: 4096 per axis and 4000000 total pixels");
  }
  return payload;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* Already reaped by Playwright. */ }
}
const cleanEnvironment = (): NodeJS.ProcessEnv => ({ PATH: process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "production" });

export async function renderDrawing(scene: RenderScene, options: RenderOptions = {}): Promise<RenderResult> {
  if (rendering) throw new Error("Renderer busy: concurrency limit is 1");
  const start = performance.now();
  rendering = true;
  let server: BrowserServer | undefined;
  let worker: ChildProcess | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let expired = false;
  const remainingTime = (): number => {
    const remaining = DEADLINE_MS - (performance.now() - start);
    if (remaining <= 0) throw new Error("Render deadline exceeded (15000ms)");
    return remaining;
  };
  try {
    const parsed = renderOptionsSchema.safeParse(options);
    if (!parsed.success) throw new Error(`Invalid render options: ${parsed.error.message}`);
    const payload = sanitize(scene, parsed.data);
    const version = scene.version;
    const remaining = remainingTime();
    const deadlineReached = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { expired = true; killGroup(server?.process().pid); killGroup(worker?.pid); reject(new Error("Render deadline exceeded (15000ms)")); }, remaining);
    });
    const run = async (): Promise<RenderResult> => {
      remainingTime();
      const executablePath = process.env.EXCALIDASH_RENDER_BROWSER ?? chromium.executablePath();
      try { await access(executablePath, constants.X_OK); } catch { throw new Error("Rendering unavailable: set EXCALIDASH_RENDER_BROWSER to a supported sandboxed browser, or install the pinned Playwright browser"); }
      // Parent owns the detached browser group independently of the worker group.
      server = await chromium.launchServer({ executablePath, chromiumSandbox: true, headless: true, host: "127.0.0.1", env: cleanEnvironment(), timeout: remainingTime() });
      if (expired) { killGroup(server.process().pid); await server.kill(); throw new Error("Render deadline exceeded"); }
      worker = fork(fileURLToPath(new URL("./render-worker.js", import.meta.url)), [], {
        execArgv: ["--max-old-space-size=128"], env: cleanEnvironment(), detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
      });
      const result = await new Promise<RenderGeometry & { data: string }>((resolve, reject) => {
        worker!.once("error", () => reject(new Error("Render worker failed to start")));
        worker!.once("exit", code => reject(new Error(`Render worker exited before completion (${code})`)));
        worker!.on("message", message => {
          const response = message as { result?: RenderGeometry & { data: string }; error?: string };
          if (response.error) reject(new Error(response.error));
          else if (response.result) resolve(response.result);
        });
        worker!.send({ endpoint: server!.wsEndpoint(), payload });
      });
      const png = Buffer.from(result.data, "base64");
      if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 4096 || result.height > 4096 || result.width * result.height > 4_000_000) throw new Error("Invalid renderer pixel limits");
      if (png.length > 4 * 1024 * 1024) throw new Error("Render output limit is 4 MiB");
      if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || result.width !== png.readUInt32BE(16) || result.height !== png.readUInt32BE(20)) throw new Error("Invalid renderer PNG output");
      return { bounds: result.bounds, width: result.width, height: result.height, ...(result.warnings?.length ? { warnings: result.warnings } : {}), png, version, renderer: "@excalidraw/excalidraw@0.18.1" };
    };
    return await Promise.race([run(), deadlineReached]);
  } finally {
    if (deadline) clearTimeout(deadline);
    killGroup(worker?.pid);
    if (server) { killGroup(server.process().pid); await server.kill().catch(() => undefined); }
    rendering = false;
  }
}
