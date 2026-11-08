import { RestAdapter } from "./rest.js";
import {
  assertLibraryItemInsertable,
  listLibraryItems as selectLibraryItems,
  parseLibrary,
  prepareLibraryInsert,
  validateInsertOptions,
  validateLibraryDrawing,
  type InsertLibraryOptions,
  type LibraryItem,
  type LibraryListOptions,
  type LibraryPage,
} from "./library.js";

export type ExcaliDashConfig = {
  url: string;
  token: string;
  drawingId?: string;
  apiMode?: "rest";
  sourceUrl?: string;
};

export type DrawingSummary = {
  id: string;
  name: string;
  engine: "excalidraw" | "tldraw";
  collectionId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DrawingList = {
  drawings: DrawingSummary[];
  totalCount: number;
  limit: number;
  offset: number;
};

export type Fetch = typeof globalThis.fetch;

export class ExcaliDashError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ExcaliDashError";
  }
}

const apiBase = (url: string): string => {
  const base = url.trim().replace(/\/+$/, "");
  if (!base) throw new Error("EXCALIDASH_URL is required");
  return base.endsWith("/api") ? base : `${base}/api`;
};

export const DEFAULT_SOURCE_URL = "https://github.com/scv3lqq/excalidash-mcp";

export const validateSourceUrl = (value: string): string => {
  const sourceUrl = value.trim();
  try {
    if (new URL(sourceUrl).protocol === "https:") return sourceUrl;
  } catch {
    // Report a configuration error without reflecting the supplied URL.
  }
  throw new Error("MCP_SOURCE_URL must be an HTTPS URL");
};

export const configFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ExcaliDashConfig => {
  const url = env.EXCALIDASH_URL?.trim();
  const token =
    env.EXCALIDASH_API_KEY?.trim() || env.EXCALIDASH_TOKEN?.trim();
  const drawingId = env.EXCALIDASH_DRAWING_ID?.trim() || undefined;

  if (!url) throw new Error("EXCALIDASH_URL is required");
  if (!token) {
    throw new Error(
      "EXCALIDASH_API_KEY is required (EXCALIDASH_TOKEN is accepted for compatibility)",
    );
  }

  const apiMode = env.EXCALIDASH_API_MODE?.trim();
  if (apiMode && apiMode !== "rest") {
    throw new Error("EXCALIDASH_API_MODE must be rest or empty");
  }
  const sourceUrl = env.MCP_SOURCE_URL?.trim();
  return {
    url,
    token,
    drawingId,
    ...(apiMode ? { apiMode: "rest" as const } : {}),
    ...(sourceUrl ? { sourceUrl: validateSourceUrl(sourceUrl) } : {}),
  };
};

export class ExcaliDashClient {
  private readonly baseUrl: string;
  private readonly rest: RestAdapter | undefined;

  constructor(
    private readonly config: ExcaliDashConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.baseUrl = apiBase(config.url);
    this.rest = config.apiMode === "rest"
      ? new RestAdapter((path, options) => this.request(path, options))
      : undefined;
  }

  listDrawings(options: {
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<DrawingList> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 50),
      offset: String(options.offset ?? 0),
    });
    if (options.search) query.set("search", options.search);
    if (this.rest) return this.rest.list(`drawings?${query}`);
    return this.request(`drawings?${query}`);
  }

  createDrawing(name: string): Promise<DrawingSummary> {
    const options = {
      method: "POST" as const,
      body: JSON.stringify({
        name,
        engine: "excalidraw",
        elements: [],
        appState: {},
        files: {},
      }),
    };
    if (this.rest) return this.rest.create(options);
    return this.request("drawings", options);
  }
  getDrawing(drawingId: string): Promise<DrawingSummary> {
    if (this.rest) return this.rest.get(drawingId);
    return this.request(`drawings/${encodeURIComponent(drawingId)}`);
  }

  getSummary(drawingId: string): Promise<string> {
    if (this.rest) return this.rest.summary(drawingId);
    return this.request(
      `drawings/${encodeURIComponent(drawingId)}/summary`,
      { responseType: "text" },
    );
  }

  inspectElement(drawingId: string, elementId: string): Promise<unknown> {
    if (this.rest) return this.rest.inspect(drawingId, elementId);
    return this.request(
      `drawings/${encodeURIComponent(drawingId)}/elements/${encodeURIComponent(elementId)}`,
    );
  }

  applyOps(
    drawingId: string,
    ops: unknown[],
    clientBatchId?: string,
  ): Promise<unknown> {
    if (this.rest) return this.rest.apply(drawingId, ops, clientBatchId);
    return this.request(`drawings/${encodeURIComponent(drawingId)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops, ...(clientBatchId ? { clientBatchId } : {}) }),
    });
  }

  async listLibraryItems(options: LibraryListOptions = {}): Promise<LibraryPage & { previewItems: LibraryItem[] }> {
    const items = parseLibrary(await this.request("library"));
    const page = selectLibraryItems(items, options);
    const byId = new Map(items.map(item => [item.id, item]));
    return { ...page, previewItems: page.items.map(item => byId.get(item.id)!) };
  }

  async getLibraryItem(itemId: string): Promise<LibraryItem> {
    const items = parseLibrary(await this.request("library"));
    const item = items.find(candidate => candidate.id === itemId);
    if (!item) throw new ExcaliDashError("Library item not found", 404);
    return item;
  }

  async insertLibraryItem(drawingId: string, itemId: string, options: InsertLibraryOptions = {}): Promise<{ drawingId: string; libraryItemId: string; version: number; createdIds: string[]; elementCount: number }> {
    if (!this.rest) throw new ExcaliDashError("Library insertion requires REST mode", 422);
    validateInsertOptions(options);
    const item = await this.getLibraryItem(itemId);
    assertLibraryItemInsertable(item);
    const path = `drawings/${encodeURIComponent(drawingId)}`;
    const prepared = prepareLibraryInsert(await this.request(path), item, options);
    const body = JSON.stringify({ elements: prepared.elements, version: prepared.version });
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new ExcaliDashError("Drawing request exceeds 10 MiB limit", 422);
    // Append directly: generic semantic operations reroute existing arrow bindings.
    const saved = validateLibraryDrawing(await this.request(path, { method: "PUT", body }));
    const savedIds = new Set(saved.elements.map(element => element.id as string));
    if (prepared.createdIds.some(id => !savedIds.has(id))) throw new ExcaliDashError("Saved drawing is missing inserted library elements");
    return { drawingId, libraryItemId: itemId, version: saved.version, createdIds: prepared.createdIds, elementCount: prepared.createdIds.length };
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: string;
      responseType?: "json" | "text";
    } = {},
  ): Promise<T> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: options.responseType === "text" ? "text/plain" : "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const text = await readBoundedResponse(response);
      if (!response.ok) {
        const detail = this.redact(text);
        const conflict = response.status === 409 && this.rest
          ? "VERSION_CONFLICT: perform a fresh read before applying a new batch. "
          : "";
        throw new ExcaliDashError(
          `${conflict}ExcaliDash request failed (${response.status})${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }
      return (options.responseType === "text" ? text : JSON.parse(text)) as T;
    } catch (error) {
      if (error instanceof ExcaliDashError) throw error;
      throw new ExcaliDashError(this.redact(error instanceof Error ? error.message : "Request failed"));
    }
  }

  private redact(text: string): string {
    return text.split(this.config.token).join("[REDACTED]").slice(0, 2000);
  }
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

async function readBoundedResponse(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ExcaliDashError("HTTP response exceeds 10 MiB limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ExcaliDashError("HTTP response exceeds 10 MiB limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
