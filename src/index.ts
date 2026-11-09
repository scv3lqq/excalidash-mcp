#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { opSchema } from "./agent/opSchemas.js";
import { inspectScene, inspectionOptionsSchema, validateDrawing, validationOptionsSchema } from "./drawing-analysis.js";
import { renderDrawing, renderOptionsSchema } from "./drawing-renderer.js";
import { registerLibraryTools } from "./library-tools.js";
import {
  configFromEnv,
  DEFAULT_SOURCE_URL,
  ExcaliDashClient,
  validateSourceUrl,
} from "./excalidash.js";

const id = z.string().min(1);

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const errorResult = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error),
    },
  ],
  isError: true,
  ...((error && typeof error === "object" && "details" in error && error.details) ? { structuredContent: { error: error.details as Record<string, unknown> } } : {}),
});

export const createServer = (
  client: ExcaliDashClient,
  initialDrawingId?: string,
  sourceUrl: string = DEFAULT_SOURCE_URL,
): McpServer => {
  const correspondingSourceUrl = validateSourceUrl(sourceUrl);
  const server = new McpServer({ name: "excalidash-mcp", version: "0.4.0-library.1" }, {
    instructions: `This adapted MCP contains AGPL-3.0-only code. Complete corresponding buildable source is available at ${correspondingSourceUrl} . In REST mode, snapshot restoration is unavailable. On VERSION_CONFLICT, perform a fresh read before applying a new batch. clientBatchId provides correlation only; after uncertain network outcomes, reread the drawing before deciding on another batch.`,
  });
  let selectedDrawingId = initialDrawingId;

  const resolveDrawingId = (drawingId?: string): string => {
    const resolved = drawingId ?? selectedDrawingId;
    if (!resolved) {
      throw new Error(
        "No drawing selected. Call list_drawings and select_drawing first, or pass drawingId.",
      );
    }
    return resolved;
  };

  server.registerTool(
    "list_drawings",
    {
      description:
        "List ExcaliDash drawings available to the account API key. Use this before selecting a drawing.",
      inputSchema: z.object({
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      }),
    },
    async ({ search, limit, offset }) => {
      try {
        const result = await client.listDrawings({ search, limit, offset });
        return textResult(
          JSON.stringify({ selectedDrawingId, ...result }, null, 2),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "select_drawing",
    {
      description:
        "Select an Excalidraw drawing as the default target for subsequent tools in this MCP process.",
      inputSchema: z.object({ drawingId: id }),
    },
    async ({ drawingId }) => {
      try {
        const drawing = await client.getDrawing(drawingId);
        if (drawing.engine !== "excalidraw") {
          throw new Error(
            `Drawing ${drawingId} uses ${drawing.engine}; Agent API operations support Excalidraw only.`,
          );
        }
        selectedDrawingId = drawing.id;
        return textResult(
          JSON.stringify(
            { selectedDrawingId, name: drawing.name, version: drawing.version },
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_selected_drawing",
    {
      description: "Return the drawing currently selected by this MCP process.",
      inputSchema: z.object({}),
    },
    async () =>
      textResult(
        selectedDrawingId
          ? JSON.stringify({ selectedDrawingId })
          : "No drawing selected.",
      ),
  );

  server.registerTool(
    "create_drawing",
    {
      description:
        "Create a new empty Excalidraw drawing and optionally select it as the default target.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200),
        select: z.boolean().default(true),
      }),
    },
    async ({ name, select }) => {
      try {
        const drawing = await client.createDrawing(name);
        if (select) selectedDrawingId = drawing.id;
        return textResult(
          JSON.stringify({ selected: select, drawing }, null, 2),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_drawing_summary",
    {
      description:
        "Read a compact structural summary of a drawing. Uses drawingId when provided, otherwise the selected drawing.",
      inputSchema: z.object({ drawingId: id.optional() }),
    },
    async ({ drawingId }) => {
      try {
        return textResult(await client.getSummary(resolveDrawingId(drawingId)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "inspect_drawing_element",
    {
      description:
        "Inspect one element and its bound children. Uses drawingId when provided, otherwise the selected drawing.",
      inputSchema: z.object({
        drawingId: id.optional(),
        elementId: id,
      }),
    },
    async ({ drawingId, elementId }) => {
      try {
        return textResult(
          JSON.stringify(
            await client.inspectElement(
              resolveDrawingId(drawingId),
              elementId,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("get_drawing_elements", {
    description: "Read ordered drawing elements with filters and revision-pinned pagination. Requires REST mode.",
    inputSchema: inspectionOptionsSchema.extend({ drawingId: id.optional() }),
    annotations: readAnnotations,
  }, async ({ drawingId, ...options }) => {
    try {
      return textResult(JSON.stringify(inspectScene(await client.getScene(resolveDrawingId(drawingId)), options)));
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("validate_drawing", {
    description: "Check drawing geometry and references without modifying the saved scene. Requires REST mode.",
    inputSchema: validationOptionsSchema.extend({ drawingId: id.optional() }),
    annotations: readAnnotations,
  }, async ({ drawingId, ...options }) => {
    try {
      return textResult(JSON.stringify(validateDrawing(await client.getScene(resolveDrawingId(drawingId)), options)));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("render_drawing", {
    description: "Render one authoritative saved drawing snapshot as a PNG using the official Excalidraw renderer. Requires REST mode and a sandboxed browser.",
    inputSchema: renderOptionsSchema.safeExtend({ drawingId: id.optional() }),
    annotations: readAnnotations,
  }, async ({ drawingId, ...options }) => {
    try {
      const scene = await client.getScene(resolveDrawingId(drawingId));
      const { png, ...metadata } = await renderDrawing(scene, options);
      return { content: [
        { type: "text" as const, text: JSON.stringify(metadata) },
        { type: "image" as const, mimeType: "image/png", data: png.toString("base64") },
      ] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool(
    "apply_drawing_ops",
    {
      description:
        "Atomically apply up to 50 semantic operations. Uses drawingId when provided, otherwise the selected drawing. Read the summary first.",
      inputSchema: z.object({
        drawingId: id.optional(),
        ops: z.array(opSchema).min(1).max(50),
        clientBatchId: z.string().max(200).optional(),
        expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      }),
    },
    async ({ drawingId, ops, clientBatchId, expectedRevision }) => {
      try {
        return textResult(
          JSON.stringify(
            await client.applyOps(
              resolveDrawingId(drawingId),
              ops,
              clientBatchId,
              expectedRevision,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerLibraryTools(server, client, resolveDrawingId);
  return server;
};

const main = async (): Promise<void> => {
  const config = configFromEnv();
  const server = createServer(
    new ExcaliDashClient(config),
    config.drawingId,
    config.sourceUrl,
  );
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
