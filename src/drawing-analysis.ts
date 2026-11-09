import { z } from "zod";
import type { ExcalidrawElement } from "./agent/elementFactory.js";

export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const inspectionOptionsSchema = z.object({
  mode: z.enum(["compact", "detailed"]).default("compact"),
  ids: z.array(z.string().min(1)).min(1).max(200).optional(),
  types: z.array(z.string().min(1)).min(1).max(30).optional(),
  bounds: boundsSchema.optional(),
  includeDeleted: z.boolean().default(false),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const validationOptionsSchema = z.object({
  region: boundsSchema.optional(),
  frameId: z.string().min(1).optional(),
  maxIssues: z.number().int().min(1).max(500).default(100),
});

export type Bounds = z.infer<typeof boundsSchema>;
export type InspectionOptions = z.infer<typeof inspectionOptionsSchema>;
export type ValidationOptions = z.infer<typeof validationOptionsSchema>;
type DrawingScene = { version: number; elements: ExcalidrawElement[] };
type Element = Record<string, unknown>;
type Point = { x: number; y: number };
export type DrawingIssue = {
  severity: "error" | "warning" | "info";
  type: string;
  elementIds: string[];
  explanation: string;
  suggestion?: string;
};
export type InspectionResult = {
  version: number;
  elements: Element[];
  totalCount: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  truncated: boolean;
};
export type ValidationResult = {
  version: number;
  issues: DrawingIssue[];
  truncated: boolean;
  skippedChecks: string[];
};

export class SceneAnalysisError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "SceneAnalysisError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLinear(element: Element): boolean {
  return element.type === "line" || element.type === "arrow" || element.type === "freedraw";
}

function validGeometry(element: Element): boolean {
  return finite(element.x) && finite(element.y) && finite(element.width) && finite(element.height)
    && (element.angle === undefined || finite(element.angle))
    && element.width >= 0 && element.height >= 0
    && (isLinear(element) || (element.width > 0 && element.height > 0));
}

function validPoints(value: unknown): value is [number, number][] {
  return Array.isArray(value) && value.length >= 2
    && value.every(point => Array.isArray(point) && point.length === 2 && finite(point[0]) && finite(point[1]));
}

function rotate(point: Point, center: Point, angle: number): Point {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

function outline(element: Element): Point[] | null {
  if (!validGeometry(element)) return null;
  const x = element.x as number;
  const y = element.y as number;
  const width = element.width as number;
  const height = element.height as number;
  const angle = element.angle === undefined ? 0 : element.angle as number;
  const center = { x: x + width / 2, y: y + height / 2 };
  let points: Point[];
  if (isLinear(element)) {
    if (!validPoints(element.points)) return null;
    points = element.points.map(([px, py]) => ({ x: x + px, y: y + py }));
  } else {
    points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  }
  const rotated = points.map(point => rotate(point, center, angle));
  return rotated.every(point => finite(point.x) && finite(point.y)) ? rotated : null;
}

export function elementBounds(element: ExcalidrawElement): Bounds | null {
  const points = outline(element);
  if (!points) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    x = Math.min(x, point.x);
    y = Math.min(y, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const width = right - x;
  const height = bottom - y;
  return finite(width) && finite(height) ? { x, y, width, height } : null;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

const compactKeys = [
  "id", "type", "x", "y", "width", "height", "angle", "points", "text", "originalText",
  "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "autoResize",
  "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness",
  "roundness", "opacity", "hidden", "isDeleted", "locked", "startBinding", "endBinding",
  "startArrowhead", "endArrowhead", "elbowed", "fixedSegments", "boundElements", "containerId",
  "frameId", "groupIds", "index", "fileId", "scale", "crop", "link",
] as const;

function inspectedElement(element: ExcalidrawElement, arrayIndex: number, mode: InspectionOptions["mode"]): Element {
  const selected: Element = mode === "detailed" ? { ...element } : {};
  if (mode === "compact") for (const key of compactKeys) if (key in element) selected[key] = element[key];
  return { ...selected, arrayIndex };
}

function revisionError(scene: DrawingScene, options: InspectionOptions): void {
  if (options.offset > 0 && options.expectedRevision === undefined) {
    throw new SceneAnalysisError("A nonzero offset requires expectedRevision from the first page.");
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== scene.version) {
    throw new SceneAnalysisError("VERSION_CONFLICT: revision changed; perform a fresh read and restart pagination.", {
      code: "VERSION_CONFLICT", expectedRevision: options.expectedRevision, actualRevision: scene.version,
    });
  }
}

export function inspectScene(scene: DrawingScene, input: Partial<InspectionOptions> = {}): InspectionResult {
  const options = inspectionOptionsSchema.parse(input);
  revisionError(scene, options);
  const ids = options.ids ? new Set(options.ids) : undefined;
  const types = options.types ? new Set(options.types) : undefined;
  const matching = scene.elements.flatMap((element, arrayIndex) => {
    if ((!options.includeDeleted && element.isDeleted) || (ids && !ids.has(element.id)) || (types && !types.has(element.type))) return [];
    if (options.bounds) {
      const bounds = elementBounds(element);
      if (!bounds || !intersects(bounds, options.bounds)) return [];
    }
    return [{ element, arrayIndex }];
  });
  const page = (elements: Element[]): InspectionResult => {
    const nextOffset = options.offset + elements.length < matching.length ? options.offset + elements.length : null;
    return { version: scene.version, elements, totalCount: matching.length, offset: options.offset, limit: options.limit, nextOffset, truncated: nextOffset !== null };
  };
  const elements: Element[] = [];
  for (const entry of matching.slice(options.offset, options.offset + options.limit)) {
    const element = inspectedElement(entry.element, entry.arrayIndex, options.mode);
    const candidate = page([...elements, element]);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 1_048_576) {
      if (elements.length === 0) throw new SceneAnalysisError(`Element ${String(entry.element.id)} is too large for the 1 MiB inspection page limit.`);
      break;
    }
    elements.push(element);
  }
  return page(elements);
}

function visible(element: Element): boolean {
  return !element.isDeleted && !element.hidden && element.opacity !== 0;
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function polygonArea(points: Point[]): number {
  const origin = points[0];
  if (!origin) return 0;
  // Local coordinates avoid cancellation when a small shape is far from the origin.
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + (point.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (point.y - origin.y);
  }, 0)) / 2;
}

function intersectionPolygon(subject: Point[], clip: Point[]): Point[] {
  let result = subject;
  for (let index = 0; index < clip.length && result.length; index += 1) {
    const a = clip[index]!;
    const b = clip[(index + 1) % clip.length]!;
    const input = result;
    result = [];
    for (let j = 0; j < input.length; j += 1) {
      const start = input[j]!;
      const end = input[(j + 1) % input.length]!;
      const startSide = cross(a, b, start);
      const endSide = cross(a, b, end);
      const startInside = startSide >= -1e-9;
      const endInside = endSide >= -1e-9;
      if (startInside !== endInside) {
        const t = startSide / (startSide - endSide);
        result.push({ x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
      }
      if (endInside) result.push(end);
    }
  }
  return result;
}

function containsPolygon(container: Point[], child: Point[]): boolean {
  return child.every(point => container.every((a, index) => cross(a, container[(index + 1) % container.length]!, point) >= -1e-8));
}

function sameGroup(a: Element, b: Element): boolean {
  return Array.isArray(a.groupIds) && Array.isArray(b.groupIds) && a.groupIds.some(id => typeof id === "string" && (b.groupIds as unknown[]).includes(id));
}

function intentionalPair(a: Element, b: Element, aOutline: Point[], bOutline: Point[]): boolean {
  if (a.containerId === b.id || b.containerId === a.id || a.frameId === b.id || b.frameId === a.id) return true;
  return sameGroup(a, b) && (containsPolygon(aOutline, bOutline) || containsPolygon(bOutline, aOutline));
}

type IssueSink = (issue: DrawingIssue) => void;

function referenceIssues(element: Element, liveIds: Set<string>, emit: IssueSink): void {
  const elementIds = typeof element.id === "string" ? [element.id] : [];
  const check = (value: unknown, name: string): void => {
    if (typeof value !== "string" || value.length === 0) {
      emit({ severity: "error", type: "invalid_reference", elementIds, explanation: `${name} must reference a nonempty element ID.` });
    } else if (!liveIds.has(value)) {
      emit({ severity: "error", type: "missing_reference", elementIds, explanation: `${name} references missing live element ${value}.` });
    }
  };
  for (const name of ["containerId", "frameId"] as const) if (element[name] !== undefined && element[name] !== null) check(element[name], name);
  for (const name of ["startBinding", "endBinding"] as const) {
    const binding = element[name];
    if (binding === undefined || binding === null) continue;
    if (!isRecord(binding)) emit({ severity: "error", type: "invalid_reference", elementIds, explanation: `${name} must be an object with elementId.` });
    else check(binding.elementId, name);
  }
  if (element.boundElements === undefined || element.boundElements === null) return;
  if (!Array.isArray(element.boundElements)) {
    emit({ severity: "error", type: "invalid_reference", elementIds, explanation: "boundElements must be an array of element references." });
    return;
  }
  for (const reference of element.boundElements) {
    if (!isRecord(reference) || typeof reference.type !== "string") emit({ severity: "error", type: "invalid_reference", elementIds, explanation: "Each boundElements reference must contain an ID and type." });
    else check(reference.id, "boundElements");
  }
}

function geometryIssues(element: Element, emit: IssueSink): void {
  const elementIds = typeof element.id === "string" ? [element.id] : [];
  if (!validGeometry(element)) {
    emit({ severity: "error", type: "invalid_geometry", elementIds, explanation: "Geometry requires finite numeric x/y/width/height and angle when supplied, with positive node dimensions or nonnegative line dimensions." });
  }
  if (isLinear(element)) {
    if (!validPoints(element.points)) {
      emit({ severity: "error", type: "invalid_points", elementIds, explanation: "Line points must contain at least two finite coordinate pairs." });
    } else {
      const first = element.points[0]!;
      if (element.points.every(point => point[0] === first[0] && point[1] === first[1])) emit({ severity: "error", type: "invalid_geometry", elementIds, explanation: "A zero-length connector has no valid geometry." });
    }
  }
}

const overlapTypes = new Set(["rectangle", "ellipse", "diamond", "text", "image"]);

export function validateDrawing(scene: DrawingScene, input: Partial<ValidationOptions> = {}): ValidationResult {
  const options = validationOptionsSchema.parse(input);
  const issues: DrawingIssue[] = [];
  let truncated = false;
  const emit: IssueSink = issue => {
    if (issues.length < options.maxIssues) issues.push(issue);
    else truncated = true;
  };
  const skippedChecks = [
    "Font clipping is skipped because exact glyph and font measurement is unavailable.",
    "Connector obstruction is skipped because reliable path and outline measurement is unavailable.",
  ];
  const live = scene.elements.filter(element => !element.isDeleted);
  const liveIds = new Set(live.map(element => element.id).filter((id): id is string => typeof id === "string"));
  const seen = new Set<string>();
  const frame = options.frameId ? live.find(element => element.id === options.frameId && element.type === "frame") : undefined;
  const frameOutline = frame ? outline(frame) : null;
  if (options.frameId && !frame) emit({ severity: "error", type: "missing_reference", elementIds: [options.frameId], explanation: `Requested frame ${options.frameId} was not found.` });
  const regionOutline = options.region ? outline({ ...options.region, type: "rectangle" }) : null;
  for (const element of scene.elements) {
    if (typeof element.id === "string") {
      if (seen.has(element.id)) emit({ severity: "error", type: "duplicate_id", elementIds: [element.id], explanation: `Duplicate element ID ${element.id}.` });
      seen.add(element.id);
    }
    if (element.isDeleted) continue;
    geometryIssues(element, emit);
    referenceIssues(element, liveIds, emit);
    if (!visible(element)) continue;
    const polygon = outline(element);
    if (regionOutline && polygon && !containsPolygon(regionOutline, polygon)) emit({ severity: "warning", type: "outside_region", elementIds: [element.id], explanation: "Element extends outside the requested region boundary." });
    if (frameOutline && polygon && element.frameId === options.frameId && !containsPolygon(frameOutline, polygon)) emit({ severity: "warning", type: "outside_frame", elementIds: [element.id, options.frameId!], explanation: "Declared child extends outside its frame boundary." });
  }
  const candidates = live.filter(element => visible(element) && overlapTypes.has(element.type)).flatMap(element => {
    const polygon = outline(element);
    const bounds = elementBounds(element);
    return polygon && bounds ? [{ element, polygon, bounds }] : [];
  });
  let pairs = 0;
  let exhausted = false;
  for (let index = 0; index < candidates.length && !exhausted; index += 1) {
    const a = candidates[index]!;
    for (let other = index + 1; other < candidates.length; other += 1) {
      if (pairs >= 200_000) {
        exhausted = true;
        break;
      }
      pairs += 1;
      const b = candidates[other]!;
      if (!intersects(a.bounds, b.bounds) || intentionalPair(a.element, b.element, a.polygon, b.polygon)) continue;
      const area = polygonArea(intersectionPolygon(a.polygon, b.polygon));
      if (area >= 64 && area >= 0.2 * Math.min(polygonArea(a.polygon), polygonArea(b.polygon))) {
        const approximate = [a.element.type, b.element.type].some(type => type === "ellipse" || type === "diamond");
        emit({ severity: "warning", type: "node_overlap", elementIds: [a.element.id, b.element.id], explanation: `Independent visible nodes have a substantial overlap.${approximate ? " Conservative estimate uses rotation-aware rectangular bounds for ellipse/diamond outlines." : ""}`, suggestion: "Move or resize the affected nodes, or declare their intentional container relationship." });
      }
    }
  }
  if (exhausted) skippedChecks.push("Further overlap pair computations are skipped after the 200000 pair limit.");
  if (live.some(element => !overlapTypes.has(element.type) && element.type !== "frame")) skippedChecks.push("Unsupported node outlines are excluded from node overlap checks; connector paths are not node rectangles.");
  return { version: scene.version, issues, truncated, skippedChecks };
}
