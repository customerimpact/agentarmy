import type { DrawColor } from '../../../shared/drawings';

// Drawing colours are theme tokens, so drawings follow the active theme
export function colorVar(color: DrawColor): string {
  return color === 'ink' ? 'var(--aa-fg)' : `var(--aa-project-${color})`;
}

export const softFill = (color: DrawColor) => `color-mix(in srgb, ${colorVar(color)} 16%, transparent)`;
