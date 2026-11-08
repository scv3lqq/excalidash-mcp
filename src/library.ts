import crypto from "node:crypto";
import type { ExcalidrawElement } from "./agent/elementFactory.js";

export type LibraryItem = Record<string, unknown> & {
  id: string;
  elements: Record<string, unknown>[];
  name?: string;
  status?: string;
  created?: number;
};
export type LibraryListOptions = { search?: string; limit?: number; offset?: number };
export type InsertLibraryOptions = { x?: number; y?: number };
export type LibraryPage = {
  items: { id: string; name?: string; text: string; elementCount: number; types: string[]; previewNumber: number }[];
  totalCount: number;
  limit: number;
  offset: number;
};

const MAX_COORDINATE = 1e7;
const MAX_POINTS = 20_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function invalid(detail: string): never { throw new Error(`Invalid library: ${detail}`); }

function coordinate(value: unknown, field: string, nonnegative = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE || (nonnegative && value < 0)) invalid(`invalid ${field} coordinate/geometry`);
}

function validateReferences(element: Record<string, unknown>): void {
  for (const key of ["containerId", "frameId"]) {
    if (element[key] !== undefined && element[key] !== null && !validId(element[key])) invalid(`malformed ${key} reference`);
  }
  if (element.groupIds !== undefined && (!Array.isArray(element.groupIds) || element.groupIds.some(id => !validId(id)))) invalid("malformed group reference");
  if (element.boundElements !== undefined && element.boundElements !== null) {
    if (!Array.isArray(element.boundElements) || element.boundElements.some(ref => !record(ref) || !validId(ref.id) || (ref.type !== undefined && typeof ref.type !== "string"))) invalid("malformed boundElements reference");
  }
  for (const key of ["startBinding", "endBinding"]) {
    const binding = element[key];
    if (binding === undefined || binding === null) continue;
    if (!record(binding) || !validId(binding.elementId)) invalid(`malformed ${key} reference`);
    for (const numeric of ["focus", "gap"]) {
      if (binding[numeric] !== undefined) coordinate(binding[numeric], numeric);
    }
    if (binding.fixedPoint !== undefined && binding.fixedPoint !== null) validatePoint(binding.fixedPoint);
  }
}

function validatePoint(point: unknown): void {
  if (!Array.isArray(point) || point.length !== 2) invalid("malformed point geometry");
  coordinate(point[0], "point x");
  coordinate(point[1], "point y");
}

function validateElement(element: unknown): asserts element is Record<string, unknown> {
  if (!record(element) || !validId(element.id) || !validId(element.type)) invalid("malformed element");
  if (element.isDeleted !== undefined && typeof element.isDeleted !== "boolean") invalid("malformed element deletion flag");
  for (const field of ["x", "y", "width", "height"]) {
    if (!element.isDeleted || element[field] !== undefined) coordinate(element[field], field, field === "width" || field === "height");
  }
  if (element.angle !== undefined && (typeof element.angle !== "number" || !Number.isFinite(element.angle))) invalid("invalid angle geometry");
  for (const field of ["fontSize", "strokeWidth", "lineHeight"]) {
    if (element[field] !== undefined) coordinate(element[field], field, true);
  }
  for (const key of ["text", "originalText"]) {
    if (element[key] !== undefined && (typeof element[key] !== "string" || element[key].length > 10_000)) invalid("element text exceeds 10000 character limit or is malformed");
  }
  if (element.points !== undefined) {
    if (!Array.isArray(element.points) || element.points.length > MAX_POINTS) invalid("element point limit 20000 exceeded or malformed");
    element.points.forEach(validatePoint);
  }
  validateReferences(element);
}

export function libraryPointCount(items: LibraryItem[]): number {
  let count = 0;
  for (const item of items) for (const element of item.elements) {
    if (Array.isArray(element.points)) count += element.points.length;
    if (count > MAX_POINTS) invalid("returned page exceeds 20000 point limit");
  }
  return count;
}

export function parseLibrary(value: unknown): LibraryItem[] {
  if (!record(value) || !Array.isArray(value.items)) invalid("expected an items array");
  if (value.items.length > 2000) invalid("2000 item limit exceeded");
  const itemIds = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !validId(item.id) || !Array.isArray(item.elements)) invalid("malformed library item");
    if (itemIds.has(item.id)) invalid("duplicate item ID");
    itemIds.add(item.id);
    if (item.name !== undefined && typeof item.name !== "string") invalid("malformed item name");
    if (item.status !== undefined && typeof item.status !== "string") invalid("malformed item status");
    if (item.created !== undefined && (typeof item.created !== "number" || !Number.isFinite(item.created))) invalid("malformed item created timestamp");
    if (item.elements.length > 500) invalid("500 element limit exceeded");
    const elementIds = new Set<string>();
    for (const element of item.elements) {
      validateElement(element);
      if (elementIds.has(element.id as string)) invalid("duplicate element ID");
      elementIds.add(element.id as string);
    }
    libraryPointCount([item as LibraryItem]);
  }
  return value.items as LibraryItem[];
}

export function listLibraryItems(items: LibraryItem[], options: LibraryListOptions = {}): LibraryPage {
  const { limit = 20, offset = 0, search = "" } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid("limit must be between 1 and 20");
  if (!Number.isSafeInteger(offset) || offset < 0) invalid("offset must be a safe nonnegative integer");
  if (typeof search !== "string" || search.length > 200) invalid("search exceeds 200 character limit");
  const query = search.toLowerCase();
  const metadata = items.map(item => {
    const live = item.elements.filter(element => !element.isDeleted);
    const text = live.filter(element => typeof element.text === "string").map(element => element.text as string).join("\n");
    return { item, id: item.id, ...(item.name !== undefined ? { name: item.name } : {}), text, elementCount: live.length, types: [...new Set(live.map(element => element.type as string))] };
  }).filter(item => [item.id, item.name ?? "", item.text].some(value => value.toLowerCase().includes(query)));
  const page = metadata.slice(offset, offset + limit);
  libraryPointCount(page.map(entry => entry.item));
  return {
    items: page.map(({ item: _item, ...entry }, index) => ({ ...entry, previewNumber: index + 1 })),
    totalCount: metadata.length,
    limit,
    offset,
  };
}

export function validateLibraryDrawing(value: unknown): { elements: ExcalidrawElement[]; version: number } {
  if (!record(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 0) throw new Error("Drawing response requires an integer version");
  if (value.engine !== undefined && value.engine !== "excalidraw") throw new Error("Drawing must use the excalidraw engine");
  if (!Array.isArray(value.elements) || value.elements.length > 10_000) throw new Error("Drawing scene requires at most 10000 elements");
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!record(element) || !validId(element.id) || !validId(element.type) || ids.has(element.id)) throw new Error("Drawing response contains invalid or duplicate element IDs");
    ids.add(element.id);
    if (element.groupIds !== undefined && (!Array.isArray(element.groupIds) || element.groupIds.some(id => !validId(id)))) throw new Error("Drawing response contains invalid group IDs");
  }
  return { elements: value.elements as ExcalidrawElement[], version: value.version as number };
}

export function assertLibraryItemInsertable(item: LibraryItem): Record<string, unknown>[] {
  parseLibrary({ items: [item] });
  const live = item.elements.filter(element => !element.isDeleted);
  if (!live.length) throw new Error("Library item has no live elements");
  if (live.some(element => element.type === "image" || element.fileId !== undefined)) throw new Error("Library image/fileId insertion is unsupported");
  return live;
}

export function validateInsertOptions(options: InsertLibraryOptions): void {
  for (const axis of ["x", "y"] as const) if (options[axis] !== undefined) coordinate(options[axis], axis);
}

function freshId(used: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = crypto.randomUUID();
    if (!used.has(id)) { used.add(id); return id; }
  }
  throw new Error("Library insertion UUID collision retry limit exceeded");
}

export function prepareLibraryInsert(drawing: unknown, item: LibraryItem, options: InsertLibraryOptions): { elements: ExcalidrawElement[]; version: number; createdIds: string[] } {
  const scene = validateLibraryDrawing(drawing);
  const live = assertLibraryItemInsertable(item);
  validateInsertOptions(options);
  if (scene.elements.length + live.length > 10_000) throw new Error("Resulting scene exceeds 10000 elements");
  const used = new Set<string>();
  for (const element of [...scene.elements, ...item.elements]) {
    used.add(element.id as string);
    if (Array.isArray(element.groupIds)) for (const group of element.groupIds) used.add(group as string);
  }
  const ids = new Map(live.map(element => [element.id as string, freshId(used)]));
  const groups = new Map<string, string>();
  for (const element of live) if (Array.isArray(element.groupIds)) for (const group of element.groupIds as string[]) {
    if (!groups.has(group)) groups.set(group, freshId(used));
  }
  const dx = options.x === undefined ? 0 : options.x - Math.min(...live.map(element => element.x as number));
  const dy = options.y === undefined ? 0 : options.y - Math.min(...live.map(element => element.y as number));
  const added = live.map(source => {
    const element = structuredClone(source);
    element.id = ids.get(source.id as string)!;
    element.x = (source.x as number) + dx;
    element.y = (source.y as number) + dy;
    coordinate(element.x, "inserted x"); coordinate(element.y, "inserted y");
    if (Array.isArray(source.groupIds)) element.groupIds = (source.groupIds as string[]).map(group => groups.get(group)!);
    for (const key of ["containerId", "frameId"]) if (source[key] !== undefined) element[key] = ids.get(source[key] as string) ?? null;
    if (Array.isArray(source.boundElements)) element.boundElements = source.boundElements.filter(ref => ids.has((ref as { id: string }).id)).map(ref => ({ ...ref, id: ids.get((ref as { id: string }).id)! }));
    for (const key of ["startBinding", "endBinding"]) if (source[key] !== undefined) {
      const binding = source[key];
      element[key] = record(binding) && ids.has(binding.elementId as string) ? { ...structuredClone(binding), elementId: ids.get(binding.elementId as string)! } : null;
    }
    element.version = 1;
    element.updated = Date.now();
    element.versionNonce = crypto.randomInt(0, 2 ** 31);
    delete element.index;
    return element;
  });
  return { elements: [...structuredClone(scene.elements), ...added], version: scene.version, createdIds: [...ids.values()] };
}
