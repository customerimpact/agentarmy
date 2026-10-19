import { memo } from 'react';
import type { Shape } from '../../../shared/drawings';
import { arrowHead, linkEnds, penPath, STROKE_PX, TEXT_LINE, TEXT_PX, type RectOf } from '../../lib/drawing/geometry';
import { imageUrl } from '../../lib/drawing/store';
import { colorVar, softFill } from '../../lib/drawing/colors';

// One shape as SVG, in flow coordinates. Colours are theme tokens so drawings follow the theme.

export { colorVar, softFill };

export const TEXT_FONT = "'Inter Variable', 'Inter', 'Segoe UI', system-ui, sans-serif";

interface Props {
  shape: Shape;
  rectOf: RectOf;
  interactive: boolean; // receives pointer events (select tool / outside draw mode)
  nopan: boolean; // dragging it moves the shape instead of panning the board
  faded?: boolean; // marked by the eraser
  zoom: number;
  onPointerDown?: (e: React.PointerEvent<SVGGElement>, shape: Shape) => void;
  onDoubleClick?: (e: React.MouseEvent<SVGGElement>, shape: Shape) => void;
}

function ShapeSvgImpl({ shape, rectOf, interactive, nopan, faded, zoom, onPointerDown, onDoubleClick }: Props) {
  const { style } = shape;
  const color = colorVar(style.color);
  const sw = STROKE_PX[style.width];
  const dash = style.dash === 'dashed' ? `${sw * 3} ${sw * 2.5}` : undefined;
  const fill = style.fill === 'soft' ? softFill(style.color) : 'none';
  const hitWidth = Math.max(sw, 14 / Math.max(zoom, 0.05));
  const common = {
    'data-shape-id': shape.id,
    'data-shape-kind': shape.kind,
    className: nopan ? 'nopan nodrag' : undefined,
    opacity: faded ? style.opacity * 0.25 : style.opacity,
    style: { pointerEvents: interactive ? ('visiblePainted' as const) : ('none' as const), cursor: interactive ? 'move' : undefined },
    onPointerDown: onPointerDown ? (e: React.PointerEvent<SVGGElement>) => onPointerDown(e, shape) : undefined,
    onDoubleClick: onDoubleClick ? (e: React.MouseEvent<SVGGElement>) => onDoubleClick(e, shape) : undefined,
  };
  const strokeProps = { stroke: color, strokeWidth: sw, strokeDasharray: dash, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };

  switch (shape.kind) {
    case 'pen': {
      const d = penPath(shape.points ?? []);
      return (
        <g {...common}>
          <path d={d} stroke="transparent" strokeWidth={hitWidth} fill="none" strokeLinecap="round" />
          <path d={d} {...strokeProps} />
        </g>
      );
    }
    case 'line':
    case 'arrow': {
      const [a, b] = linkEnds(shape, rectOf);
      const d = `M${a.x} ${a.y}L${b.x} ${b.y}`;
      return (
        <g {...common}>
          <path d={d} stroke="transparent" strokeWidth={hitWidth} fill="none" />
          <path d={d} {...strokeProps} />
          {shape.kind === 'arrow' && <path d={arrowHead(a, b, sw)} {...strokeProps} strokeDasharray={undefined} />}
        </g>
      );
    }
    case 'rect':
      return (
        <g {...common}>
          <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={Math.min(10, shape.w / 4, shape.h / 4)} stroke="transparent" strokeWidth={hitWidth} fill={style.fill === 'soft' ? 'transparent' : 'none'} />
          <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={Math.min(10, shape.w / 4, shape.h / 4)} {...strokeProps} fill={fill} />
        </g>
      );
    case 'ellipse': {
      const rx = shape.w / 2;
      const ry = shape.h / 2;
      return (
        <g {...common}>
          <ellipse cx={shape.x + rx} cy={shape.y + ry} rx={rx} ry={ry} stroke="transparent" strokeWidth={hitWidth} fill={style.fill === 'soft' ? 'transparent' : 'none'} />
          <ellipse cx={shape.x + rx} cy={shape.y + ry} rx={rx} ry={ry} {...strokeProps} fill={fill} />
        </g>
      );
    }
    case 'text': {
      const size = TEXT_PX[style.width];
      const lines = (shape.text ?? '').split('\n');
      return (
        <g {...common}>
          <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill="transparent" />
          <text x={shape.x} y={shape.y} fill={color} fontSize={size} fontFamily={TEXT_FONT} fontWeight={500} dominantBaseline="hanging" style={{ whiteSpace: 'pre' }}>
            {lines.map((line, i) => (
              <tspan key={i} x={shape.x} dy={i === 0 ? size * (TEXT_LINE - 1) * 0.5 : size * TEXT_LINE}>
                {line || ' '}
              </tspan>
            ))}
          </text>
        </g>
      );
    }
    case 'image':
      return (
        <g {...common}>
          <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill="transparent" />
          <image href={shape.imageId ? imageUrl(shape.imageId) : undefined} x={shape.x} y={shape.y} width={shape.w} height={shape.h} preserveAspectRatio="none" />
          {style.fill === 'soft' && <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} {...strokeProps} />}
        </g>
      );
  }
}

export const ShapeSvg = memo(ShapeSvgImpl);
