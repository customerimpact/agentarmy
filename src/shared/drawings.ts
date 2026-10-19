// Drawings / annotations on the board (src/web/components/drawing). Shapes live in flow (board)
// coordinates, so they pan and zoom with the consoles. Shared by the server (validation, persistence
// in BoardState.drawings) and the browser UI.

export type ShapeKind = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'image';
export const SHAPE_KINDS: readonly ShapeKind[] = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'image'];

// Colour keys, not CSS values: the UI maps them to theme tokens so drawings follow the theme
export const DRAW_COLORS = ['ink', 'orange', 'amber', 'rose', 'violet', 'blue', 'teal', 'green'] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];

export type StrokeWidth = 'S' | 'M' | 'L';
export type StrokeDash = 'solid' | 'dashed';
export type ShapeFill = 'none' | 'soft';

export interface ShapeStyle {
  color: DrawColor;
  width: StrokeWidth;
  dash: StrokeDash;
  fill: ShapeFill;
  opacity: number; // 0.1..1
}

// An arrow / line end glued to a board node (console, browser tile, board item). fx/fy are the
// end's position inside the node rect as fractions (0..1), so the arrow follows moves and resizes.
export interface ShapeAnchor {
  nodeId: string;
  fx: number;
  fy: number;
}

export interface Shape {
  id: string;
  kind: ShapeKind;
  workspaceId: string; // board tab; missing on old data = 'main'
  // Box shapes (rect, ellipse, text, image): the box. Point shapes (pen, line, arrow): the bounds
  // of `points` when last saved (the live bounds of an anchored arrow follow its nodes).
  x: number;
  y: number;
  w: number;
  h: number;
  points?: [number, number][]; // pen: the stroke; line / arrow: [start, end]; flow coordinates
  start?: ShapeAnchor | null; // line / arrow only
  end?: ShapeAnchor | null;
  text?: string; // text shapes
  imageId?: string; // image shapes: id from POST /api/images
  style: ShapeStyle;
  z: number; // paint order inside the drawing layer, ascending
  createdAt: number;
  updatedAt: number;
}

// GET  /api/drawings                         -> { shapes: Shape[] }
// POST /api/drawings/ops  DrawingOps         -> { ok: true; upserted: number; removed: number }
//      (validated; broadcast to every tab as { type: 'drawings', upsert, remove, origin })
// POST /api/images  <raw png/jpeg/gif/webp bytes, max 10 MB> -> ImageUploadResponse
// GET  /api/images/:id                       -> the image (auth like every /api route)

export interface DrawingOps {
  upsert?: Shape[];
  remove?: string[];
  origin?: string; // the sending tab's id, echoed in the broadcast so it can skip its own changes
}

export interface ImageUploadResponse {
  id: string; // e.g. 'img_ab12...'.png
  url: string; // /api/images/<id>
  bytes: number;
}

export const MAX_SHAPES = 5000;
export const MAX_POINTS = 4000; // per pen stroke
export const MAX_TEXT = 5000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
export const IMAGE_ID_RE = /^img_[a-z0-9]{8,40}\.(png|jpg|gif|webp)$/;

const COORD_LIMIT = 1e7;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const DEFAULT_SHAPE_STYLE: ShapeStyle = { color: 'ink', width: 'M', dash: 'solid', fill: 'none', opacity: 1 };

function validStyle(raw: unknown): ShapeStyle | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!DRAW_COLORS.includes(s.color as DrawColor)) return null;
  if (s.width !== 'S' && s.width !== 'M' && s.width !== 'L') return null;
  if (s.dash !== 'solid' && s.dash !== 'dashed') return null;
  if (s.fill !== 'none' && s.fill !== 'soft') return null;
  if (typeof s.opacity !== 'number' || !Number.isFinite(s.opacity)) return null;
  return { color: s.color as DrawColor, width: s.width, dash: s.dash, fill: s.fill, opacity: clamp(s.opacity, 0.1, 1) };
}

function validAnchor(raw: unknown): ShapeAnchor | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.nodeId !== 'string' || !a.nodeId || a.nodeId.length > 128) return undefined;
  if (!isNum(a.fx) || !isNum(a.fy)) return undefined;
  return { nodeId: a.nodeId, fx: clamp(a.fx, 0, 1), fy: clamp(a.fy, 0, 1) };
}

// Returns a clean copy of a shape sent by a client, or null when it is malformed
export function validateShape(raw: unknown, defaultWorkspaceId = 'main'): Shape | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  if (!SHAPE_KINDS.includes(r.kind as ShapeKind)) return null;
  const kind = r.kind as ShapeKind;
  if (!isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) return null;
  const style = validStyle(r.style);
  if (!style) return null;
  const now = Date.now();
  const shape: Shape = {
    id: r.id,
    kind,
    workspaceId: typeof r.workspaceId === 'string' && r.workspaceId && r.workspaceId.length <= 64 ? r.workspaceId : defaultWorkspaceId,
    x: r.x,
    y: r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
    style,
    z: isNum(r.z) ? r.z : 0,
    createdAt: isNum(r.createdAt) ? r.createdAt : now,
    updatedAt: isNum(r.updatedAt) ? r.updatedAt : now,
  };
  if (kind === 'pen' || kind === 'line' || kind === 'arrow') {
    if (!Array.isArray(r.points)) return null;
    const max = kind === 'pen' ? MAX_POINTS : 2;
    if (r.points.length < (kind === 'pen' ? 1 : 2) || r.points.length > max) return null;
    const points: [number, number][] = [];
    for (const p of r.points) {
      if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) return null;
      points.push([p[0], p[1]]);
    }
    shape.points = points;
    if (kind !== 'pen') {
      const start = validAnchor(r.start);
      const end = validAnchor(r.end);
      if (start !== undefined) shape.start = start;
      if (end !== undefined) shape.end = end;
    }
  }
  if (kind === 'text') {
    if (typeof r.text !== 'string' || r.text.length > MAX_TEXT) return null;
    shape.text = r.text;
  }
  if (kind === 'image') {
    if (typeof r.imageId !== 'string' || !IMAGE_ID_RE.test(r.imageId)) return null;
    shape.imageId = r.imageId;
  }
  return shape;
}

// Detects the real image type from its first bytes (the Content-Type header is not trusted)
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp';
  return null;
}
