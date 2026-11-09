import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createArrowElement, createShapeElement, createTextElement, type ExcalidrawElement } from "./agent/elementFactory.js";
import { startHttpServer } from "./http.js";

function syntheticScene(id: string) {
  const left = { ...createShapeElement("rectangle", -100, 0, 100, 60), id: "left", boundElements: [{ id: "manual-route", type: "arrow" }], customData: { synthetic: true } };
  const right = { ...createShapeElement("rectangle", 250, 0, 100, 60), id: "right", boundElements: [{ id: "manual-route", type: "arrow" }] };
  const route = { ...createArrowElement(0, 30, [[0, 0], [80, 100], [170, 100], [250, 0]], "arrow"), id: "manual-route",
    startBinding: { elementId: "left", focus: 0, gap: 0 }, endBinding: { elementId: "right", focus: 0, gap: 0 },
    boundElements: [{ id: "manual-label", type: "text" }] };
  const label = { ...createTextElement(110, 140, "Manual route label", "manual-route"), id: "manual-label", customData: { manualOffset: true } };
  return { id, name: `Synthetic ${id}`, engine: "excalidraw", version: 4,
    elements: [left, route, right, label] as ExcalidrawElement[], appState: { viewBackgroundColor: "#ffffff", zoom: { value: 0.7 }, synthetic: true },
    files: { unused: { synthetic: true } } };
}

type StoredScene = ReturnType<typeof syntheticScene>;

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// This is an in-memory synthetic backend, not an ExcaliDash deployment.
async function mockBackend() {
  const scenes = new Map(["alpha", "beta"].map(id => [id, syntheticScene(id)]));
  const library = { items: [{ id: "synthetic-library", name: "Synthetic service", elements: [
    { ...createShapeElement("rectangle", 0, 0, 80, 40), id: "library-shape", groupIds: ["library-group"], customData: { source: "synthetic" } },
    { ...createTextElement(5, 5, "Library label"), id: "library-text", groupIds: ["library-group"] },
  ] }] };
  const state = { gets: 0, puts: 0, conflictNext: false, loseNextResponse: false, authFailures: 0 };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-workflow-key") {
      state.authFailures++; res.writeHead(401).end(); return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/api/library") { res.end(JSON.stringify(library)); return; }
    const scene = scenes.get(req.url?.split("/").at(-1) ?? "");
    if (!scene) { res.writeHead(404).end("{}"); return; }
    if (req.method === "GET") { state.gets++; res.end(JSON.stringify(scene)); return; }
    if (req.method !== "PUT") { res.writeHead(405).end(); return; }
    let input = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { input += chunk; });
    req.on("end", () => {
      state.puts++;
      const body = JSON.parse(input) as { version: number; elements: StoredScene["elements"] };
      assert.deepEqual(Object.keys(body).sort(), ["elements", "version"]);
      if (state.conflictNext) { state.conflictNext = false; scene.version++; }
      if (body.version !== scene.version) { res.writeHead(409).end(JSON.stringify({ error: "VERSION_CONFLICT" })); return; }
      scene.elements = body.elements;
      scene.version++;
      if (state.loseNextResponse) { state.loseNextResponse = false; req.socket.destroy(); return; }
      res.end(JSON.stringify(scene));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { scenes, library, state, origin: `http://127.0.0.1:${address.port}`, close: () => close(server) };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function json<T>(result: ToolResult): T {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first?.type === "text" ? first.text : "") as T;
}

async function exercise(t: TestContext, protocol: "stdio" | "http") {
  const api = await mockBackend();
  const checkpoints = await mkdtemp(join(tmpdir(), "excalidash-workflow-"));
  const client = new Client({ name: `synthetic-workflow-${protocol}`, version: "1.0.0" });
  const env = { EXCALIDASH_URL: api.origin, EXCALIDASH_API_KEY: "synthetic-workflow-key", EXCALIDASH_API_MODE: "rest",
    ...(process.env.EXCALIDASH_RENDER_BROWSER ? { EXCALIDASH_RENDER_BROWSER: process.env.EXCALIDASH_RENDER_BROWSER } : {}) };
  let http: Server | undefined;
  let peer: Client | undefined;
  let checkpointNumber = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const checkpoint = async (result: ToolResult) => {
    // Persist the outcome before assertions can interrupt this synthetic workflow.
    const saved = structuredClone({ result, scenes: [...api.scenes], state: api.state });
    await writeFile(join(checkpoints, `${++checkpointNumber}.json`), JSON.stringify(saved), { mode: 0o600 });
    return saved;
  };
  try {
    assert.equal((await fetch(`${api.origin}/api/drawings/alpha`)).status, 401);
    if (protocol === "stdio") {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [new URL("./index.js", import.meta.url).pathname], env }));
    } else {
      http = await startHttpServer({ ...env, MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0" });
      const address = http.address(); assert.ok(address && typeof address === "object");
      const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      peer = new Client({ name: "isolated-synthetic-peer", version: "1.0.0" });
      await peer.connect(new StreamableHTTPClientTransport(endpoint));
      await peer.callTool({ name: "select_drawing", arguments: { drawingId: "beta" } });
    }
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 13);
    for (const name of ["get_drawing_elements", "validate_drawing", "render_drawing"]) assert.ok(names.includes(name), `${name} is registered`);
    assert.equal((await call("select_drawing", { drawingId: "alpha" })).isError, undefined);
    if (peer) assert.equal(json<{ selectedDrawingId: string }>(await peer.callTool({ name: "get_selected_drawing", arguments: {} })).selectedDrawingId, "beta");
    const betaBefore = structuredClone(api.scenes.get("beta"));
    const original = structuredClone(api.scenes.get("alpha")!);
    const read = json<{ version: number; elements: Record<string, unknown>[]; totalCount: number }>(await call("get_drawing_elements", { mode: "detailed" }));
    assert.equal(read.version, 4); assert.deepEqual(read.elements.map(el => el.id), original.elements.map(el => el.id));
    assert.equal(read.elements[0]?.customData !== undefined, true);

    const first = await call("apply_drawing_ops", { expectedRevision: read.version, clientBatchId: "synthetic-style", ops: [{ op: "set_style", id: "left", style: { strokeColor: "#ff0000" } }] });
    const firstSaved = await checkpoint(first);
    assert.equal(first.isError, undefined);
    const firstMeta = json<{ version: number; modifiedIds: string[]; createdIds: string[] }>(first);
    assert.equal(firstMeta.version, 5); assert.deepEqual(firstMeta.modifiedIds, ["left"]); assert.deepEqual(firstMeta.createdIds, []);
    const afterStyle = firstSaved.scenes.find(([id]) => id === "alpha")![1];
    assert.deepEqual(afterStyle.elements.slice(1), original.elements.slice(1));
    assert.deepEqual(afterStyle.appState, original.appState); assert.deepEqual(afterStyle.files, original.files);

    const getsBeforeRender = api.state.gets;
    const rendered = await call("render_drawing", { elementIds: ["left"], padding: 10 });
    assert.equal(rendered.isError, undefined);
    const renderMeta = json<{ version: number; renderer: string; width: number; height: number }>(rendered);
    assert.equal(renderMeta.version, firstMeta.version);
    assert.equal(renderMeta.renderer, "@excalidraw/excalidraw@0.18.1");
    assert.equal(api.state.gets - getsBeforeRender, 1, "render uses one authoritative snapshot");
    const png = rendered.content.find(item => item.type === "image"); assert.ok(png?.type === "image");
    assert.equal(png.mimeType, "image/png");
    const bytes = Buffer.from(png.data, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), renderMeta.width); assert.equal(bytes.readUInt32BE(20), renderMeta.height);
    assert.ok(bytes.length > 200);
    const validation = json<{ version: number; issues: unknown[]; skippedChecks: unknown[] }>(await call("validate_drawing"));
    assert.equal(validation.version, firstMeta.version); assert.ok(Array.isArray(validation.issues)); assert.ok(validation.skippedChecks.length > 0);

    const refined = await call("apply_drawing_ops", { expectedRevision: firstMeta.version, ops: [{ op: "move", id: "right", dx: 30, dy: 0 }] });
    await checkpoint(refined);
    assert.equal(refined.isError, undefined);
    const current = api.scenes.get("alpha")!;
    const rightBefore = afterStyle.elements.find(el => el.id === "right")!;
    const rightAfter = current.elements.find(el => el.id === "right")!;
    assert.equal(rightAfter.x, rightBefore.x + 30);
    assert.equal(rightAfter.y, rightBefore.y);
    const refineDependencies = new Set(["right", "manual-route", "manual-label"]);
    assert.deepEqual(
      current.elements.filter(el => !refineDependencies.has(el.id)),
      afterStyle.elements.filter(el => !refineDependencies.has(el.id)),
    );
    const changedRoute = current.elements.find(el => el.id === "manual-route")!;
    assert.deepEqual(changedRoute.points.slice(1, -1), original.elements[1]!.points.slice(1, -1));
    assert.deepEqual(current.elements.map(el => el.id), original.elements.map(el => el.id));

    const putsBeforeStale = api.state.puts;
    const stale = await call("apply_drawing_ops", { expectedRevision: 4, ops: [{ op: "delete", id: "left" }] });
    await checkpoint(stale);
    assert.equal(stale.isError, true); assert.equal(api.state.puts, putsBeforeStale);
    assert.equal((stale.structuredContent as { error: { code: string; actualRevision: number } }).error.code, "VERSION_CONFLICT");
    assert.equal((stale.structuredContent as { error: { actualRevision: number } }).error.actualRevision, current.version);

    const beforeInvalid = structuredClone(current);
    const invalid = await call("apply_drawing_ops", { expectedRevision: current.version, ops: [
      { op: "add_shape", shape: "rectangle", x: 500, y: 200 }, { op: "move", id: "missing", dx: 1 },
    ] });
    await checkpoint(invalid);
    assert.equal(invalid.isError, true); assert.equal(api.state.puts, putsBeforeStale); assert.deepEqual(current, beforeInvalid);

    api.state.conflictNext = true;
    const cas = await call("apply_drawing_ops", { expectedRevision: current.version, ops: [{ op: "set_text", id: "manual-label", text: "must not commit" }] });
    await checkpoint(cas);
    assert.equal(cas.isError, true); assert.equal(api.state.puts, putsBeforeStale + 1);
    assert.equal((cas.structuredContent as { error: { code: string } }).error.code, "VERSION_CONFLICT");
    assert.deepEqual(current.elements, beforeInvalid.elements);

    const libraryBefore = structuredClone(api.library);
    const beforeLibrary = structuredClone(current);
    const inserted = await call("insert_library_item", { itemId: "synthetic-library", x: 500, y: 200 });
    await checkpoint(inserted);
    assert.equal(inserted.isError, undefined);
    assert.deepEqual(current.elements.slice(0, beforeLibrary.elements.length), beforeLibrary.elements);
    assert.deepEqual(current.appState, original.appState); assert.deepEqual(current.files, original.files);
    assert.deepEqual(api.library, libraryBefore);
    assert.equal(current.elements.length, beforeLibrary.elements.length + 2);

    api.state.loseNextResponse = true;
    const beforeUncertain = api.state.puts;
    const uncertain = await call("apply_drawing_ops", { expectedRevision: current.version, clientBatchId: "uncertain-once", ops: [{ op: "add_shape", shape: "ellipse", x: 700, y: 200, label: "Committed once" }] });
    const uncertainSaved = await checkpoint(uncertain);
    assert.equal(uncertain.isError, true); assert.equal(uncertainSaved.state.puts, beforeUncertain + 1);
    // Recovery reads the saved state; it never repeats the create batch.
    const recovered = json<{ version: number; elements: Record<string, unknown>[] }>(await call("get_drawing_elements", { mode: "detailed" }));
    assert.equal(recovered.version, current.version);
    assert.equal(recovered.elements.filter(el => el.originalText === "Committed once").length, 1);
    assert.equal(api.state.puts, beforeUncertain + 1);
    assert.deepEqual(api.scenes.get("beta"), betaBefore);
    assert.equal(api.state.authFailures, 1, "only the deliberate unauthenticated probe is rejected");
    t.diagnostic(`${protocol}: ${checkpointNumber} mutation outcomes checkpointed before assertions; synthetic backend only`);
  } finally {
    await peer?.close(); await client.close();
    if (http) await close(http);
    await api.close();
    await rm(checkpoints, { recursive: true, force: true });
  }
}

for (const protocol of ["stdio", "http"] as const) {
  test(`${protocol}: saved synthetic read-plan-apply-render-validate-refine and safe recovery`, { timeout: 90_000 }, async t => exercise(t, protocol));
}
