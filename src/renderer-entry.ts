import { exportToCanvas, exportToSvg, getCommonBounds, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement as OfficialElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { RenderPayload, RenderGeometry } from "./drawing-renderer.js";

declare global {
  interface Window {
    __rendererCspViolation: string;
    renderScene(payload: RenderPayload): Promise<RenderGeometry & { data: string }>;
  }
}

window.renderScene = async ({ scene, options }) => {
  for (const element of scene.elements) for (const key of ["strokeColor", "backgroundColor"]) {
    if (!CSS.supports("color", element[key]) || /currentcolor|inherit|initial|unset|revert/i.test(element[key])) throw new Error(`Invalid render color: ${key}`);
  }
  const backgroundColor = CSS.supports("color", scene.appState.viewBackgroundColor) ? scene.appState.viewBackgroundColor : "#ffffff";
  for (const file of Object.values(scene.files)) {
    const image = new Image(); image.src = (file as { dataURL: string }).dataURL;
    try { await image.decode(); } catch { throw new Error("Malformed inline image asset cannot be decoded"); }
    if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error("Inline image decoded pixel limit");
  }
  const appState = {
    exportBackground: options.background, viewBackgroundColor: backgroundColor,
    exportWithDarkMode: false, exportEmbedScene: false,
    frameRendering: { enabled: true, clip: true, name: false, outline: true },
  };
  // Load native FontFaces before restoring text metrics or drawing either output.
  // This canvas is always one pixel, including for distant region-only scenes.
  if (scene.elements.length) await exportToCanvas({ elements: scene.elements as NonDeleted<OfficialElement>[], files: scene.files as BinaryFiles, appState, exportPadding: 0, getDimensions: () => ({ width: 1, height: 1, scale: 1 }) });
  const elements = restoreElements(scene.elements as OfficialElement[], null, { repairBindings: false }) as NonDeleted<OfficialElement>[];
  const byId = new Map(elements.map(element => [element.id, element]));
  const roots = elements.filter(element => !element.frameId || !byId.has(element.frameId));
  const [minX, minY, maxX, maxY] = roots.length ? getCommonBounds(roots) : [0, 0, 1, 1];
  const content = options.region ?? { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  const bounds = {
    x: content.x - options.padding, y: content.y - options.padding,
    width: content.width + options.padding * 2, height: content.height + options.padding * 2,
  };
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error("Invalid official render bounds");
  const width = Math.max(1, Math.ceil(bounds.width * options.scale));
  const height = Math.max(1, Math.ceil(bounds.height * options.scale));
  if (width > 4096 || height > 4096 || width * height > 4_000_000) throw new Error("Render pixel limit: 4096 per axis and 4000000 total pixels");
  let data: string;
  const verifyFonts = async (): Promise<void> => {
    const families: Record<number, string> = { 1: "Virgil", 3: "Cascadia", 5: "Excalifont", 6: "Nunito", 7: "Lilita One", 8: "Comic Shanns", 9: "Liberation Sans" };
    for (const element of elements) if (element.type === "text" && element.fontFamily !== 2 && element.text) {
      const family = families[element.fontFamily];
      if (!family) throw new Error("Unsupported render font family");
      const loaded = await document.fonts.load(`${element.fontSize}px "${family}"`, element.text);
      if (!loaded.length || loaded.some(face => face.status !== "loaded")) throw new Error("Required local official font did not load");
    }
  };
  if (options.region && elements.length) {
    await verifyFonts();
    // SVG keeps original frame children and clipping; exportingFrame would omit
    // children belonging to other frames. Never accept caller-provided SVG/HTML.
    const svg = await exportToSvg({ elements, files: scene.files as BinaryFiles, appState: { ...appState, exportBackground: false }, exportPadding: 0, skipInliningFonts: true });
    svg.setAttribute("viewBox", `${bounds.x - minX} ${bounds.y - minY} ${bounds.width} ${bounds.height}`);
    svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
    svg.style.display = "block";
    document.body.style.backgroundColor = options.background ? backgroundColor : "transparent";
    document.body.append(svg);
    await document.fonts.ready;
    data = "";
  } else {
    let canvas: HTMLCanvasElement;
    if (!elements.length) {
      canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      if (options.background) { const context = canvas.getContext("2d")!; context.fillStyle = backgroundColor; context.fillRect(0, 0, width, height); }
    } else {
      canvas = await exportToCanvas({ elements, files: scene.files as BinaryFiles, appState, exportPadding: options.padding, getDimensions: () => ({ width, height, scale: options.scale }) });
      await verifyFonts();
    }
    data = canvas.toDataURL("image/png").split(",")[1]!;
  }
  const warnings = elements.some(element => element.type === "text" && (element.fontFamily === 2 || /[\u{1f000}-\u{1ffff}]/u.test(element.text))) ? ["Helvetica and emoji glyphs may depend on browser system fonts; bundled official font families are loaded locally."] : [];
  return { bounds, width, height, ...(warnings.length ? { warnings } : {}), data };
};
