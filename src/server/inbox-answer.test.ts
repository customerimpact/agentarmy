import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActionItem } from '../shared/protocol.js';
import { registerOrchestrationRoutes } from './orchestration-routes.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';
import type { ParsedDialog } from './prompt-detector.js';

const PERMISSION: ParsedDialog = {
  question: 'Do you want to proceed?',
  options: [
    { key: '1', label: 'Yes' },
    { key: '2', label: "Yes, and don't ask again" },
    { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
  ],
  allowText: true,
  textKey: '3',
  context: ['Bash command', 'npm test'],
};

async function setup(dialog: ParsedDialog | null = PERMISSION) {
  const ctx = fakeManager([fakeConsole('ada', 'working'), fakeConsole('bex', 'idle')]);
  let current = dialog;
  ctx.manager.dialogFor = vi.fn(() => current);
  const answers: Array<{ id: string; key?: string; text?: string }> = [];
  ctx.manager.answerPrompt = vi.fn((id: string, answer: { key?: string; text?: string }) => {
    answers.push({ id, ...answer });
    return true;
  });
  const app = Fastify();
  await registerOrchestrationRoutes(app, {
    manager: ctx.manager,
    port: 1,
    token: 't',
    stuckSettings: () => ({ stuckAlerts: false, stallMinutes: 5, longTurnMinutes: 20 }),
  });
  const setDialog = (d: ParsedDialog | null): void => {
    current = d;
    ctx.manager.emit('dialog', 'ada');
  };
  return { ...ctx, app, answers, setDialog };
}

const openItem = (actions: ActionItem[]) => actions.find((a) => a.kind === 'needs_you' && !a.resolvedAt)!;

describe('answering from the inbox', () => {
  it('copies the dialog on screen onto the needs_you item and keeps it fresh', async () => {
    const { manager, setStatus, setDialog } = await setup(null);
    setStatus('ada', 'needs_you', 'Claude needs your permission to use Bash');
    expect(openItem(manager.actions).options).toBeUndefined();
    setDialog(PERMISSION);
    expect(openItem(manager.actions)).toMatchObject({
      question: 'Do you want to proceed?',
      allowText: true,
      context: ['Bash command', 'npm test'],
      options: [{ key: '1', label: 'Yes' }, { key: '2' }, { key: '3' }],
    });
  });

  it('POST /api/actions/:id/answer presses the option key; the item resolves when the console moves on', async () => {
    const { app, manager, setStatus, answers } = await setup();
    setStatus('ada', 'needs_you', 'Permission');
    const item = openItem(manager.actions);
    const res = await app.inject({ method: 'POST', url: `/api/actions/${item.id}/answer`, payload: { key: '1' } });
    expect(res.statusCode).toBe(200);
    expect(answers).toEqual([{ id: 'ada', key: '1' }]);
    expect(item.resolvedAt).toBeUndefined();
    setStatus('ada', 'working');
    expect(item.resolvedBy).toBe('auto');
  });

  it('a typed answer presses the dialog\'s text option first, then types the text', async () => {
    const { app, manager, setStatus, answers } = await setup();
    setStatus('ada', 'needs_you');
    const item = openItem(manager.actions);
    const res = await app.inject({
      method: 'POST',
      url: `/api/actions/${item.id}/answer`,
      payload: { text: '  Use pnpm instead  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(answers).toEqual([{ id: 'ada', key: '3', text: 'Use pnpm instead' }]);
  });

  it('rejects unknown keys, empty bodies, resolved items and unknown ids', async () => {
    const { app, manager, setStatus, answers } = await setup();
    setStatus('ada', 'needs_you');
    const item = openItem(manager.actions);
    const post = (id: string, payload: unknown) =>
      app.inject({ method: 'POST', url: `/api/actions/${id}/answer`, payload: payload as object });
    expect((await post(item.id, { key: '7' })).statusCode).toBe(400);
    expect((await post(item.id, {})).statusCode).toBe(400);
    expect((await post(item.id, { key: 5 })).statusCode).toBe(400);
    expect((await post('missing', { key: '1' })).statusCode).toBe(404);
    setStatus('ada', 'resting');
    expect((await post(item.id, { key: '1' })).statusCode).toBe(400);
    expect(answers).toEqual([]);
  });

  it('refuses a typed answer when the dialog only offers fixed choices', async () => {
    const { app, manager, setStatus } = await setup({ ...PERMISSION, allowText: false, textKey: undefined });
    setStatus('ada', 'needs_you');
    const res = await app.inject({
      method: 'POST',
      url: `/api/actions/${openItem(manager.actions).id}/answer`,
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a console that is not running', async () => {
    const { app, manager, setStatus } = await setup();
    manager.answerPrompt = vi.fn(() => false);
    setStatus('ada', 'needs_you');
    const res = await app.inject({
      method: 'POST',
      url: `/api/actions/${openItem(manager.actions).id}/answer`,
      payload: { key: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not running/);
  });
});
