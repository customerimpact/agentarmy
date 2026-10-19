import { lazy, Suspense } from 'react';

// The drawing layer (tools, gestures, rail) loads as its own chunk right after the board, so it
// adds nothing to the main bundle; drawings appear a moment after the consoles.
const Layer = lazy(() => import('./DrawingLayer').then((m) => ({ default: m.DrawingLayer })));

export function DrawingLayer() {
  return (
    <Suspense fallback={null}>
      <Layer />
    </Suspense>
  );
}
