import { ViewportPortal } from '@xyflow/react';
import { useBoardUi } from '../lib/board-ui';

const GUIDE_COLOR = '#ff7a45';

// Thin orange lines that show what a dragged or resized node is snapping to
export function AlignmentGuides() {
  const guides = useBoardUi((s) => s.guides);
  if (!guides.length) return null;
  return (
    <ViewportPortal>
      <svg
        data-testid="alignment-guides"
        width={1}
        height={1}
        style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 2000 }}
      >
        {guides.map((g, i) => {
          const gap = g.kind === 'gap';
          const vertical = g.x1 === g.x2;
          return (
            <g key={i} stroke={GUIDE_COLOR} opacity={0.9}>
              <line
                x1={g.x1}
                y1={g.y1}
                x2={g.x2}
                y2={g.y2}
                strokeWidth={1}
                strokeDasharray={gap ? '3 3' : undefined}
                vectorEffect="non-scaling-stroke"
              />
              {gap &&
                [
                  [g.x1, g.y1],
                  [g.x2, g.y2],
                ].map(([x, y], j) => (
                  <line
                    key={j}
                    x1={vertical ? x - 6 : x}
                    y1={vertical ? y : y - 6}
                    x2={vertical ? x + 6 : x}
                    y2={vertical ? y : y + 6}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
