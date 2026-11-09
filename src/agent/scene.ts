import {
  centerOf,
  type ExcalidrawElement,
  touchElement,
} from "./elementFactory.js";

// Working scene: array preserves z-order; map indexes elements by id. Both hold
// the same object references, so in-place mutation is visible through either.
export class Scene {
  elements: ExcalidrawElement[];
  private byId = new Map<string, ExcalidrawElement>();
  private readonly originalById: Map<string, ExcalidrawElement>;
  changed = new Set<string>();
  orderChanged = false;

  constructor(elements: ExcalidrawElement[]) {
    this.originalById = new Map(elements.map(el => [el.id, structuredClone(el)]));
    this.elements = elements.map((el) => ({ ...el }));
    for (const el of this.elements) {
      if (typeof el.id === "string") this.byId.set(el.id, el);
    }
  }

  get(id: string): ExcalidrawElement | undefined {
    return this.byId.get(id);
  }

  getLive(id: string): ExcalidrawElement | undefined {
    const el = this.byId.get(id);
    return !el || el.isDeleted ? undefined : el;
  }

  add(el: ExcalidrawElement): void {
    this.elements.push(el);
    if (typeof el.id === "string") this.byId.set(el.id, el);
    this.changed.add(el.id);
    this.orderChanged = true;
  }

  markChanged(el: ExcalidrawElement): void {
    touchElement(el);
    this.changed.add(el.id);
  }

  boundLabelOf(container: ExcalidrawElement): ExcalidrawElement | undefined {
    const refs = Array.isArray(container.boundElements)
      ? container.boundElements
      : [];
    for (const ref of refs) {
      if (ref?.type === "text" && typeof ref.id === "string") {
        const label = this.byId.get(ref.id);
        if (label && !label.isDeleted) return label;
      }
    }
    return undefined;
  }

  liveElements(ids: string[]): ExcalidrawElement[] | null {
    const elements = ids.map((id) => this.getLive(id));
    return elements.every(Boolean) ? (elements as ExcalidrawElement[]) : null;
  }

  moveBy(el: ExcalidrawElement, dx: number, dy: number): void {
    el.x = (el.x ?? 0) + dx;
    el.y = (el.y ?? 0) + dy;
    this.markChanged(el);
    const label = this.boundLabelOf(el);
    if (label) {
      label.x = (label.x ?? 0) + dx;
      label.y = (label.y ?? 0) + dy;
      this.markChanged(label);
    }
  }

  rerouteBindings(): void {
    for (const arrow of this.elements) {
      const original = this.originalById.get(arrow.id);
      if (!original || arrow.isDeleted || !["arrow", "line"].includes(arrow.type) ||
        !sameGeometry(original, arrow) || !validPoints(arrow.points)) continue;
      const points = worldPoints(arrow);
      const previous = points.map(point => ({ ...point }));
      for (const [binding, index] of [[arrow.startBinding, 0], [arrow.endBinding, points.length - 1]] as const) {
        const target = binding?.elementId ? this.getLive(binding.elementId) : undefined;
        const oldTarget = target ? this.originalById.get(target.id) : undefined;
        if (!target || !oldTarget || sameGeometry(oldTarget, target)) continue;
        points[index] = transformAnchor(points[index]!, oldTarget, target);
      }
      if (points.every((point, index) => point.x === previous[index]!.x && point.y === previous[index]!.y)) continue;
      setWorldPoints(arrow, points);
      this.markChanged(arrow);
      const label = this.boundLabelOf(arrow);
      if (label) {
        const last = points.length - 1;
        label.x += (points[0]!.x + points[last]!.x - previous[0]!.x - previous[last]!.x) / 2;
        label.y += (points[0]!.y + points[last]!.y - previous[0]!.y - previous[last]!.y) / 2;
        this.markChanged(label);
      }
    }
  }
}

type Point = { x: number; y: number };
const sameGeometry = (left: ExcalidrawElement, right: ExcalidrawElement): boolean =>
  ["x", "y", "width", "height", "angle"].every(key => (left[key] ?? 0) === (right[key] ?? 0)) &&
  JSON.stringify(left.points) === JSON.stringify(right.points);
const validPoints = (value: unknown): value is [number, number][] =>
  Array.isArray(value) && value.length >= 2 && value.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
const rotate = (point: Point, angle: number): Point => ({
  x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
  y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
});
function worldPoints(element: ExcalidrawElement): Point[] {
  const center = centerOf(element);
  return (element.points as [number, number][]).map(([x, y]) => {
    const rotated = rotate({ x: element.x + x - center.cx, y: element.y + y - center.cy }, element.angle ?? 0);
    return { x: center.cx + rotated.x, y: center.cy + rotated.y };
  });
}
function transformAnchor(point: Point, before: ExcalidrawElement, after: ExcalidrawElement): Point {
  const oldCenter = centerOf(before);
  const newCenter = centerOf(after);
  const local = rotate({ x: point.x - oldCenter.cx, y: point.y - oldCenter.cy }, -(before.angle ?? 0));
  const transformed = rotate({
    x: local.x * (before.width ? after.width / before.width : 1),
    y: local.y * (before.height ? after.height / before.height : 1),
  }, after.angle ?? 0);
  return { x: newCenter.cx + transformed.x, y: newCenter.cy + transformed.y };
}
function setWorldPoints(element: ExcalidrawElement, points: Point[]): void {
  const angle = element.angle ?? 0;
  const local = points.map(point => rotate(point, -angle));
  const left = Math.min(...local.map(point => point.x));
  const top = Math.min(...local.map(point => point.y));
  const width = Math.max(...local.map(point => point.x)) - left;
  const height = Math.max(...local.map(point => point.y)) - top;
  const center = rotate({ x: left + width / 2, y: top + height / 2 }, angle);
  element.x = center.x - width / 2;
  element.y = center.y - height / 2;
  element.width = width;
  element.height = height;
  element.points = local.map(point => [point.x - left, point.y - top]);
}
