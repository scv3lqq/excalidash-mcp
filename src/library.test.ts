import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ExcaliDashClient, ExcaliDashError, type Fetch } from "./excalidash.js";
import { listLibraryItems, parseLibrary, prepareLibraryInsert, type LibraryItem } from "./library.js";

const shape = (id = "box", extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: -20, y: 10, width: 80, height: 40, angle: 0, ...extra });
const icon = (id = "icon"): LibraryItem => ({ id, name: "Synthetic icon", elements: [
  shape("box", { groupIds: ["group"], boundElements: [{ id: "label", type: "text" }, { id: "external", type: "arrow" }], customData: { nested: ["retained"] }, index: "old", seed: 42 }),
  shape("label", { type: "text", text: "Synthetic API", containerId: "box", groupIds: ["group"], fontSize: 17, fontFamily: 3 }),
  shape("edge", { type: "arrow", x: 60, width: 40, height: 0, points: [[0, 0], [12, -15], [40, 0]], angle: 0.25, startBinding: { elementId: "box", focus: 0, gap: 5 }, endBinding: { elementId: "external" }, frameId: "external" }),
  shape("deleted", { isDeleted: true }),
] });
const drawing = () => ({ id: "drawing", version: 7, elements: [shape("existing", { groupIds: ["existing-group"], customData: { deep: [1, 2] } }), shape("existing-arrow", { type: "arrow", points: [[0, 0], [15, 20], [50, -10]], angle: 0.4, startBinding: { elementId: "existing" }, endBinding: { elementId: "existing" } })] });
const settings = { url: "https://draw.example.test", token: "synthetic-library-key", apiMode: "rest" as const };

test("library parse retains unknown fields and list search/page is stable without invented names", () => {
  const items = parseLibrary({ items: [icon(), { ...icon("second"), name: undefined, custom: { keep: true } }] });
  assert.deepEqual(items[1]?.custom, { keep: true });
  const page = listLibraryItems(items, { search: "SYNTHETIC API", limit: 1, offset: 1 });
  assert.equal(page.totalCount, 2);
  assert.equal(page.items[0]?.id, "second");
  assert.equal(page.items[0]?.name, undefined);
  assert.equal(page.items[0]?.previewNumber, 1);
  assert.equal(page.items[0]?.elementCount, 3);
  assert.deepEqual(page.items[0]?.types, ["rectangle", "text", "arrow"]);
  assert.match(page.items[0]?.text ?? "", /Synthetic API/);
  assert.equal(listLibraryItems(items, { search: "SECOND" }).items.length, 1);
  assert.equal(listLibraryItems(items, { search: "missing" }).totalCount, 0);
  assert.deepEqual(listLibraryItems(parseLibrary({ items: [] }), {}), { items: [], totalCount: 0, limit: 20, offset: 0 });
});

test("library parser rejects malformed containers, duplicate IDs, geometry, refs, and resource limits", () => {
  const invalid: unknown[] = [null, [], {}, { items: {} }, { items: [icon(), icon()] },
    { items: [{ id: "x", elements: [shape(), shape()] }] },
    { items: [{ id: "x", elements: [shape("x", { x: NaN })] }] },
    { items: [{ id: "x", elements: [shape("x", { y: 1e7 + 1 })] }] },
    { items: [{ id: "x", elements: [shape("x", { width: -1 })] }] },
    { items: [{ id: "x", elements: [shape("x", { angle: Infinity })] }] },
    { items: [{ id: "x", elements: [shape("x", { points: [[0, "bad"]] })] }] },
    { items: [{ id: "x", elements: [shape("x", { startBinding: { elementId: 42 } })] }] },
    { items: [{ id: "x", elements: [shape("x", { boundElements: [{ id: 42 }] })] }] },
    { items: [{ id: "x", elements: [shape("x", { groupIds: [null] })] }] },
    { items: [{ id: "x", elements: [shape("x", { text: "x".repeat(10001) })] }] },
    { items: Array.from({ length: 2001 }, (_, i) => icon(String(i))) },
    { items: [{ id: "x", elements: Array.from({ length: 501 }, (_, i) => shape(String(i))) }] },
  ];
  for (const value of invalid) assert.throws(() => parseLibrary(value), /library|element|geometry|reference|limit|coordinate|text/i);
  for (const options of [{ limit: 0 }, { limit: 21 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { search: "x".repeat(201) }]) {
    assert.throws(() => listLibraryItems([icon()], options));
  }
});

test("point budget is enforced per returned page", () => {
  const items = parseLibrary({ items: [0, 1].map(i => ({ id: String(i), elements: [shape(String(i), { type: "freedraw", points: Array.from({ length: 10001 }, () => [0, 0]) })] })) });
  assert.equal(listLibraryItems(items, { limit: 1 }).items.length, 1);
  assert.throws(() => listLibraryItems(items, {}), /20000|point/i);
});

test("insert twice remaps element/groups and internal refs, detaches external refs, preserves prior scene and source", () => {
  const source = icon();
  const target = drawing();
  const before = structuredClone({ source, target });
  const first = prepareLibraryInsert(target, source, { x: 300 });
  const second = prepareLibraryInsert({ ...target, elements: first.elements }, source, { y: -100 });
  assert.deepEqual({ source, target }, before);
  assert.equal(first.version, 7);
  assert.deepEqual(first.elements.slice(0, target.elements.length), target.elements);
  assert.deepEqual(second.elements.slice(0, first.elements.length), first.elements);
  assert.equal(first.createdIds.length, 3);
  assert.ok(first.createdIds.every(id => !second.createdIds.includes(id)));
  const added = first.elements.slice(target.elements.length);
  const next = second.elements.slice(first.elements.length);
  assert.notEqual(added[0]?.groupIds[0], "group");
  assert.notEqual(added[0]?.groupIds[0], next[0]?.groupIds[0]);
  assert.equal(added[0]?.groupIds[0], added[1]?.groupIds[0]);
  assert.equal(added[1]?.containerId, added[0]?.id);
  assert.deepEqual(added[0]?.boundElements, [{ id: added[1]?.id, type: "text" }]);
  assert.equal(added[2]?.startBinding.elementId, added[0]?.id);
  assert.equal(added[2]?.endBinding, null);
  assert.equal(added[2]?.frameId, null);
  assert.deepEqual(added[2]?.points, source.elements[2]?.points);
  assert.equal(added[2]?.angle, 0.25);
  assert.equal(added[0]?.x, 300);
  assert.equal(added[0]?.y, 10);
  assert.equal(next[0]?.x, -20);
  assert.equal(next[0]?.y, -100);
  assert.equal(added[0]?.seed, 42);
  assert.equal(added[1]?.fontSize, 17);
  assert.equal(added[1]?.fontFamily, 3);
  assert.equal(added[0]?.version, 1);
  assert.ok(Number.isSafeInteger(added[0]?.updated));
  assert.ok(Number.isSafeInteger(added[0]?.versionNonce));
  assert.equal(added[0]?.index, undefined);
  assert.deepEqual(added[0]?.customData, { nested: ["retained"] });
});

test("insertion deep-clones nested custom fields inside internal bound references", () => {
  const source = icon();
  const sourceRef = { id: "label", type: "text", custom: { nested: { value: "source" } } };
  source.elements[0]!.boundElements = [sourceRef];
  const before = structuredClone(source);
  const prepared = prepareLibraryInsert(drawing(), source, {});
  const inserted = prepared.elements[2]!;
  const references = inserted.boundElements as { id: string; custom: { nested: { value: string } } }[];
  assert.equal(references[0]?.id, prepared.createdIds[1]);
  references[0]!.custom.nested.value = "changed";
  assert.equal(sourceRef.custom.nested.value, "source");
  assert.deepEqual(source, before);
});

test("internal frames are remapped and deleted references detach", () => {
  const source = { id: "framed", elements: [shape("frame", { type: "frame" }), shape("child", { frameId: "frame", containerId: "deleted", startBinding: { elementId: "deleted" } }), shape("deleted", { isDeleted: true })] };
  const prepared = prepareLibraryInsert(drawing(), source, {});
  const added = prepared.elements.slice(2);
  assert.equal(added[1]?.frameId, added[0]?.id);
  assert.equal(added[1]?.containerId, null);
  assert.equal(added[1]?.startBinding, null);
});

test("UUID generation retries cross element/group collisions and fails after ten attempts", () => {
  const original = crypto.randomUUID;
  let calls = 0;
  const mocked = test.mock.method(crypto, "randomUUID", () => {
    calls += 1;
    return calls === 1 ? "existing-group" as ReturnType<typeof original> : original();
  });
  try {
    assert.equal(prepareLibraryInsert(drawing(), icon(), {}).createdIds.length, 3);
    assert.ok(calls >= 5);
  } finally { mocked.mock.restore(); }
  const collide = test.mock.method(crypto, "randomUUID", () => "existing" as ReturnType<typeof original>);
  try {
    assert.throws(() => prepareLibraryInsert(drawing(), icon(), {}), /collision/i);
    assert.equal(collide.mock.callCount(), 10);
  } finally { collide.mock.restore(); }
});

test("insertion rejects unsupported assets, invalid versions/coordinates, empty items and scene size", () => {
  for (const source of [{ id: "image", elements: [shape("x", { type: "image" })] }, { id: "asset", elements: [shape("x", { fileId: "file" })] }, { id: "empty", elements: [] }]) {
    assert.throws(() => prepareLibraryInsert(drawing(), source, {}));
  }
  for (const version of [undefined, 1.5, -1]) assert.throws(() => prepareLibraryInsert({ ...drawing(), version }, icon(), {}), /version/i);
  for (const x of [NaN, Infinity, 1e7 + 1]) assert.throws(() => prepareLibraryInsert(drawing(), icon(), { x }));
  assert.throws(() => prepareLibraryInsert({ version: 0, elements: Array.from({ length: 9999 }, (_, i) => shape(String(i))) }, icon(), {}), /10000/);
});

function memoryClient(library: unknown = { items: [icon()] }) {
  let stored = drawing();
  const requests: { path: string; init?: RequestInit }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, init });
    if (path === "/api/library") { assert.equal(init?.method, "GET"); return Response.json(library); }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { version: number; elements: typeof stored.elements };
      assert.deepEqual(Object.keys(body).sort(), ["elements", "version"]);
      assert.equal(body.version, stored.version);
      stored = { ...stored, elements: body.elements, version: stored.version + 1 };
    }
    return Response.json(stored);
  };
  return { client: new ExcaliDashClient(settings, fetchImpl), requests, stored: () => stored };
}

test("client fetches Library per call and appends twice with exact versioned PUT, never generic ops", async () => {
  const { client, requests, stored } = memoryClient();
  const page = await client.listLibraryItems();
  assert.equal(page.previewItems.length, 1);
  assert.equal((await client.getLibraryItem("icon")).id, "icon");
  const before = structuredClone(stored().elements);
  const first = await client.insertLibraryItem("drawing", "icon", { x: 300 });
  const after = structuredClone(stored().elements);
  const second = await client.insertLibraryItem("drawing", "icon", {});
  assert.equal(first.version, 8);
  assert.equal(second.version, 9);
  assert.equal(first.elementCount, 3);
  assert.equal(first.libraryItemId, "icon");
  assert.equal(first.drawingId, "drawing");
  assert.ok(first.createdIds.every(id => !second.createdIds.includes(id)));
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(stored().elements.slice(0, after.length), after);
  assert.equal(requests.filter(r => r.path === "/api/library").length, 4);
  assert.equal(requests.filter(r => r.init?.method === "PUT").length, 2);
  assert.ok(requests.every(r => r.init?.redirect === "error" && r.init.signal));
});

test("client propagates 401/403, unknown IDs, rejects non-REST and invalid data without PUT", async () => {
  for (const status of [401, 403]) {
    const client = new ExcaliDashClient(settings, async () => Response.json({ error: "denied" }, { status }));
    await assert.rejects(client.listLibraryItems(), (error: unknown) => error instanceof ExcaliDashError && error.status === status);
  }
  const unknown = memoryClient();
  await assert.rejects(unknown.client.getLibraryItem("missing"), (error: unknown) => error instanceof ExcaliDashError && error.status === 404);
  await assert.rejects(unknown.client.insertLibraryItem("drawing", "missing", {}));
  assert.equal(unknown.requests.filter(r => r.init?.method === "PUT").length, 0);
  for (const library of [{ items: [icon(), icon()] }, { items: [{ id: "bad", elements: [shape("x", { fileId: "asset" })] }] }, { items: [{ id: "bad", elements: [] }] }, { items: [{ id: "bad", elements: [shape("deleted", { isDeleted: true })] }] }]) {
    const { client, requests } = memoryClient(library);
    await assert.rejects(client.insertLibraryItem("drawing", "bad", {}));
    assert.equal(requests.filter(r => r.path !== "/api/library").length, 0);
  }
  let calls = 0;
  const native = new ExcaliDashClient({ ...settings, apiMode: undefined }, async () => { calls += 1; return Response.json({}); });
  await assert.rejects(native.insertLibraryItem("drawing", "icon", {}), /REST/);
  assert.equal(calls, 0);
});

test("client rejects oversized body and invalid/missing inserted IDs in saved response", async () => {
  const large = memoryClient({ items: [{ ...icon(), payload: "retained" }] });
  // Unknown custom data remains intact and counts towards the encoded PUT cap.
  const giantItem = { id: "large", elements: [shape("large", { customData: "x".repeat(2 * 1024 * 1024) })] };
  let giantPuts = 0;
  const giant = new ExcaliDashClient(settings, async (url, init) => {
    if (init?.method === "PUT") giantPuts++;
    return Response.json(String(url).endsWith("/library") ? { items: [giantItem] } : { ...drawing(), retainedCustomData: true, elements: [shape("original", { customData: "x".repeat(9 * 1024 * 1024) })] });
  });
  await assert.rejects(giant.insertLibraryItem("drawing", "large", {}), /10 MiB/);
  assert.equal(giantPuts, 0);
  assert.equal((await large.client.getLibraryItem("icon")).payload, "retained");
  for (const saved of [{ ...drawing(), version: 8 }, { ...drawing(), version: 1.5 }]) {
    let puts = 0;
    const client = new ExcaliDashClient(settings, async (url, init) => {
      if (String(url).endsWith("/library")) return Response.json({ items: [icon()] });
      if (init?.method === "PUT") { puts += 1; return Response.json(saved); }
      return Response.json(drawing());
    });
    await assert.rejects(client.insertLibraryItem("drawing", "icon", {}), /saved|version|inserted/i);
    assert.equal(puts, 1);
  }
});

test("client surfaces 409 with fresh-read guidance and never retries PUT", async () => {
  let puts = 0;
  const client = new ExcaliDashClient(settings, async (url, init) => {
    if (String(url).endsWith("/library")) return Response.json({ items: [icon()] });
    if (init?.method === "PUT") { puts += 1; return Response.json({ error: "conflict" }, { status: 409 }); }
    return Response.json(drawing());
  });
  await assert.rejects(client.insertLibraryItem("drawing", "icon", {}), /VERSION_CONFLICT.*fresh read/);
  assert.equal(puts, 1);
});
