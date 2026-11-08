import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { libraryPointCount, parseLibrary, type LibraryItem } from "./library.js";

const FONT_PATH = fileURLToPath(new URL("../assets/DejaVuSans.ttf", import.meta.url));
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_PNG_BYTES = 1024 * 1024;
type Element = Record<string, unknown>;
type Box = { x: number; y: number; width: number; height: number };

const escapeText = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
const number = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error("Invalid preview geometry number");
  return String(value);
};
const scalar = (element: Element, key: string, fallback: number): number => element[key] === undefined ? fallback : element[key] as number;

function color(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("Invalid preview color");
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) || /^(?:transparent|none|black|white|red|green|blue|yellow|orange|purple|gray|grey|pink|brown|cyan|magenta)$/i.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i.exec(value);
  if (rgb && rgb.slice(1, 4).every(channel => Number(channel) <= 255) && (value.toLowerCase().startsWith("rgba") === (rgb[4] !== undefined))) return value;
  throw new Error("Invalid preview color");
}

function bounds(elements: Element[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const element of elements) {
    const x = scalar(element, "x", 0), y = scalar(element, "y", 0);
    const width = scalar(element, "width", 0), height = scalar(element, "height", 0);
    const angle = scalar(element, "angle", 0) % (Math.PI * 2);
    const cx = x + width / 2, cy = y + height / 2;
    const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
    if (Array.isArray(element.points)) for (const point of element.points as [number, number][]) points.push([x + point[0], y + point[1]]);
    const pad = Math.max(1, scalar(element, "strokeWidth", 1)) / 2 + (element.type === "arrow" ? 12 : 0);
    for (const [px, py] of points as [number, number][]) {
      const rx = cx + (px - cx) * Math.cos(angle) - (py - cy) * Math.sin(angle);
      const ry = cy + (px - cx) * Math.sin(angle) + (py - cy) * Math.cos(angle);
      minX = Math.min(minX, rx - pad); minY = Math.min(minY, ry - pad);
      maxX = Math.max(maxX, rx + pad); maxY = Math.max(maxY, ry + pad);
    }
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function primitive(element: Element): string {
  const x = scalar(element, "x", 0), y = scalar(element, "y", 0), width = scalar(element, "width", 0), height = scalar(element, "height", 0);
  const angle = (scalar(element, "angle", 0) % (Math.PI * 2)) * 180 / Math.PI;
  const stroke = color(element.strokeColor, "#334155");
  const fill = color(element.backgroundColor, "transparent");
  const opacity = scalar(element, "opacity", 100);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("Invalid preview opacity number");
  const attrs = `stroke="${stroke}" fill="${fill}" stroke-width="${number(scalar(element, "strokeWidth", 1))}" opacity="${number(opacity / 100)}"`;
  const lineAttrs = attrs.replace(`fill="${fill}"`, 'fill="none"');
  const transform = `transform="rotate(${number(angle)} ${number(x + width / 2)} ${number(y + height / 2)})"`;
  let body: string;
  switch (element.type) {
    case "rectangle": case "frame": case "magicframe":
      body = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" ${attrs}/>`; break;
    case "ellipse":
      body = `<ellipse cx="${number(x + width / 2)}" cy="${number(y + height / 2)}" rx="${number(width / 2)}" ry="${number(height / 2)}" ${attrs}/>`; break;
    case "diamond":
      body = `<polygon points="${number(x + width / 2)},${number(y)} ${number(x + width)},${number(y + height / 2)} ${number(x + width / 2)},${number(y + height)} ${number(x)},${number(y + height / 2)}" ${attrs}/>`; break;
    case "line": case "arrow": case "freedraw": {
      const points = Array.isArray(element.points) && element.points.length ? element.points as [number, number][] : [[0, 0], [width, height]];
      const encoded = points.map(point => `${number(x + point[0]!)},${number(y + point[1]!)}`).join(" ");
      body = `<polyline points="${encoded}" ${lineAttrs}/>`;
      if (element.type === "arrow" && points.length > 1) {
        const end = points.at(-1)!, previous = points.at(-2)!;
        const theta = Math.atan2(end[1]! - previous[1]!, end[0]! - previous[0]!);
        const length = Math.min(12, Math.max(4, Math.hypot(end[0]! - previous[0]!, end[1]! - previous[1]!) / 3));
        const wing = (direction: number) => `${number(x + end[0]! - length * Math.cos(theta + direction))},${number(y + end[1]! - length * Math.sin(theta + direction))}`;
        body += `<polyline points="${wing(-0.5)} ${number(x + end[0]!)},${number(y + end[1]!)} ${wing(0.5)}" ${lineAttrs}/>`;
      }
      break;
    }
    case "text": {
      const fontSize = Math.max(1, scalar(element, "fontSize", 20));
      const lines = (typeof element.text === "string" ? element.text : "").split("\n");
      const lineHeight = Math.max(0.1, scalar(element, "lineHeight", 1.25));
      body = `<text x="${number(x)}" y="${number(y + fontSize)}" font-size="${number(fontSize)}" fill="${stroke}" opacity="${number(opacity / 100)}">${lines.map((line, i) => `<tspan x="${number(x)}" dy="${i === 0 ? "0" : number(fontSize * lineHeight)}">${escapeText(line)}</tspan>`).join("")}</text>`;
      break;
    }
    default:
      body = `<rect x="${number(x)}" y="${number(y)}" width="${number(Math.max(1, width))}" height="${number(Math.max(1, height))}" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="4 3"/>`;
  }
  return `<g ${transform}>${body}</g>`;
}

function* drawing(item: LibraryItem, viewport: Box, index: number): Generator<string> {
  const live = item.elements.filter(element => !element.isDeleted);
  const clip = `preview-clip-${index}`;
  yield `<defs><clipPath id="${clip}"><rect x="${viewport.x}" y="${viewport.y}" width="${viewport.width}" height="${viewport.height}"/></clipPath></defs><g clip-path="url(#${clip})">`;
  if (!live.length) {
    yield `<text x="${number(viewport.x + viewport.width / 2)}" y="${number(viewport.y + viewport.height / 2)}" text-anchor="middle" font-size="14" fill="#64748b">Empty item</text></g>`;
    return;
  }
  const box = bounds(live);
  const scale = Math.min(viewport.width / box.width, viewport.height / box.height);
  const tx = viewport.x + (viewport.width - box.width * scale) / 2 - box.x * scale;
  const ty = viewport.y + (viewport.height - box.height * scale) / 2 - box.y * scale;
  yield `<g transform="translate(${number(tx)} ${number(ty)}) scale(${number(scale)})">`;
  for (const element of live) yield primitive(element);
  yield "</g></g>";
}

function render(items: LibraryItem[], gallery: boolean): Buffer {
  if (items.length > 20) throw new Error("Preview exceeds 20 item limit");
  parseLibrary({ items });
  libraryPointCount(items);
  const width = gallery ? 640 : 512, height = gallery ? 800 : 512;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans"><rect width="100%" height="100%" fill="#ffffff"/><text x="16" y="21" font-size="13" fill="#334155">Approximate preview; inserted geometry is exact.</text>`];
  let bytes = Buffer.byteLength(parts[0]!, "utf8");
  const append = (part: string) => {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > MAX_SVG_BYTES) throw new Error("Preview SVG exceeds 2 MiB limit");
    parts.push(part);
  };
  if (!items.length) append('<text x="320" y="400" text-anchor="middle" font-size="18" fill="#64748b">Empty library</text>');
  items.forEach((item, index) => {
    const x = gallery ? (index % 4) * 160 : 0, y = gallery ? 40 + Math.floor(index / 4) * 150 : 40;
    const viewport = gallery ? { x: x + 10, y: y + 8, width: 140, height: 112 } : { x: 24, y: 60, width: 464, height: 400 };
    for (const part of drawing(item, viewport, index)) append(part);
    const label = `${index + 1}: ${item.id}`.slice(0, gallery ? 23 : 58);
    append(`<text x="${x + 10}" y="${gallery ? y + 140 : 492}" font-size="${gallery ? 10 : 13}" fill="#334155">${escapeText(label)}</text>`);
  });
  append("</svg>");
  const renderer = new Resvg(parts.join(""), { font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } });
  if (renderer.imagesToResolve().length) throw new Error("Preview contains unsupported image resources");
  const png = renderer.render().asPng();
  if (png.length > MAX_PNG_BYTES) throw new Error("Preview PNG exceeds 1 MiB limit");
  return png;
}

export const renderLibraryGallery = (items: LibraryItem[]): Buffer => render(items, true);
export const renderLibraryItem = (item: LibraryItem): Buffer => render([item], false);
