import assert from "node:assert/strict";
import test from "node:test";

type Element = Record<string, unknown>;
type Bounds = { x: number; y: number; width: number; height: number };
type Scene = { version: number; elements: Element[] };
type Issue = { severity: "error" | "warning" | "info"; type: string; elementIds: string[]; explanation: string; suggestion?: string };
type Inspection = { version: number; elements: Element[]; totalCount: number; offset: number; limit: number; nextOffset: number | null; truncated: boolean };
type Validation = { version: number; issues: Issue[]; truncated: boolean; skippedChecks: unknown[] };
type Schema = { parse(input: unknown): Record<string, unknown>; safeParse(input: unknown): { success: boolean } };
type Analysis = {
  boundsSchema: Schema;
  inspectionOptionsSchema: Schema;
  validationOptionsSchema: Schema;
  elementBounds(element: Element): Bounds | null;
  inspectScene(scene: Scene, options?: Record<string, unknown>): Inspection;
  validateDrawing(scene: Scene, options?: Record<string, unknown>): Validation;
};

async function analysis(): Promise<Analysis> {
  const modulePath = "./drawing-analysis.js";
  return await import(modulePath) as Analysis;
}

function node(id: string, x = 0, y = 0, extra: Element = {}): Element {
  return { id, type: "rectangle", x, y, width: 100, height: 60, angle: 0, ...extra };
}

function scene(elements: Element[], version = 7): Scene {
  return { version, elements };
}

function hasIssue(result: Validation, id: string, explanation: RegExp): boolean {
  return result.issues.some(issue => issue.elementIds.includes(id) && explanation.test(`${issue.type} ${issue.explanation}`));
}

test("analysis schemas validate finite bounds, limits and safe revisions before defaults", async () => {
  const api = await analysis();
  assert.deepEqual(api.boundsSchema.parse({ x: -20, y: -10, width: 1, height: 2 }), { x: -20, y: -10, width: 1, height: 2 });
  for (const invalid of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: Infinity, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: -1 }]) {
    assert.equal(api.boundsSchema.safeParse(invalid).success, false);
  }
  const defaults = api.inspectionOptionsSchema.parse({});
  assert.equal(defaults.mode, "compact");
  assert.equal(defaults.includeDeleted, false);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.limit, 100);
  for (const invalid of [{ ids: [] }, { ids: Array.from({ length: 201 }, () => "x") }, { types: [] }, { types: Array.from({ length: 31 }, () => "x") }, { limit: 0 }, { limit: 201 }, { offset: -1 }, { expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(api.inspectionOptionsSchema.safeParse(invalid).success, false);
  }
  assert.equal(api.validationOptionsSchema.parse({}).maxIssues, 100);
  for (const maxIssues of [0, 501, 1.5]) assert.equal(api.validationOptionsSchema.safeParse({ maxIssues }).success, false);
});

test("compact inspection retains full text, order, geometry, style and binding metadata", async () => {
  const api = await analysis();
  const text = "A full label ".repeat(500);
  const input = scene([
    node("under", -40, -30, { angle: Math.PI / 4, index: "a0", opacity: 60, locked: true, groupIds: ["g"], frameId: "f", strokeColor: "#abc", backgroundColor: "#fff", fillStyle: "hachure", strokeWidth: 3 }),
    { id: "label", type: "text", x: 1, y: 2, width: 3, height: 4, text, originalText: text, containerId: "under", fontSize: 20, fontFamily: 5 },
    { id: "edge", type: "arrow", x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [5, 2], [10, 0]], startBinding: { elementId: "under", focus: 0, gap: 5 }, endBinding: null, boundElements: [{ id: "label", type: "text" }], hidden: true },
    node("deleted", 0, 0, { isDeleted: true }),
  ]);
  const result = api.inspectScene(input, {});
  assert.equal(result.version, 7);
  assert.equal(result.totalCount, 3);
  assert.deepEqual(result.elements.map(element => [element.id, element.arrayIndex]), [["under", 0], ["label", 1], ["edge", 2]]);
  for (const key of ["x", "y", "width", "height", "angle", "index", "opacity", "locked", "groupIds", "frameId", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth"]) assert.deepEqual(result.elements[0]?.[key], input.elements[0]?.[key]);
  assert.equal(result.elements[1]?.text, text);
  assert.deepEqual(result.elements[2]?.points, input.elements[2]?.points);
  assert.deepEqual(result.elements[2]?.startBinding, input.elements[2]?.startBinding);
  assert.deepEqual(result.elements[2]?.boundElements, input.elements[2]?.boundElements);
  assert.equal(result.elements[2]?.hidden, true);
});

test("detailed inspection retains arbitrary nested fields and original deleted array indices", async () => {
  const api = await analysis();
  const custom = { nested: ["retained", { flag: true }] };
  const input = scene([node("dead", 0, 0, { isDeleted: true }), node("live", 200, 0, { custom })]);
  const result = api.inspectScene(input, { mode: "detailed", includeDeleted: true });
  assert.deepEqual(result.elements[1], { ...input.elements[1], arrayIndex: 1 });
  assert.deepEqual(result.elements[0], { ...input.elements[0], arrayIndex: 0 });
});

test("inspection combines ID, type and intersecting bounds filters without changing revision", async () => {
  const api = await analysis();
  const input = scene([node("far", 500), node("inside", 10), node("partial", -90), node("other", 10, 0, { type: "ellipse" }), node("dead", 10, 0, { isDeleted: true })], 41);
  const result = api.inspectScene(input, { ids: ["partial", "inside", "other", "dead"], types: ["rectangle"], bounds: { x: 0, y: 0, width: 50, height: 50 } });
  assert.equal(result.version, 41);
  assert.deepEqual(result.elements.map(element => element.id), ["inside", "partial"]);
  assert.deepEqual(result.elements.map(element => element.arrayIndex), [1, 2]);
});

test("inspection pagination requires a matching revision after the first page", async () => {
  const api = await analysis();
  const input = scene([node("a"), node("b"), node("c")], 8);
  const first = api.inspectScene(input, { limit: 2 });
  assert.deepEqual({ offset: first.offset, limit: first.limit, nextOffset: first.nextOffset, truncated: first.truncated, totalCount: first.totalCount }, { offset: 0, limit: 2, nextOffset: 2, truncated: true, totalCount: 3 });
  assert.throws(() => api.inspectScene(input, { offset: 2, limit: 2 }), /revision/i);
  assert.throws(() => api.inspectScene(input, { offset: 2, expectedRevision: 7 }), /revision|conflict/i);
  const second = api.inspectScene(input, { offset: 2, limit: 2, expectedRevision: 8 });
  assert.deepEqual(second.elements.map(element => element.id), ["c"]);
  assert.equal(second.nextOffset, null);
  assert.equal(second.truncated, false);
  assert.throws(() => api.inspectScene(input, { expectedRevision: 9 }), /revision|conflict/i);
});

test("serialized inspection pages stay within 1 MiB without truncating text", async () => {
  const api = await analysis();
  const text = "Ж".repeat(180_000);
  const input = scene(Array.from({ length: 6 }, (_, index) => node(String(index), index * 200, 0, { type: "text", text })));
  const seen: string[] = [];
  let offset = 0;
  do {
    const page = api.inspectScene(input, { offset, limit: 200, expectedRevision: 7 });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 1_048_576);
    assert.ok(page.elements.length > 0);
    for (const element of page.elements) {
      assert.equal(element.text, text);
      seen.push(String(element.id));
    }
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset < input.elements.length);
  assert.deepEqual(seen, ["0", "1", "2", "3", "4", "5"]);
  assert.throws(() => api.inspectScene(scene([node("huge", 0, 0, { text: "x".repeat(1_048_576) })])), /too.large|1.?mi?b|size|limit/i);
});

test("inspection handles empty scenes and 10000 elements deterministically", async () => {
  const api = await analysis();
  const empty = api.inspectScene(scene([]));
  assert.deepEqual(empty.elements, []);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.truncated, false);
  const input = scene(Array.from({ length: 10_000 }, (_, index) => node(String(index), index * 200)));
  const last = api.inspectScene(input, { offset: 9_900, expectedRevision: 7 });
  assert.equal(last.totalCount, 10_000);
  assert.equal(last.elements.length, 100);
  assert.equal(last.elements[0]?.arrayIndex, 9_900);
  assert.equal(last.nextOffset, null);
});

test("element bounds rotate rectangles and measure multipoint lines without mutation", async () => {
  const api = await analysis();
  const rotated = node("r", -100, -50, { width: 100, height: 20, angle: Math.PI / 2 });
  const snapshot = structuredClone(rotated);
  const bounds = api.elementBounds(rotated);
  assert.ok(bounds);
  assert.ok(Math.abs(bounds.x - -60) < 1e-9);
  assert.ok(Math.abs(bounds.y - -90) < 1e-9);
  assert.ok(Math.abs(bounds.width - 20) < 1e-9);
  assert.ok(Math.abs(bounds.height - 100) < 1e-9);
  assert.deepEqual(api.elementBounds({ id: "l", type: "line", x: -10, y: 20, width: 100, height: 0, points: [[0, 0], [-30, 40], [100, 0]] }), { x: -40, y: 20, width: 130, height: 40 });
  assert.deepEqual(rotated, snapshot);
  assert.equal(api.elementBounds(node("bad", NaN)), null);
});

test("validation reports invalid raw geometry without defaulting it away", async () => {
  const api = await analysis();
  for (const [key, value] of [["x", NaN], ["y", Infinity], ["width", -1], ["height", "60"], ["angle", Infinity], ["x", undefined]] as const) {
    const input = scene([node("invalid", 0, 0, { [key]: value })]);
    const result = api.validateDrawing(input);
    assert.ok(hasIssue(result, "invalid", /geometry|coordinate|finite|dimension|angle|number/i), `${key}=${String(value)}`);
    assert.ok(result.issues.some(issue => issue.severity === "error"));
  }
});

test("validation accepts negative positions and zero dimensions of horizontal and vertical lines", async () => {
  const api = await analysis();
  const result = api.validateDrawing(scene([
    node("negative", -300, -200),
    { id: "horizontal", type: "line", x: -100, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] },
    { id: "vertical", type: "arrow", x: 100, y: -100, width: 0, height: 100, points: [[0, 0], [0, 100]] },
  ]));
  assert.equal(result.issues.length, 0);
});

test("invalid line points and malformed references produce issues instead of crashes", async () => {
  const api = await analysis();
  for (const points of [null, "invalid", [], [[0, 0]], [[0, 0], [NaN, 1]], [[0, 0], [1]], [[0, 0], [1, 2, 3]]]) {
    const result = api.validateDrawing(scene([node("line", 0, 0, { type: "line", points })]));
    assert.ok(hasIssue(result, "line", /point|geometry/i), JSON.stringify(points));
  }
  for (const malformed of [{ boundElements: {} }, { boundElements: [null, { nope: "x" }] }, { startBinding: [] }, { endBinding: { elementId: 12 } }, { containerId: 3 }, { frameId: {} }]) {
    const result = api.validateDrawing(scene([node("bad", 0, 0, malformed)]));
    assert.ok(result.issues.some(issue => issue.elementIds.includes("bad")), JSON.stringify(malformed));
  }
});

test("duplicate IDs and all missing reference kinds are reported in deterministic order", async () => {
  const api = await analysis();
  const input = scene([
    node("duplicate", 0), node("duplicate", 200),
    node("container", 400, 0, { containerId: "absent-container" }),
    node("frame", 600, 0, { frameId: "absent-frame" }),
    node("bound", 800, 0, { boundElements: [{ id: "absent-label", type: "text" }] }),
    node("start", 1000, 0, { type: "arrow", points: [[0, 0], [100, 60]], startBinding: { elementId: "absent-start" } }),
    node("end", 1200, 0, { type: "arrow", points: [[0, 0], [100, 60]], endBinding: { elementId: "absent-end" } }),
  ]);
  const result = api.validateDrawing(input);
  assert.ok(hasIssue(result, "duplicate", /duplicate/i));
  for (const id of ["container", "frame", "bound", "start", "end"]) assert.ok(hasIssue(result, id, /missing|reference|not.found/i), id);
  assert.deepEqual(api.validateDrawing(input), result);
  for (const issue of result.issues) {
    assert.ok(["error", "warning", "info"].includes(issue.severity));
    assert.ok(issue.explanation.length > 0);
    assert.ok(issue.type.length > 0);
  }
});

test("explicit bound labels, frame children and contained group decoration are intentional overlaps", async () => {
  const api = await analysis();
  const input = scene([
    node("box", 0, 0, { boundElements: [{ id: "label", type: "text" }] }),
    node("label", 10, 10, { type: "text", width: 50, height: 20, text: "label", containerId: "box" }),
    node("frame", 300, 0, { type: "frame", width: 200, height: 150 }),
    node("child", 320, 20, { frameId: "frame" }),
    node("decor", 600, 0, { groupIds: ["g"], width: 200, height: 150 }),
    node("group-child", 620, 20, { groupIds: ["g"] }),
  ]);
  assert.equal(api.validateDrawing(input).issues.length, 0);
});

test("crossing nodes in the same group still report substantial overlaps", async () => {
  const api = await analysis();
  const result = api.validateDrawing(scene([node("a", 0, 0, { groupIds: ["g"] }), node("b", 30, 10, { groupIds: ["g"] })]));
  assert.ok(result.issues.some(issue => issue.elementIds.includes("a") && issue.elementIds.includes("b") && /overlap/i.test(`${issue.type} ${issue.explanation}`)));
});

test("deleted and invisible nodes do not trigger independent overlap warnings", async () => {
  const api = await analysis();
  for (const visibility of [{ isDeleted: true }, { hidden: true }, { opacity: 0 }]) {
    assert.equal(api.validateDrawing(scene([node("a"), node("b", 20, 0, visibility)])).issues.length, 0);
  }
});

test("region and frame boundary checks include rotated bounds", async () => {
  const api = await analysis();
  const rotated = node("rotated", 0, 0, { width: 100, height: 20, angle: Math.PI / 2 });
  const region = api.validateDrawing(scene([rotated]), { region: { x: 0, y: 0, width: 100, height: 20 } });
  assert.ok(hasIssue(region, "rotated", /region|boundar|outside/i));
  const frame = api.validateDrawing(scene([node("frame", 0, 0, { type: "frame", width: 200, height: 100 }), node("child", 180, 20, { frameId: "frame" })]), { frameId: "frame" });
  assert.ok(hasIssue(frame, "child", /frame|boundar|outside/i));
  const missing = api.validateDrawing(scene([]), { frameId: "missing" });
  assert.ok(missing.issues.length > 0);
});

test("validation caps issues and pair computations and explicitly records skipped checks", async () => {
  const api = await analysis();
  const invalid = scene(Array.from({ length: 20 }, (_, index) => node(String(index), NaN)));
  const capped = api.validateDrawing(invalid, { maxIssues: 3 });
  assert.equal(capped.issues.length, 3);
  assert.equal(capped.truncated, true);
  const exact = api.validateDrawing(scene([node("bad", NaN)]), { maxIssues: 1 });
  assert.equal(exact.issues.length, 1);
  assert.equal(exact.truncated, false);
  const large = api.validateDrawing(scene(Array.from({ length: 10_000 }, (_, index) => node(String(index), index * 200))), { maxIssues: 500 });
  const skipped = JSON.stringify(large.skippedChecks);
  assert.match(skipped, /200000|200,000|pair|computation/i);
  assert.match(skipped, /font|text/i);
  assert.match(skipped, /connector|obstruction/i);
  assert.equal(large.issues.length, 0);
});

test("inspection and validation never mutate scene objects or nested fields", async () => {
  const api = await analysis();
  const input = scene([node("a", -20, 0, { groupIds: ["g"], custom: { nested: ["unchanged"] }, boundElements: [{ id: "label", type: "text" }] }), node("label", 0, 0, { type: "text", text: "unchanged", containerId: "a" }), node("b", 10)]);
  const before = structuredClone(input);
  api.inspectScene(input, { mode: "detailed" });
  api.validateDrawing(input);
  assert.deepEqual(input, before);
});

test("overlap requires both the 20 percent ratio and 64 square unit thresholds", async () => {
  const api = await analysis();
  const overlapCount = (elements: Element[]): number => api.validateDrawing(scene(elements)).issues.filter(issue => issue.type === "node_overlap").length;
  assert.equal(overlapCount([node("a"), node("b", 81)]), 0);
  assert.equal(overlapCount([node("a"), node("b", 80)]), 1);
  assert.equal(overlapCount([node("a", 0, 0, { width: 7, height: 8 }), node("b", 0, 0, { width: 7, height: 8 })]), 0);
  assert.equal(overlapCount([node("a", 0, 0, { width: 8, height: 8 }), node("b", 0, 0, { width: 8, height: 8 })]), 1);
  assert.equal(overlapCount([node("a", 1_000_000_000, 1_000_000_000), node("b", 1_000_000_080, 1_000_000_000)]), 1);
});

test("rotated polygon checks avoid false overlaps from intersecting axis bounds", async () => {
  const api = await analysis();
  const input = scene([node("a", 0, 0, { height: 10, angle: Math.PI / 4 }), node("b", 0, 20, { height: 10, angle: Math.PI / 4 })]);
  const a = api.elementBounds(input.elements[0]!);
  const b = api.elementBounds(input.elements[1]!);
  assert.ok(a && b && a.y + a.height > b.y && a.x + a.width > b.x);
  assert.equal(api.validateDrawing(input).issues.filter(issue => issue.type === "node_overlap").length, 0);
});

test("revision conflicts expose structured details and missing references include deleted targets", async () => {
  const api = await analysis();
  assert.throws(() => api.inspectScene(scene([]), { expectedRevision: 8 }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.deepEqual((error as Error & { details?: unknown }).details, { code: "VERSION_CONFLICT", expectedRevision: 8, actualRevision: 7 });
    return true;
  });
  const result = api.validateDrawing(scene([node("dead", 0, 0, { isDeleted: true }), node("child", 200, 0, { containerId: "dead" })]));
  assert.ok(result.issues.some(issue => issue.type === "missing_reference" && issue.elementIds.includes("child")));
});

test("bounds accept long valid freehand paths without spreading them into call arguments", async () => {
  const api = await analysis();
  const points = Array.from({ length: 150_000 }, (_, index) => [index, index % 2]);
  assert.deepEqual(api.elementBounds({ id: "path", type: "freedraw", x: -1, y: -2, width: 149_999, height: 1, points }), { x: -1, y: -2, width: 149_999, height: 1 });
});

test("zero-length connectors report invalid geometry even when point pairs are finite", async () => {
  const api = await analysis();
  const result = api.validateDrawing(scene([
    { id: "zero", type: "arrow", x: 0, y: 0, width: 0, height: 0, points: [[0, 0], [0, 0]] },
  ]));
  assert.ok(result.issues.some(issue => issue.type === "invalid_geometry" && issue.elementIds.includes("zero")));
});
