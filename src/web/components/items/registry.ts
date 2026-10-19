import type { ComponentType } from 'react';
import type { BoardItem, BoardItemKind } from '../../../shared/protocol';

// Renderers for board items (React Flow node type 'item'). ItemNode draws the shared chrome
// (selection ring, resize handles, drag via `.aa-drag-handle`) and renders the registered
// component inside. Register from your own module and import that module once (side effect),
// e.g. in items/index.ts or main.tsx:
//
//   registerItemRenderer('file', FileItem, { label: 'File', minWidth: 320, minHeight: 200 });
//
// The component gets the item and helpers; save kind-specific state with setData (optimistic,
// debounced PATCH /api/items/:id { data }). Put the class `aa-drag-handle` on the element the
// user drags the item by (e.g. a header), and `nodrag` on inputs/buttons inside it.

export interface ItemRendererProps<D = Record<string, unknown>> {
  item: BoardItem & { data: D };
  selected: boolean;
  zoom: number; // current board zoom, for semantic zoom (e.g. hide details below 0.5)
  setData: (data: D) => void; // replace item.data (local now, saved ~400 ms later)
  remove: () => void; // delete the item (no confirm)
}

export interface ItemKindOptions {
  label: string; // shown in menus and the minimap tooltip
  minWidth?: number;
  minHeight?: number;
  frameless?: boolean; // the renderer draws its own card background/border (ItemNode adds only the ring)
}

interface Entry {
  component: ComponentType<ItemRendererProps<any>>;
  options: ItemKindOptions;
}

const renderers = new Map<BoardItemKind, Entry>();
const listeners = new Set<() => void>();

export function registerItemRenderer<D = Record<string, unknown>>(
  kind: BoardItemKind,
  component: ComponentType<ItemRendererProps<D>>,
  options: Partial<ItemKindOptions> = {},
): void {
  renderers.set(kind, { component, options: { label: options.label ?? kind, ...options } });
  for (const listener of listeners) listener();
}

export function getItemRenderer(kind: BoardItemKind): Entry | undefined {
  return renderers.get(kind);
}

// For components that must re-render when a renderer registers late
export function onRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
