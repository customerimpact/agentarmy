import type { Shape } from '../../../shared/drawings';

// Undo / redo for drawings. Each entry is one user action (a stroke, a move, a delete) recorded
// as before/after snapshots per shape; null = the shape did not exist.

export interface ShapeChange {
  id: string;
  before: Shape | null;
  after: Shape | null;
}

export type HistoryEntry = ShapeChange[];

export const MAX_HISTORY = 200;

export class DrawingHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly limit = MAX_HISTORY) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  push(entry: HistoryEntry): void {
    const real = entry.filter((c) => c.before !== c.after);
    if (!real.length) return;
    this.undoStack.push(real);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  // Returns the changes to apply (already inverted) or null when there is nothing to undo
  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return invert(entry);
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export function invert(entry: HistoryEntry): HistoryEntry {
  return [...entry].reverse().map((c) => ({ id: c.id, before: c.after, after: c.before }));
}

// Applies changes to a shape record (returns a new record)
export function applyChanges(shapes: Record<string, Shape>, changes: HistoryEntry): Record<string, Shape> {
  const next = { ...shapes };
  for (const c of changes) {
    if (c.after) next[c.id] = c.after;
    else delete next[c.id];
  }
  return next;
}
