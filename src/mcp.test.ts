import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const listen = async (): Promise<{
  origin: string;
  close: () => Promise<void>;
}> => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    if (
      req.method === "GET" &&
      req.url === "/api/drawings?limit=50&offset=0"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        drawings: [{
          id: "drawing-1",
          name: "Architecture",
          engine: "excalidraw",
          collectionId: null,
          version: 6,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
        }],
        totalCount: 1,
        limit: 50,
        offset: 0,
      }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/drawings/drawing-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "drawing-1",
        name: "Architecture",
        engine: "excalidraw",
        collectionId: null,
        version: 6,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }));
      return;
    }


    if (req.method === "POST" && req.url === "/api/drawings") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body) as {
          name: string;
          engine: string;
          elements: unknown[];
        };
        assert.deepEqual(payload, {
          name: "New diagram",
          engine: "excalidraw",
          elements: [],
          appState: {},
          files: {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "drawing-2",
          name: payload.name,
          engine: payload.engine,
          collectionId: null,
          version: 1,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
        }));
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/drawings/drawing-1/summary") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Drawing: MCP integration test");
      return;
    }

    if (req.method === "POST" && req.url === "/api/drawings/drawing-1/ops") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body) as { ops: unknown[] };
        assert.equal(payload.ops.length, 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: 7, results: [{ ok: true }] }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

test("stdio MCP server lists and executes ExcaliDash tools end to end", async () => {
  const api = await listen();
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./index.js", import.meta.url).pathname],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] =>
          entry[1] !== undefined,
        ),
      ),
      EXCALIDASH_URL: api.origin,
      EXCALIDASH_API_KEY: "test-token",
    },
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(({ name }) => name).sort(),
      [
        "apply_drawing_ops",
        "create_drawing",
        "get_drawing_elements",
        "get_drawing_summary",
        "get_library_item",
        "get_selected_drawing",
        "insert_library_item",
        "inspect_drawing_element",
        "list_drawings",
        "list_library_items",
        "render_drawing",
        "select_drawing",
        "validate_drawing",
      ],
    );

    const listed = await client.callTool({
      name: "list_drawings",
      arguments: {},
    });
    assert.equal(listed.isError, undefined);
    assert.match(
      listed.content[0]?.type === "text" ? listed.content[0].text : "",
      /"id": "drawing-1"/,
    );

    const selected = await client.callTool({
      name: "select_drawing",
      arguments: { drawingId: "drawing-1" },
    });
    assert.equal(selected.isError, undefined);
    assert.match(
      selected.content[0]?.type === "text" ? selected.content[0].text : "",
      /"selectedDrawingId": "drawing-1"/,
    );

    const summary = await client.callTool({
      name: "get_drawing_summary",
      arguments: {},
    });
    assert.equal(summary.isError, undefined);
    assert.equal(summary.content[0]?.type, "text");
    assert.equal(
      summary.content[0]?.type === "text" ? summary.content[0].text : undefined,
      "Drawing: MCP integration test",
    );

    const applied = await client.callTool({
      name: "apply_drawing_ops",
      arguments: {
        ops: [{
          op: "add_shape",
          shape: "rectangle",
          x: 10,
          y: 20,
          label: "Created through MCP",
        }],
      },
    });
    assert.equal(applied.isError, undefined);
    assert.match(
      applied.content[0]?.type === "text" ? applied.content[0].text : "",
      /"version": 7/,
    );
    const created = await client.callTool({
      name: "create_drawing",
      arguments: { name: "New diagram" },
    });
    assert.equal(created.isError, undefined);
    assert.match(
      created.content[0]?.type === "text" ? created.content[0].text : "",
      /"id": "drawing-2"/,
    );

    const current = await client.callTool({
      name: "get_selected_drawing",
      arguments: {},
    });
    assert.match(
      current.content[0]?.type === "text" ? current.content[0].text : "",
      /"selectedDrawingId":"drawing-2"/,
    );
  } finally {
    await client.close();
    await api.close();
  }
});

test("analysis tools read the same REST scene and stale MCP mutations retain structured conflict details", async () => {
  const { createServer: createMcpServer } = await import("./index.js");
  const { ExcaliDashClient } = await import("./excalidash.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let gets = 0;
  let puts = 0;
  const drawing = { id: "selected", version: 9, elements: [
    { id: "shape", type: "rectangle", x: -50, y: 20, width: 100, height: 80, customData: { retained: true } },
  ], appState: { viewBackgroundColor: "#fff" }, files: {} };
  const apiClient = new ExcaliDashClient({ url: "https://draw.example.test", token: "synthetic-token", apiMode: "rest" }, async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
    if (init?.method === "PUT") puts += 1;
    else gets += 1;
    return Response.json(drawing);
  });
  const server = createMcpServer(apiClient, "selected");
  const client = new Client({ name: "analysis-contract-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const name of ["get_drawing_elements", "validate_drawing", "render_drawing"]) assert.deepEqual(listed.tools.find(tool => tool.name === name)?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const inspected = await client.callTool({ name: "get_drawing_elements", arguments: { mode: "detailed", ids: ["shape"] } });
    assert.equal(inspected.isError, undefined);
    assert.equal(inspected.content[0]?.type, "text");
    const inspection = JSON.parse(inspected.content[0]?.type === "text" ? inspected.content[0].text : "{}") as { version: number; elements: { id: string; customData?: unknown }[] };
    assert.equal(inspection.version, 9);
    assert.deepEqual(inspection.elements[0]?.customData, { retained: true });
    const validated = await client.callTool({ name: "validate_drawing", arguments: {} });
    assert.equal(validated.isError, undefined);
    const validation = JSON.parse(validated.content[0]?.type === "text" ? validated.content[0].text : "{}") as { version: number; skippedChecks: unknown[] };
    assert.equal(validation.version, 9);
    assert.ok(validation.skippedChecks.length > 0);
    const stale = await client.callTool({ name: "apply_drawing_ops", arguments: { ops: [{ op: "move", id: "shape", dx: 10 }], expectedRevision: 8 } });
    assert.equal(stale.isError, true);
    assert.deepEqual(stale.structuredContent, { error: { code: "VERSION_CONFLICT", expectedRevision: 8, actualRevision: 9 } });
    assert.match(stale.content[0]?.type === "text" ? stale.content[0].text : "", /fresh read/);
    const stalePage = await client.callTool({ name: "get_drawing_elements", arguments: { offset: 1, expectedRevision: 8 } });
    assert.equal(stalePage.isError, true);
    assert.deepEqual(stalePage.structuredContent, { error: { code: "VERSION_CONFLICT", expectedRevision: 8, actualRevision: 9 } });
    assert.equal(gets, 4);
    assert.equal(puts, 0);
    const invalidRender = await client.callTool({ name: "render_drawing", arguments: { region: { x: 0, y: 0, width: 10, height: 10 }, elementIds: ["shape"] } });
    assert.equal(invalidRender.isError, true);
    assert.match(invalidRender.content[0]?.type === "text" ? invalidRender.content[0].text : "", /mutually exclusive/);
    assert.equal(gets, 4);
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await client.callTool({ name: "apply_drawing_ops", arguments: { ops: [{ op: "move", id: "shape", dx: 10 }], expectedRevision } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(gets, 4);
    assert.equal(puts, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
