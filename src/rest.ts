import { isDeepStrictEqual } from "node:util";
import { elementBounds, validateDrawing, type Bounds } from "./drawing-analysis.js";
import { applyOps } from "./agent/applyOps.js";
import type { ExcalidrawElement } from "./agent/elementFactory.js";
import { opsBatchSchema, type OpsBatch } from "./agent/opSchemas.js";
import { buildStructuralSummary, summarizeElements } from "./agent/summary.js";
import { ExcaliDashError, type DrawingList, type DrawingSummary } from "./excalidash.js";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: string;
  responseType?: "json" | "text";
};
type Request = <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;
export type RestDrawing = DrawingSummary & {
  elements: ExcalidrawElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};
const MAX_ELEMENTS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const pathFor = (id: string): string => `drawings/${encodeURIComponent(id)}`;
const normalizeEngine = <T extends DrawingSummary>(drawing: T): T => ({
  ...drawing,
  engine: drawing.engine ?? "excalidraw",
});

export function validateScene(value: unknown): RestDrawing {
  if (!value || typeof value !== "object") {
    throw new ExcaliDashError("Invalid drawing response");
  }
  const drawing = value as Partial<RestDrawing>;
  if (!Number.isSafeInteger(drawing.version) || Number(drawing.version) < 0) {
    throw new ExcaliDashError("Drawing response requires an integer version");
  }
  if (!Array.isArray(drawing.elements)) {
    throw new ExcaliDashError("Drawing response requires an elements array");
  }
  if (drawing.elements.length > MAX_ELEMENTS) {
    throw new ExcaliDashError("Drawing scene exceeds 10000 elements");
  }
  if (drawing.elements.some(el => !el || typeof el !== "object" || Array.isArray(el) || typeof el.id !== "string" || typeof el.type !== "string")) {
    throw new ExcaliDashError("Drawing contains invalid elements");
  }
  if (drawing.engine && drawing.engine !== "excalidraw") {
    throw new ExcaliDashError("ENGINE_MISMATCH: operations support excalidraw only", 409);
  }
  return normalizeEngine(drawing as RestDrawing);
}

function validateBatch(ops: unknown[], clientBatchId?: string): OpsBatch {
  const result = opsBatchSchema.safeParse({ ops, ...(clientBatchId !== undefined ? { clientBatchId } : {}) });
  if (!result.success) {
    throw new ExcaliDashError(`INVALID_OP: ${result.error.message}`, 422);
  }
  if (result.data.ops.some(op => op.op === "revert_to_snapshot")) {
    throw new ExcaliDashError("UNSUPPORTED: revert_to_snapshot is unavailable in REST mode", 422);
  }
  return result.data;
}

// The upstream scene uses shallow copies. Isolate both scene and imported operation
// objects here so a failed batch cannot mutate caller-owned nested properties.
export function prepareRestBatch(drawing: unknown, ops: unknown[], clientBatchId?: string) {
  const scene = validateScene(drawing);
  const batch = structuredClone(validateBatch(ops, clientBatchId));
  const applied = applyOps({ ops: batch.ops, elements: structuredClone(scene.elements) });
  if (!applied.ok) {
    throw new ExcaliDashError(`OPS_VALIDATION_FAILED: ${JSON.stringify(applied.errors)}`, 422);
  }
  if (applied.elements.length > MAX_ELEMENTS) {
    throw new ExcaliDashError("Resulting scene exceeds 10000 elements");
  }
  return { ...applied, version: scene.version };
}

function structuralSummary(drawing: RestDrawing): string {
  const live = drawing.elements.filter(el => !el.isDeleted);
  if (live.length <= 1000) return buildStructuralSummary(drawing);
  return `Scene has ${live.length} live elements; summary truncated to first 1000.\n${buildStructuralSummary({ ...drawing, elements: live.slice(0, 1000) })}`;
}

export class RestAdapter {
  constructor(private readonly request: Request) {}

  async list(path: string): Promise<DrawingList> {
    const list = await this.request<DrawingList>(path);
    return { ...list, drawings: list.drawings.map(normalizeEngine) };
  }

  async create(options: RequestOptions): Promise<DrawingSummary> {
    return normalizeEngine(await this.request<DrawingSummary>("drawings", options));
  }

  async get(id: string): Promise<DrawingSummary> {
    return normalizeEngine(await this.request<DrawingSummary>(pathFor(id)));
  }

  async summary(id: string): Promise<string> {
    return structuralSummary(await this.scene(id));
  }

  async inspect(id: string, elementId: string) {
    const drawing = await this.scene(id);
    const element = drawing.elements.find(el => el.id === elementId && !el.isDeleted);
    if (!element) throw new ExcaliDashError(`Element "${elementId}" not found`, 404);
    const boundIds = new Set<string>(
      (Array.isArray(element.boundElements) ? element.boundElements as { id?: unknown }[] : [])
        .map(ref => ref?.id)
        .filter((value): value is string => typeof value === "string"),
    );
    const children = drawing.elements.filter(el => !el.isDeleted && boundIds.has(el.id));
    return { element, children };
  }

  async apply(id: string, ops: unknown[], clientBatchId?: string, expectedRevision?: number) {
    // Reject unsupported history access and invalid batches before sending any HTTP.
    const batch = validateBatch(ops, clientBatchId);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new ExcaliDashError("expectedRevision requires a safe nonnegative integer", 422);
    }
    const before = await this.scene(id);
    if (expectedRevision !== undefined && expectedRevision !== before.version) {
      throw new ExcaliDashError("VERSION_CONFLICT: perform a fresh read before applying a new batch.", 409, {
        code: "VERSION_CONFLICT", expectedRevision, actualRevision: before.version,
      });
    }
    const prepared = prepareRestBatch(before, batch.ops, clientBatchId);
    const body = JSON.stringify({ elements: prepared.elements, version: prepared.version });
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      throw new ExcaliDashError("Drawing request exceeds 10 MiB limit");
    }
    // Never retry a write: the saved response may be lost after a successful commit.
    const saved = validateScene(await this.request(pathFor(id), { method: "PUT", body }));
    const savedIds = new Set<string>(saved.elements.map(el => el.id));
    const changedIds = [...prepared.changedIds].filter(elementId => savedIds.has(elementId));
    const changed = new Set(changedIds);
    return {
      version: saved.version,
      ...mutationMetadata(before, saved),
      results: prepared.results.map(result => ({ ...result, ...(result.createdIds ? { createdIds: result.createdIds.filter(elementId => savedIds.has(elementId)) } : {}) })),
      changedIds,
      summaryDelta: summarizeElements(saved.elements.filter(el => changed.has(el.id))),
      summary: structuralSummary(saved),
      ...(clientBatchId !== undefined ? { clientBatchId } : {}),
    };
  }

  async scene(id: string): Promise<RestDrawing> {
    return validateScene(await this.request(pathFor(id)));
  }
}


function mutationMetadata(before: RestDrawing, saved: RestDrawing) {
  const previous = new Map(before.elements.map(element => [element.id, element]));
  const current = new Map(saved.elements.map(element => [element.id, element]));
  const createdIds: string[] = [];
  const modifiedIds: string[] = [];
  const deletedIds: string[] = [];
  const changed: ExcalidrawElement[] = [];
  for (const element of before.elements) {
    const after = current.get(element.id);
    if (!element.isDeleted && (!after || after.isDeleted)) {
      deletedIds.push(element.id);
      changed.push(element);
      if (after) changed.push(after);
    }
  }
  for (const element of saved.elements) {
    const old = previous.get(element.id);
    if (element.isDeleted) continue;
    if (!old || old.isDeleted) {
      createdIds.push(element.id);
      changed.push(element);
      if (old) changed.push(old);
    } else if (!isDeepStrictEqual(element, old)) {
      modifiedIds.push(element.id);
      changed.push(old, element);
    }
  }
  const bounds = changed.map(elementBounds).filter((value): value is Bounds => value !== null);
  const left = Math.min(...bounds.map(bound => bound.x));
  const top = Math.min(...bounds.map(bound => bound.y));
  const validation = validateDrawing(saved);
  return {
    createdIds, modifiedIds, deletedIds,
    changedBounds: bounds.length ? { x: left, y: top,
      width: Math.max(...bounds.map(bound => bound.x + bound.width)) - left,
      height: Math.max(...bounds.map(bound => bound.y + bound.height)) - top } : null,
    validationWarnings: validation.issues,
    validationSkippedChecks: validation.skippedChecks,
  };
}
