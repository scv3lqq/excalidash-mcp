import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { renderLibraryGallery, renderLibraryItem } from "./library-preview.js";
import type { LibraryItem } from "./library.js";

const item = (extra: Record<string, unknown> = {}): LibraryItem => ({ id: "synthetic-icon", elements: [
  { id: "box", type: "rectangle", x: -120, y: -70, width: 90, height: 50, angle: 0.5, strokeColor: "#334155", backgroundColor: "#dbeafe", ...extra },
  { id: "edge", type: "arrow", x: -30, y: -45, width: 100, height: 0, angle: 0, points: [[-15, -20], [40, 40], [100, -10]], strokeColor: "#334155" },
] });
const assertPng = (png: Buffer, width: number, height: number) => {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  assert.ok(png.length <= 1024 * 1024);
};

function pixels(png: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4, output = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? output[y * stride + x - 4]! : 0;
      const b = y ? output[(y - 1) * stride + x]! : 0;
      const c = y && x >= 4 ? output[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      assert.notEqual(predictor, undefined);
      output[y * stride + x] = (raw[y * (stride + 1) + x + 1]! + predictor!) & 255;
    }
  }
  return output;
}

test("synthetic gallery/detail PNGs have fixed dimensions, capped size and rotated/point extents", () => {
  const png = renderLibraryGallery(Array.from({ length: 20 }, (_, i) => ({ ...item(), id: String(i) })));
  assertPng(png, 640, 800);
  assertPng(renderLibraryItem(item()), 512, 512);
  assertPng(renderLibraryItem(item({ width: 0, height: 0 })), 512, 512);
  assertPng(renderLibraryItem({ id: "empty", elements: [] }), 512, 512);
  assertPng(renderLibraryItem({ id: "deleted", elements: [{ id: "dead", type: "rectangle", isDeleted: true }] }), 512, 512);
});

test("text is escaped as diagram data and cannot inject SVG primitives", () => {
  const png = renderLibraryItem({ id: "untrusted-text", elements: [{ id: "text", type: "text", x: 0, y: 0, width: 200, height: 50, angle: 0, fontSize: 16, text: "</text><rect x='-100000' y='-100000' width='200000' height='200000' fill='#ff0000'/><text>" }] });
  assertPng(png, 512, 512);
  const rgba = pixels(png);
  let red = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 240 && rgba[i + 1]! < 10 && rgba[i + 2]! < 10) red++;
  assert.equal(red, 0);
});

test("unsafe colors, NaN, element/point/SVG budgets are rejected", () => {
  for (const color of ["url(https://asset.example.test/icon.svg)", "red\"/><image href='https://asset.example.test/evil' />", "var(--untrusted)"]) assert.throws(() => renderLibraryItem(item({ strokeColor: color })), /color/i);
  assert.throws(() => renderLibraryItem(item({ x: NaN })), /coordinate|geometry/i);
  assert.throws(() => renderLibraryGallery(Array.from({ length: 21 }, (_, i) => ({ ...item(), id: String(i) }))), /20|limit/i);
  assert.throws(() => renderLibraryItem({ id: "big", elements: Array.from({ length: 501 }, (_, i) => ({ ...item().elements[0]!, id: String(i) })) }), /500|limit/i);
  assert.throws(() => renderLibraryItem({ id: "points", elements: [{ ...item().elements[1]!, points: Array.from({ length: 20001 }, () => [0, 0]) }] }), /point|20000/i);
  assert.throws(() => renderLibraryItem({ id: "svg-cap", elements: Array.from({ length: 500 }, (_, i) => ({ id: String(i), type: "text", x: 0, y: i, width: 1, height: 1, text: "a".repeat(10000) })) }), /SVG|2 MiB/i);
});

test("image/file references render a safe placeholder without fetching resources", () => {
  const mocked = test.mock.method(globalThis, "fetch", async () => { throw new Error("Network must not be used"); });
  try {
    assertPng(renderLibraryItem({ id: "asset", elements: [{ id: "image", type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "https://asset.example.test/image.svg", customData: { svg: "<svg><image href='https://asset.example.test/image'/></svg>" } }] }), 512, 512);
    assert.equal(mocked.mock.callCount(), 0);
  } finally { mocked.mock.restore(); }
});
