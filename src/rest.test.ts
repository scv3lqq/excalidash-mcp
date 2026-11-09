import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, ExcaliDashClient, ExcaliDashError, type Fetch } from "./excalidash.js";

const token = "fake-rest-test-token";
const settings = () => configFromEnv({ EXCALIDASH_URL: "https://draw.example.test", EXCALIDASH_API_KEY: token, EXCALIDASH_API_MODE: "rest" });
const scene = () => ({ id: "drawing", name: "Payment", version: 7, elements: [
  { id: "api", type: "rectangle", x: 0, y: 0, width: 120, height: 60, boundElements: [{ id: "label", type: "text" }], custom: { nested: ["retained"] } },
  { id: "label", type: "text", text: "Payment API", containerId: "api", x: 5, y: 5, width: 100, height: 25 },
  { id: "db", type: "rectangle", x: 300, y: 0, width: 120, height: 60 },
  { id: "edge", type: "arrow", x: 120, y: 30, width: 180, height: 0, startBinding: { elementId: "api" }, endBinding: { elementId: "db" } },
  { id: "dead", type: "text", text: "Deleted", containerId: "api", isDeleted: true },
], appState: { keep: "viewport" }, files: { asset: { dataURL: "keep" } } });
const add = { op: "add_shape", shape: "rectangle", x: 600, y: 0, label: "Fraud" };
type SavedScene = { version: number; elements: Record<string, unknown>[] };
type BatchResult = { version: number; results: { createdIds?: string[] }[]; changedIds: string[]; summaryDelta: string[]; clientBatchId?: string };

function memoryClient() {
  let stored: SavedScene & Record<string, unknown> = scene();
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as SavedScene;
      assert.deepEqual(Object.keys(body).sort(), ["elements", "version"]);
      assert.equal(body.version, stored.version);
      stored = { ...stored, elements: body.elements, version: stored.version + 1 };
    }
    return Response.json(stored);
  };
  return { client: new ExcaliDashClient(settings(), fetchImpl), requests, stored: () => stored };
}

test("REST config is opt-in and rejects unknown nonempty modes", () => {
  assert.equal((settings() as { apiMode?: string }).apiMode, "rest");
  assert.throws(() => configFromEnv({ ...process.env, EXCALIDASH_URL: "https://draw.example.test", EXCALIDASH_API_KEY: token, EXCALIDASH_API_MODE: "legacy" }), /EXCALIDASH_API_MODE/);
});

test("REST list, create and get normalize missing engine", async () => {
  const fetchImpl: Fetch = async (url, init) => Response.json(String(url).includes("?") ? { drawings: [scene()], totalCount: 1, limit: 50, offset: 0 } : { ...scene(), createdBy: init?.method });
  const client = new ExcaliDashClient(settings(), fetchImpl);
  assert.equal((await client.listDrawings()).drawings[0]?.engine, "excalidraw");
  assert.equal((await client.createDrawing("Payment")).engine, "excalidraw");
  assert.equal((await client.getDrawing("drawing")).engine, "excalidraw");
});

test("REST summary reads full scene and includes labels and connections", async () => {
  const { client, requests } = memoryClient();
  const summary = await client.getSummary("drawing");
  assert.match(summary, /Payment API/);
  assert.match(summary, /api->db/);
  assert.match(summary, /v7/);
  assert.doesNotMatch(summary, /Deleted/);
  assert.equal(requests[0]?.url, "https://draw.example.test/api/drawings/drawing");
});

test("REST inspector returns live element and live bound children", async () => {
  const { client } = memoryClient();
  const inspected = await client.inspectElement("drawing", "api") as { element: { id: string }; children: { id: string }[] };
  assert.equal(inspected.element.id, "api");
  assert.deepEqual(inspected.children.map(child => child.id), ["label"]);
  await assert.rejects(client.inspectElement("drawing", "dead"), /not found/i);
  await assert.rejects(client.inspectElement("drawing", "missing"), /not found/i);
});

test("REST creates referenced shapes and a bound arrow then preserves them in a later batch", async () => {
  const { client, stored, requests } = memoryClient();
  const before = structuredClone(stored().elements);
  const result = await client.applyOps("drawing", [
    { op: "add_shape", ref: "gateway", shape: "rectangle", x: 0, y: 200, label: "Gateway" },
    { op: "add_shape", ref: "service", shape: "rectangle", x: 300, y: 200, label: "Service" },
    { op: "connect", fromId: "$gateway", toId: "$service", label: "HTTPS" },
  ], "correlation-only") as BatchResult;
  assert.equal(result.version, 8);
  assert.equal(result.clientBatchId, "correlation-only");
  assert.equal(result.results.length, 3);
  const fromId = result.results[0]?.createdIds?.[0];
  const toId = result.results[1]?.createdIds?.[0];
  const edgeId = result.results[2]?.createdIds?.[0];
  assert.ok(fromId && toId && edgeId);
  const arrow = stored().elements.find(el => el.id === edgeId);
  assert.equal((arrow?.startBinding as { elementId: string }).elementId, fromId);
  assert.equal((arrow?.endBinding as { elementId: string }).elementId, toId);
  assert.ok((stored().elements.find(el => el.id === fromId)?.boundElements as { id: string }[]).some(ref => ref.id === edgeId));
  assert.ok(result.changedIds.includes(edgeId));
  assert.ok(result.summaryDelta.some(line => line.includes(edgeId)));
  const ids = stored().elements.map(el => el.id);
  const second = await client.applyOps("drawing", [add]) as BatchResult;
  assert.equal(second.version, 9);
  for (const id of ids) assert.ok(stored().elements.some(el => el.id === id));
  assert.ok(stored().elements.some(el => el.text === "Fraud"));
  assert.deepEqual(stored().elements.find(el => el.id === "api")?.custom, { nested: ["retained"] });
  assert.deepEqual(before.find(el => el.id === "api")?.custom, { nested: ["retained"] });
  assert.equal(requests.filter(req => req.init?.method === "PUT").length, 2);
});

test("invalid batches are atomic and never PUT", async () => {
  const { client, requests, stored } = memoryClient();
  const before = structuredClone(stored());
  await assert.rejects(client.applyOps("drawing", [{ op: "move", id: "api", dx: 20 }, { op: "delete", id: "missing" }]), /ELEMENT_NOT_FOUND/);
  assert.equal(requests.filter(req => req.init?.method === "PUT").length, 0);
  assert.deepEqual(stored(), before);
});

test("REST batch preparation deep-clones nested scene and operation properties", async () => {
  const modulePath = "./rest.js";
  const { prepareRestBatch } = await import(modulePath) as { prepareRestBatch: (drawing: unknown, ops: unknown[]) => { elements: Record<string, unknown>[] } };
  const input = scene();
  const operations = [{ op: "import_elements", elements: [{ id: "import", type: "rectangle", custom: { child: ["original"] } }] }];
  const snapshot = structuredClone({ input, operations });
  const prepared = prepareRestBatch(input, operations);
  const custom = prepared.elements.find(el => el.id === "api")?.custom as { nested: string[] };
  custom.nested.push("mutated");
  const imported = prepared.elements.find(el => el.id !== "import" && (el.custom as { child?: unknown } | undefined)?.child) as { custom: { child: string[] } };
  imported.custom.child.push("mutated");
  assert.deepEqual({ input, operations }, snapshot);
});

test("REST PUT sends only elements and integer version", async () => {
  const { client, requests } = memoryClient();
  await client.applyOps("drawing", [add]);
  const put = requests.find(req => req.init?.method === "PUT");
  assert.ok(put);
  const body = JSON.parse(String(put.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["elements", "version"]);
  assert.equal(body.version, 7);
  assert.equal(put.init?.redirect, "error");
  assert.ok(put.init?.signal);
});

test("REST returns actual saved elements and version", async () => {
  let createdId: unknown;
  const client = new ExcaliDashClient(settings(), async (_url, init) => {
    if (init?.method !== "PUT") return Response.json(scene());
    const body = JSON.parse(String(init.body)) as SavedScene;
    createdId = body.elements.find(el => el.id !== "api" && el.type === "rectangle" && el.x === 600)?.id;
    return Response.json({ ...scene(), version: 12, elements: body.elements.map(el => el.id === createdId ? { ...el, x: 700 } : el) });
  });
  const result = await client.applyOps("drawing", [add]) as BatchResult;
  assert.equal(result.version, 12);
  assert.ok(result.summaryDelta.some(line => line.includes(`${String(createdId)} rectangle 700,0`)));
});

test("REST conflicts fail once with a fresh-read instruction", async () => {
  let puts = 0;
  const client = new ExcaliDashClient(settings(), async (_url, init) => {
    if (init?.method !== "PUT") return Response.json(scene());
    puts += 1;
    return Response.json({ error: "Version conflict" }, { status: 409 });
  });
  await assert.rejects(client.applyOps("drawing", [add]), /VERSION_CONFLICT.*fresh read/i);
  assert.equal(puts, 1);
});

test("HTTP errors redact an echoed key before truncation", async () => {
  const client = new ExcaliDashClient(settings(), async () => new Response(`${token} ${"x".repeat(1990)} ${token}`, { status: 401 }));
  await assert.rejects(client.getSummary("drawing"), (error: unknown) => {
    assert.ok(error instanceof ExcaliDashError);
    assert.equal(error.status, 401);
    assert.ok(error.message.length < 2100);
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes(token.slice(0, 10)));
    return true;
  });
});

test("missing or fractional version rejects without PUT", async () => {
  for (const version of [undefined, 1.5]) {
    let puts = 0;
    const client = new ExcaliDashClient(settings(), async (_url, init) => {
      if (init?.method === "PUT") puts += 1;
      return Response.json({ ...scene(), version });
    });
    await assert.rejects(client.applyOps("drawing", [add]), /version/i);
    assert.equal(puts, 0);
  }
});

test("unsupported revert and empty or over-50 batches reject before HTTP", async () => {
  let requests = 0;
  const client = new ExcaliDashClient(settings(), async () => { requests += 1; return Response.json(scene()); });
  await assert.rejects(client.applyOps("drawing", [{ op: "revert_to_snapshot", version: 1 }]), /UNSUPPORTED/);
  await assert.rejects(client.applyOps("drawing", []));
  await assert.rejects(client.applyOps("drawing", Array.from({ length: 51 }, () => add)));
  assert.equal(requests, 0);
});

test("REST caps source scenes at 10000 elements", async () => {
  let puts = 0;
  const client = new ExcaliDashClient(settings(), async (_url, init) => {
    if (init?.method === "PUT") puts += 1;
    return Response.json({ ...scene(), elements: Array.from({ length: 10001 }, (_, i) => ({ id: String(i), type: "rectangle" })) });
  });
  await assert.rejects(client.applyOps("drawing", [add]), /10000/);
  assert.equal(puts, 0);
});

test("summary bounds visual analysis to first 1000 live elements with actual count", async () => {
  const client = new ExcaliDashClient(settings(), async () => Response.json({ ...scene(), elements: Array.from({ length: 1001 }, (_, i) => ({ id: `shape-${i}`, type: "rectangle", x: i * 200, y: 0, width: 120, height: 60 })) }));
  const summary = await client.getSummary("drawing");
  assert.match(summary, /1001/);
  assert.match(summary, /truncated.*1000/i);
  assert.match(summary, /shape-999/);
  assert.doesNotMatch(summary, /shape-1000 rectangle/);
});

test("HTTP streaming response aborts at 10 MiB without consuming the remainder", async () => {
  let cancelled = false;
  let chunks = 0;
  const client = new ExcaliDashClient(settings(), async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (chunks === 20) { controller.close(); return; } chunks += 1; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(client.getSummary("drawing"), /10 MiB/);
  assert.ok(cancelled);
  assert.ok(chunks <= 12);
});

test("REST refuses oversized PUT bodies before writing", async () => {
  const { client, requests } = memoryClient();
  await assert.rejects(client.applyOps("drawing", [{ op: "import_elements", elements: [{ type: "rectangle", custom: "x".repeat(10 * 1024 * 1024) }] }]), /10 MiB/);
  assert.equal(requests.filter(req => req.init?.method === "PUT").length, 0);
});

test("MCP initialization prominently offers corresponding source and REST limitations", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const client = new Client({ name: "source-offer-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./index.js", import.meta.url).pathname],
    env: { EXCALIDASH_URL: "https://draw.example.test", EXCALIDASH_API_KEY: token, EXCALIDASH_API_MODE: "rest", MCP_SOURCE_URL: "https://source.example.test/mcp-source.tar.gz" },
  });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /AGPL-3\.0/);
    assert.ok(instructions.includes("https://source.example.test/mcp-source.tar.gz"));
    assert.match(instructions, /snapshot restoration is unavailable/);
    assert.match(instructions, /VERSION_CONFLICT.*fresh read/);
    assert.match(instructions, /clientBatchId.*correlation only/);
  } finally {
    await client.close();
  }
});

test("element text sanitizer preserves whitespace and limits text without importing backend auth", async () => {
  const { sanitizeElementText } = await import("./security.js");
  assert.equal(sanitizeElementText(42), "");
  assert.equal(sanitizeElementText("a\u0000b\u0007\t\n\r\u007Fc"), "ab\t\n\rc");
  assert.equal(sanitizeElementText("x".repeat(5001)).length, 5000);
});


test("MCP initialization defaults to the public fork source URL", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const client = new Client({ name: "default-source-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./index.js", import.meta.url).pathname],
    env: { EXCALIDASH_URL: "https://draw.example.test", EXCALIDASH_API_KEY: token },
  });
  try {
    await client.connect(transport);
    assert.ok(client.getInstructions()?.includes("https://github.com/scv3lqq/excalidash-mcp"));
    assert.equal(client.getServerVersion()?.version, "0.4.0-library.1");
  } finally {
    await client.close();
  }
});

test("createServer accepts a source URL override and validates HTTPS", async () => {
  const { createServer } = await import("./index.js");
  const createConfiguredServer = createServer as (client: ExcaliDashClient, initialDrawingId?: string, sourceUrl?: string) => ReturnType<typeof createServer>;
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "direct-source-test", version: "1.0.0" });
  const server = createConfiguredServer(new ExcaliDashClient(settings()), undefined, "https://source.example.test/direct-source.tar.gz");
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.ok(client.getInstructions()?.includes("https://source.example.test/direct-source.tar.gz"));
  } finally {
    await client.close();
    await server.close();
  }
  for (const sourceUrl of ["http://source.example.test/source.tar.gz", "file:///source.tar.gz", "invalid-url"]) {
    assert.throws(() => createConfiguredServer(new ExcaliDashClient(settings()), undefined, sourceUrl), /MCP_SOURCE_URL must be an HTTPS URL/);
  }
});

test("REST getScene exposes the authoritative full snapshot through the authenticated bounded reader", async () => {
  const { client, stored, requests } = memoryClient();
  const snapshot = await client.getScene("drawing");
  assert.deepEqual(snapshot, { ...stored(), engine: "excalidraw" });
  assert.deepEqual(requests.map(request => request.init?.method), ["GET"]);
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
});

test("legacy getScene rejects clearly without HTTP", async () => {
  let calls = 0;
  const client = new ExcaliDashClient({ ...settings(), apiMode: undefined }, async () => { calls += 1; return Response.json(scene()); });
  await assert.rejects(client.getScene("drawing"), /REST mode/);
  assert.equal(calls, 0);
});
