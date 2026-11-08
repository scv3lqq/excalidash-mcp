import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("real stdio protocol lists ten tools, lists/searches/details and inserts selected/explicit drawing", async () => {
  const library = { items: Array.from({ length: 25 }, (_, i) => ({ id: `icon-${i}`, ...(i === 0 ? { name: "Synthetic service" } : {}), elements: [{ id: "shape", type: "rectangle", x: 0, y: 0, width: 100, height: 50, angle: 0, groupIds: ["source-group"], customData: { keep: true } }, { id: "text", type: "text", x: 5, y: 5, width: 80, height: 30, angle: 0, text: `Synthetic label ${i}` }] })) };
  const libraryBefore = JSON.stringify(library);
  const scenes = new Map(["selected", "explicit"].map(id => [id, { id, name: id, engine: "excalidraw", version: 2, elements: [{ id: "existing", type: "rectangle", x: 400, y: 400, width: 30, height: 30 }] as Record<string, unknown>[] }]));
  const writes: string[] = [];
  const api = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-protocol-key");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/library") { assert.equal(req.method, "GET"); res.end(JSON.stringify(library)); return; }
    const drawingId = req.url?.split("/").at(-1) ?? "";
    const scene = scenes.get(drawingId);
    if (!scene) { res.writeHead(404).end("{}"); return; }
    if (req.method === "PUT") {
      let input = "";
      req.setEncoding("utf8"); req.on("data", chunk => { input += chunk; });
      req.on("end", () => {
        const body = JSON.parse(input) as { elements: Record<string, unknown>[]; version: number };
        assert.deepEqual(Object.keys(body).sort(), ["elements", "version"]);
        assert.equal(body.version, scene.version);
        assert.deepEqual(body.elements.slice(0, scene.elements.length), scene.elements);
        scene.elements = body.elements; scene.version++;
        writes.push(drawingId); res.end(JSON.stringify(scene));
      });
    } else res.end(JSON.stringify(scene));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address(); assert.ok(address && typeof address === "object");
  const client = new Client({ name: "library-protocol-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname], env: { EXCALIDASH_URL: `http://127.0.0.1:${address.port}`, EXCALIDASH_API_KEY: "synthetic-protocol-key", EXCALIDASH_API_MODE: "rest" } });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    for (const name of ["list_library_items", "get_library_item", "insert_library_item"]) assert.ok(tools.some(t => t.name === name));
    for (const name of ["list_library_items", "get_library_item"]) assert.deepEqual(tools.find(tool => tool.name === name)?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(tools.find(tool => tool.name === "insert_library_item")?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const listed = await call("list_library_items");
    assert.equal(listed.isError, undefined);
    const text = listed.content[0]; assert.equal(text?.type, "text");
    const metadata = JSON.parse(text?.type === "text" ? text.text : "{}") as { items: { previewNumber: number }[]; totalCount: number; previewItems?: unknown; previewNote: string };
    assert.equal(metadata.totalCount, 25); assert.equal(metadata.items.length, 20); assert.equal(metadata.items[19]?.previewNumber, 20);
    assert.equal(metadata.previewItems, undefined); assert.match(metadata.previewNote, /approximate/i);
    assert.equal(listed.content[1]?.type, "image");
    if (listed.content[1]?.type === "image") { assert.equal(listed.content[1].mimeType, "image/png"); assert.equal(Buffer.from(listed.content[1].data, "base64").readUInt32BE(16), 640); }
    const page = await call("list_library_items", { limit: 10, offset: 20 });
    assert.match(page.content[0]?.type === "text" ? page.content[0].text : "", /icon-24/);
    const found = await call("list_library_items", { search: "SYNTHETIC SERVICE" });
    assert.match(found.content[0]?.type === "text" ? found.content[0].text : "", /"totalCount": 1/);
    const empty = await call("list_library_items", { search: "absent" }); assert.equal(empty.content.length, 1);
    const detail = await call("get_library_item", { itemId: "icon-0" });
    assert.match(detail.content[0]?.type === "text" ? detail.content[0].text : "", /"customData"/);
    assert.equal(detail.content[1]?.type, "image");
    assert.equal((await call("get_library_item", { itemId: "missing" })).isError, true);
    assert.equal((await call("insert_library_item", { itemId: "icon-0" })).isError, true);
    await call("select_drawing", { drawingId: "selected" });
    const first = await call("insert_library_item", { itemId: "icon-0", x: 100, y: 200 });
    assert.equal(first.isError, undefined);
    const afterFirst = structuredClone(scenes.get("selected")?.elements);
    assert.equal((await call("insert_library_item", { itemId: "icon-0" })).isError, undefined);
    assert.deepEqual(scenes.get("selected")?.elements.slice(0, afterFirst?.length), afterFirst);
    assert.equal((await call("insert_library_item", { itemId: "icon-0", drawingId: "explicit" })).isError, undefined);
    assert.deepEqual(writes, ["selected", "selected", "explicit"]);
    for (const coordinate of [1e7 + 1, "bad"]) assert.equal((await call("insert_library_item", { itemId: "icon-0", x: coordinate })).isError, true);
    assert.equal(JSON.stringify(library), libraryBefore);
  } finally { await client.close(); await new Promise<void>(resolve => api.close(() => resolve())); }
});
