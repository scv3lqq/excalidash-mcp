import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, ExcaliDashClient, ExcaliDashError, type Fetch } from "./excalidash.js";
import { prepareRestBatch } from "./rest.js";

type Element = Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number };
type Drawing = { id: string; version: number; elements: Element[]; appState: Record<string, unknown>; files: Record<string, unknown> };
type MutationResult = {
  version: number; changedIds: string[]; createdIds: string[]; modifiedIds: string[]; deletedIds: string[];
  changedBounds: { x: number; y: number; width: number; height: number } | null;
  validationWarnings: unknown[]; validationSkippedChecks: unknown[];
  results: { createdIds?: string[] }[];
};
const settings = () => configFromEnv({ EXCALIDASH_URL: "https://draw.example.test", EXCALIDASH_API_KEY: "synthetic-token", EXCALIDASH_API_MODE: "rest" });
const fixture = (): Drawing => ({
  id: "drawing", version: 7,
  elements: [
    { id: "left", type: "rectangle", x: 0, y: 0, width: 100, height: 100, boundElements: [{ id: "route", type: "arrow" }], customData: { retained: [1, 2] }, version: 3 },
    { id: "right", type: "rectangle", x: 400, y: 0, width: 100, height: 100, boundElements: [{ id: "route", type: "arrow" }], version: 3 },
    { id: "route", type: "arrow", x: 100, y: 50, width: 300, height: 150, points: [[0, 0], [80, 150], [220, 150], [300, 0]], startBinding: { elementId: "left", focus: 0.25, gap: 8 }, endBinding: { elementId: "right", focus: -0.25, gap: 8 }, boundElements: [{ id: "manual-label", type: "text" }], customData: { route: true }, version: 5 },
    { id: "manual-label", type: "text", x: 211, y: 123, width: 83, height: 27, text: "Manual\nlabel", originalText: "Manual\nlabel", fontSize: 17, fontFamily: 3, lineHeight: 1.33, containerId: "route", autoResize: false, version: 9 },
    { id: "unrelated", type: "rectangle", x: 800, y: -100, width: 80, height: 60, customData: { nested: ["untouched"] }, version: 1 },
    { id: "old-tombstone", type: "text", x: 900, y: 0, width: 20, height: 20, text: "old", isDeleted: true },
  ],
  appState: { scrollX: -30, viewBackgroundColor: "#ffffff", custom: { viewport: true } },
  files: { inline: { mimeType: "image/png", dataURL: "synthetic-retained-data" } },
});
const getElement = (elements: Element[], id: string): Element => {
  const element = elements.find(candidate => candidate.id === id);
  assert.ok(element, `missing ${id}`);
  return element;
};
const worldPoints = (element: Element): number[][] => (element.points as number[][]).map(point => [element.x + point[0]!, element.y + point[1]!]);
const applyWithRevision = (client: ExcaliDashClient, ops: unknown[], expectedRevision: number): Promise<unknown> =>
  (client.applyOps as (id: string, ops: unknown[], batchId?: string, revision?: number) => Promise<unknown>)("drawing", ops, undefined, expectedRevision);

function memoryClient(transform?: (saved: Drawing) => Drawing) {
  let stored = fixture();
  const requests: { method: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl: Fetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ method: init?.method ?? "GET", body });
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
    if (init?.method === "PUT") {
      assert.deepEqual(Object.keys(body!).sort(), ["elements", "version"]);
      assert.equal(body!.version, stored.version);
      const saved = { ...stored, version: stored.version + 1, elements: body!.elements as Element[] };
      stored = transform ? transform(saved) : saved;
    }
    return Response.json(stored);
  };
  return { client: new ExcaliDashClient(settings(), fetchImpl), requests, stored: () => stored };
}

for (const [name, ops] of [
  ["unrelated style", [{ op: "set_style", id: "unrelated", style: { strokeColor: "#f00" } }]],
  ["bound-node style", [{ op: "set_style", id: "left", style: { backgroundColor: "#eee" } }]],
  ["unrelated addition", [{ op: "add_shape", shape: "rectangle", x: 1000, y: 200 }]],
  ["group metadata", [{ op: "group", ids: ["left", "right"] }]],
] as const) {
  test(`${name} preserves unrelated multipoint route and manual label byte-for-byte`, () => {
    const original = fixture();
    const snapshot = structuredClone(original);
    const result = prepareRestBatch(original, structuredClone([...ops]));
    for (const id of ["route", "manual-label"]) {
      assert.deepEqual(result.elements.find(element => element.id === id), getElement(original.elements, id));
      assert.ok(!result.changedIds.has(id));
    }
    assert.deepEqual(original, snapshot);
  });
}

test("moving one bound node changes only its endpoint and preserves interior world bends and label metrics", () => {
  const original = fixture();
  const previous = worldPoints(getElement(original.elements, "route"));
  const result = prepareRestBatch(original, [{ op: "move", id: "left", dx: 20, dy: 10 }]);
  const arrow = result.elements.find(element => element.id === "route") as Element;
  const current = worldPoints(arrow);
  assert.equal(current.length, previous.length);
  assert.notDeepEqual(current[0], previous[0]);
  assert.deepEqual(current.slice(1), previous.slice(1));
  const label = result.elements.find(element => element.id === "manual-label");
  const oldLabel = getElement(original.elements, "manual-label");
  for (const key of ["width", "height", "text", "originalText", "fontSize", "fontFamily", "lineHeight", "autoResize"]) assert.deepEqual(label?.[key], oldLabel[key]);
  assert.equal(label?.x, oldLabel.x + (current[0]![0]! - previous[0]![0]!) / 2);
  assert.equal(label?.y, oldLabel.y + (current[0]![1]! - previous[0]![1]!) / 2);
  assert.deepEqual(arrow.startBinding, getElement(original.elements, "route").startBinding);
  assert.deepEqual(arrow.endBinding, getElement(original.elements, "route").endBinding);
});

test("single-sided binding updates its affected endpoint while keeping every other world point", () => {
  const original = fixture();
  getElement(original.elements, "route").endBinding = null;
  const previous = worldPoints(getElement(original.elements, "route"));
  const result = prepareRestBatch(original, [{ op: "move", id: "left", dx: 20, dy: 10 }]);
  const arrow = result.elements.find(element => element.id === "route") as Element;
  const current = worldPoints(arrow);
  assert.notDeepEqual(current[0], previous[0]);
  assert.deepEqual(current.slice(1), previous.slice(1));
  assert.equal(arrow.endBinding, null);
});

test("direct route move retains requested translation and manual label offset", () => {
  const original = fixture();
  const previous = worldPoints(getElement(original.elements, "route"));
  const result = prepareRestBatch(original, [{ op: "move", id: "route", dx: 17, dy: -13 }]);
  const arrow = result.elements.find(element => element.id === "route") as Element;
  assert.deepEqual(worldPoints(arrow), previous.map(([x, y]) => [x! + 17, y! - 13]));
  const label = result.elements.find(element => element.id === "manual-label");
  assert.equal(label?.x, 228);
  assert.equal(label?.y, 110);
  assert.equal(label?.width, 83);
  assert.equal(label?.height, 27);
});

test("stale expectedRevision rejects before PUT with authoritative conflict details", async () => {
  const { client, requests, stored } = memoryClient();
  const original = structuredClone(stored());
  await assert.rejects(applyWithRevision(client, [{ op: "move", id: "unrelated", dx: 1 }], 6), (error: unknown) => {
    assert.ok(error instanceof ExcaliDashError);
    assert.match(error.message, /VERSION_CONFLICT.*fresh read/i);
    assert.deepEqual((error as ExcaliDashError & { details?: unknown }).details, { code: "VERSION_CONFLICT", expectedRevision: 6, actualRevision: 7 });
    return true;
  });
  assert.deepEqual(requests.map(request => request.method), ["GET"]);
  assert.deepEqual(stored(), original);
});

test("matching expectedRevision retains backend CAS and performs exactly one PUT", async () => {
  const { client, requests } = memoryClient();
  const result = await applyWithRevision(client, [{ op: "move", id: "unrelated", dx: 1 }], 7) as MutationResult;
  assert.equal(result.version, 8);
  assert.deepEqual(requests.map(request => request.method), ["GET", "PUT"]);
  assert.equal(requests[1]?.body?.version, 7);
});

test("legacy mode rejects expectedRevision without an HTTP request", async () => {
  let calls = 0;
  const client = new ExcaliDashClient({ ...settings(), apiMode: undefined }, async () => { calls += 1; return Response.json({ version: 8 }); });
  await assert.rejects(applyWithRevision(client, [{ op: "move", id: "unrelated", dx: 1 }], 7), /revision.*REST|REST.*revision/i);
  assert.equal(calls, 0);
});

test("backend CAS conflict is structured and never retried without inventing actualRevision", async () => {
  let puts = 0;
  const client = new ExcaliDashClient(settings(), async (_input, init) => {
    if (init?.method !== "PUT") return Response.json(fixture());
    puts += 1;
    return Response.json({ error: "Version conflict" }, { status: 409 });
  });
  await assert.rejects(applyWithRevision(client, [{ op: "move", id: "unrelated", dx: 1 }], 7), (error: unknown) => {
    assert.ok(error instanceof ExcaliDashError);
    const details = (error as ExcaliDashError & { details?: Record<string, unknown> }).details;
    assert.equal(details?.code, "VERSION_CONFLICT");
    assert.equal(details?.actualRevision, undefined);
    return true;
  });
  assert.equal(puts, 1);
});

test("mutation metadata uses actual saved scene, including physical removal and new tombstones", async () => {
  let actualCreatedId = "";
  const { client } = memoryClient(saved => {
    const added = saved.elements.find(element => element.x === 1000)!;
    actualCreatedId = added.id;
    return { ...saved, version: 12, elements: saved.elements.filter(element => element.id !== "right").map(element => element.id === added.id ? { ...element, x: 1200 } : element) };
  });
  const result = await client.applyOps("drawing", [{ op: "add_shape", shape: "rectangle", x: 1000, y: 200 }, { op: "delete", id: "unrelated" }]) as MutationResult;
  assert.equal(result.version, 12);
  assert.deepEqual(result.createdIds, [actualCreatedId]);
  assert.deepEqual(result.deletedIds, ["right", "unrelated"]);
  assert.ok(!result.modifiedIds.includes("old-tombstone"));
  assert.ok(!result.modifiedIds.includes("route"));
  assert.deepEqual(result.changedBounds, { x: 400, y: -100, width: 920, height: 360 });
  assert.ok(Array.isArray(result.validationWarnings));
  assert.ok(Array.isArray(result.validationSkippedChecks));
});

test("group result IDs are excluded from element metadata", async () => {
  const { client } = memoryClient();
  const result = await client.applyOps("drawing", [{ op: "group", ids: ["left", "right"] }]) as MutationResult;
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(result.modifiedIds, ["left", "right"]);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.changedBounds, { x: 0, y: 0, width: 500, height: 100 });
});

test("successful unrelated edit preserves files, appState, custom fields and existing array order", async () => {
  const { client, stored } = memoryClient();
  const original = structuredClone(stored());
  await client.applyOps("drawing", [{ op: "set_style", id: "unrelated", style: { strokeColor: "#f00" } }]);
  assert.deepEqual(stored().files, original.files);
  assert.deepEqual(stored().appState, original.appState);
  assert.deepEqual(stored().elements.map(element => element.id), original.elements.map(element => element.id));
  for (const id of ["left", "right", "route", "manual-label", "old-tombstone"]) assert.deepEqual(getElement(stored().elements, id), getElement(original.elements, id));
  assert.deepEqual(getElement(stored().elements, "unrelated").customData, getElement(original.elements, "unrelated").customData);
});

test("invalid later operation leaves complete stored snapshot unchanged and sends no PUT", async () => {
  const { client, stored, requests } = memoryClient();
  const original = structuredClone(stored());
  await assert.rejects(client.applyOps("drawing", [{ op: "move", id: "left", dx: 30 }, { op: "delete", id: "missing" }]), /ELEMENT_NOT_FOUND/);
  assert.deepEqual(stored(), original);
  assert.deepEqual(requests.map(request => request.method), ["GET"]);
});


test("actual saved tombstone resurrection is created while new tombstones are excluded", async () => {
  const { client } = memoryClient(saved => ({ ...saved, elements: [
    ...saved.elements.map(element => element.id === "old-tombstone" ? { ...element, isDeleted: false } : element),
    { id: "new-tombstone", type: "text", x: 900, y: 100, width: 20, height: 20, isDeleted: true },
  ] }));
  const result = await client.applyOps("drawing", [{ op: "set_style", id: "unrelated", style: { strokeColor: "#f00" } }]) as MutationResult;
  assert.deepEqual(result.createdIds, ["old-tombstone"]);
  assert.deepEqual(result.modifiedIds, ["unrelated"]);
  assert.deepEqual(result.deletedIds, []);
});

test("rotated multipoint route stays exact for unrelated edits and updates only a moved binding", () => {
  const original = fixture();
  const route = getElement(original.elements, "route");
  route.angle = Math.PI / 6;
  const rotatedWorld = (element: Element): number[][] => {
    const angle = Number(element.angle ?? 0);
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    return worldPoints(element).map(([x, y]) => [cx + (x! - cx) * Math.cos(angle) - (y! - cy) * Math.sin(angle), cy + (x! - cx) * Math.sin(angle) + (y! - cy) * Math.cos(angle)]);
  };
  const unrelated = prepareRestBatch(original, [{ op: "set_style", id: "unrelated", style: { opacity: 40 } }]);
  assert.deepEqual(unrelated.elements.find(element => element.id === "route"), route);
  const moved = prepareRestBatch(original, [{ op: "move", id: "left", dx: 25, dy: -15 }]);
  const updated = moved.elements.find(element => element.id === "route") as Element;
  const before = rotatedWorld(route);
  const after = rotatedWorld(updated);
  assert.equal(after.length, before.length);
  assert.ok(Math.abs(after[0]![0]! - before[0]![0]! - 25) < 1e-8);
  assert.ok(Math.abs(after[0]![1]! - before[0]![1]! + 15) < 1e-8);
  for (let index = 1; index < before.length; index += 1) {
    assert.ok(Math.abs(after[index]![0]! - before[index]![0]!) < 1e-8);
    assert.ok(Math.abs(after[index]![1]! - before[index]![1]!) < 1e-8);
  }
});

test("server property serialization order does not report untouched elements as modified", async () => {
  const { client } = memoryClient(saved => ({ ...saved, elements: saved.elements.map(element => Object.fromEntries(Object.entries(element).reverse()) as Element) }));
  const result = await client.applyOps("drawing", [{ op: "set_style", id: "unrelated", style: { strokeColor: "#f00" } }]) as MutationResult;
  assert.deepEqual(result.modifiedIds, ["unrelated"]);
});
