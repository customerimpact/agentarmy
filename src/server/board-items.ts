import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  BOARD_ITEM_KINDS,
  type BoardItem,
  type BoardItemKind,
  type ConsoleLayout,
  type CreateItemRequest,
  type KanbanCard,
  type KanbanData,
  type UpdateItemRequest,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';
import { BadRequestError, isProjectColor } from './projects.js';
import { findFreeSlot } from './placement.js';

// Board items: notes, checklists, kanban boards and (agent D) file viewers. The server only
// validates the envelope; `data` is owned by each kind's renderer in the UI, except the kanban
// fields the server maintains itself (assignment + "agent finished").

export const MAX_ITEM_DATA_BYTES = 256 * 1024;

export const DEFAULT_ITEM_SIZE: Record<BoardItemKind, { width: number; height: number }> = {
  note: { width: 280, height: 220 },
  checklist: { width: 320, height: 340 },
  kanban: { width: 780, height: 440 },
  file: { width: 560, height: 420 },
};

export function isItemKind(value: unknown): value is BoardItemKind {
  return typeof value === 'string' && (BOARD_ITEM_KINDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkLayout(raw: unknown): Partial<ConsoleLayout> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new BadRequestError('layout must be an object');
  const out: Partial<ConsoleLayout> = {};
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestError(`layout.${key} must be a number`);
    if ((key === 'width' || key === 'height') && (v < 40 || v > 10_000)) {
      throw new BadRequestError(`layout.${key} must be between 40 and 10000`);
    }
    out[key] = v;
  }
  return out;
}

function checkData(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new BadRequestError('data must be an object');
  if (JSON.stringify(raw).length > MAX_ITEM_DATA_BYTES) throw new BadRequestError('data is too large');
  return raw;
}

export function defaultItemData(kind: BoardItemKind): Record<string, unknown> {
  switch (kind) {
    case 'note':
      return { text: '' };
    case 'checklist':
      return { title: 'Checklist', entries: [] };
    case 'kanban':
      return {
        title: 'Kanban',
        columns: [
          { id: 'todo', title: 'To do', cards: [] },
          { id: 'doing', title: 'Doing', cards: [] },
          { id: 'done', title: 'Done', cards: [] },
        ],
      } satisfies KanbanData;
    default:
      return {};
  }
}

function kanbanColumns(item: BoardItem): KanbanData['columns'] {
  const columns = (item.data as Partial<KanbanData>).columns;
  return Array.isArray(columns) ? columns.filter((c) => c && Array.isArray(c.cards)) : [];
}

// The prompt a kanban card becomes when it is assigned to an agent
export function cardPrompt(card: Pick<KanbanCard, 'title' | 'description'>): string {
  const description = card.description?.trim();
  return description ? `${card.title.trim()}\n\n${description}` : card.title.trim();
}

export class ItemService {
  constructor(private readonly manager: ConsoleManager) {
    // Kanban: a card assigned to an agent gets "agent finished" once that agent's turn ends
    manager.on('console', (info) => {
      if (info.status !== 'resting' && info.status !== 'idle') return;
      for (const item of manager.items) {
        if (item.kind !== 'kanban') continue;
        let touched = false;
        for (const column of kanbanColumns(item)) {
          for (const card of column.cards) {
            if (card.assignedConsoleId !== info.id || card.finishedAt || !card.assignedAt) continue;
            if (info.statusChangedAt <= card.assignedAt) continue;
            card.finishedAt = info.statusChangedAt;
            touched = true;
          }
        }
        if (touched) this.changed(item);
      }
    });
  }

  get(id: string): BoardItem {
    const item = this.manager.items.find((i) => i.id === id);
    if (!item) throw new NotFoundError(`Unknown item ${id}`);
    return item;
  }

  create(req: CreateItemRequest): BoardItem {
    if (!isPlainObject(req)) throw new BadRequestError('body must be an object');
    if (!isItemKind(req.kind)) throw new BadRequestError(`kind must be one of ${BOARD_ITEM_KINDS.join(', ')}`);
    if (req.color !== undefined && !isProjectColor(req.color)) throw new BadRequestError('invalid color');
    if (req.workspaceId !== undefined && typeof req.workspaceId !== 'string') {
      throw new BadRequestError('workspaceId must be a string');
    }
    const workspaceId = this.manager.workspaceFor(req.workspaceId);
    const layout = checkLayout(req.layout);
    const size = {
      width: layout.width ?? DEFAULT_ITEM_SIZE[req.kind].width,
      height: layout.height ?? DEFAULT_ITEM_SIZE[req.kind].height,
    };
    const placed =
      layout.x !== undefined && layout.y !== undefined
        ? { x: layout.x, y: layout.y, ...size }
        : findFreeSlot(this.layoutsIn(workspaceId), size);
    const now = Date.now();
    const item: BoardItem = {
      id: `i-${crypto.randomUUID().slice(0, 8)}`,
      kind: req.kind,
      workspaceId,
      layout: placed,
      ...(req.color ? { color: req.color } : {}),
      data: req.data === undefined ? defaultItemData(req.kind) : checkData(req.data),
      createdAt: now,
      updatedAt: now,
    };
    this.manager.items.push(item);
    this.changed(item);
    return item;
  }

  update(id: string, req: UpdateItemRequest): BoardItem {
    const item = this.get(id);
    if (!isPlainObject(req)) throw new BadRequestError('body must be an object');
    const layout = checkLayout(req.layout);
    if (req.color !== undefined && !isProjectColor(req.color)) throw new BadRequestError('invalid color');
    const data = req.data === undefined ? undefined : checkData(req.data);
    item.layout = { ...item.layout, ...layout };
    if (req.color !== undefined) item.color = req.color;
    if (data) item.data = data;
    this.changed(item);
    return item;
  }

  remove(id: string): void {
    const item = this.get(id);
    this.manager.items.splice(this.manager.items.indexOf(item), 1);
    this.manager.emit('item-removed', id);
    this.manager.persist();
  }

  // Types the card into the console as a prompt and moves it to "Doing"
  assignCard(id: string, cardId: string, consoleId: string): BoardItem {
    const item = this.get(id);
    if (item.kind !== 'kanban') throw new BadRequestError('item is not a kanban board');
    const columns = kanbanColumns(item);
    const from = columns.find((c) => c.cards.some((card) => card.id === cardId));
    if (!from) throw new NotFoundError(`Unknown card ${cardId}`);
    const card = from.cards.find((c) => c.id === cardId)!;
    if (!this.manager.get(consoleId)) throw new NotFoundError(`Unknown console ${consoleId}`);
    if (!card.title?.trim()) throw new BadRequestError('card has no title');
    if (!this.manager.sendText(consoleId, cardPrompt(card))) {
      throw new BadRequestError('Console is not running');
    }
    card.assignedConsoleId = consoleId;
    card.assignedAt = Date.now();
    delete card.finishedAt;
    const doing =
      columns.find((c) => /^(doing|in progress|wip)$/i.test(c.title.trim())) ?? columns[1] ?? from;
    if (doing !== from) {
      from.cards = from.cards.filter((c) => c !== card);
      doing.cards.unshift(card);
    }
    this.changed(item);
    return item;
  }

  private layoutsIn(workspaceId: string): ConsoleLayout[] {
    return [
      ...this.manager.list().filter((c) => c.workspaceId === workspaceId).map((c) => c.layout),
      ...this.manager.browsers.filter((b) => b.workspaceId === workspaceId).map((b) => b.layout),
      ...this.manager.items.filter((i) => i.workspaceId === workspaceId).map((i) => i.layout),
    ];
  }

  private changed(item: BoardItem): void {
    item.updatedAt = Date.now();
    this.manager.emit('item', item);
    this.manager.persist();
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof NotFoundError ? 404 : 400).send({ error: message });
}

// POST /api/items, PATCH/DELETE /api/items/:id, POST /api/items/:id/cards/:cardId/assign
export function registerItemRoutes(app: FastifyInstance, options: { manager: ConsoleManager }): ItemService {
  const items = new ItemService(options.manager);

  app.post('/api/items', async (request, reply) => {
    try {
      return items.create((request.body ?? {}) as CreateItemRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return items.update(id, (request.body ?? {}) as UpdateItemRequest);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      items.remove(id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/items/:id/cards/:cardId/assign', async (request, reply) => {
    const { id, cardId } = request.params as { id: string; cardId: string };
    const consoleId = (request.body as { consoleId?: unknown } | undefined)?.consoleId;
    if (typeof consoleId !== 'string' || !consoleId) return reply.code(400).send({ error: 'consoleId is required' });
    try {
      return items.assignCard(id, cardId, consoleId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return items;
}
