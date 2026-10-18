import { describe, expect, it } from 'vitest';
import { ActionInbox, MAX_RESOLVED_ACTIONS } from './actions.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

function setup() {
  const ctx = fakeManager([fakeConsole('ada'), fakeConsole('bex')]);
  return { ...ctx, inbox: new ActionInbox(ctx.manager) };
}

describe('ActionInbox', () => {
  it('opens one needs_you item per wait and resolves it when the console moves on', () => {
    const { manager, setStatus } = setup();
    setStatus('ada', 'needs_you', 'Allow Bash?');
    setStatus('ada', 'needs_you', 'Allow Bash?');
    expect(manager.actions).toHaveLength(1);
    expect(manager.actions[0]).toMatchObject({
      consoleId: 'ada', kind: 'needs_you', title: 'Ada needs you', detail: 'Allow Bash?',
    });
    setStatus('ada', 'working');
    expect(manager.actions[0]).toMatchObject({ resolvedBy: 'auto' });
    expect(manager.actions[0].resolvedAt).toBeGreaterThan(0);
    setStatus('ada', 'needs_you', 'Again');
    expect(manager.actions).toHaveLength(2);
  });

  it('opens an error item that resolves once the console works again', () => {
    const { manager, setStatus } = setup();
    setStatus('bex', 'error', 'API Error');
    setStatus('bex', 'resting');
    expect(manager.actions[0]).toMatchObject({ kind: 'error', detail: 'API Error' });
    expect(manager.actions[0].resolvedAt).toBeUndefined();
    setStatus('bex', 'working');
    expect(manager.actions[0].resolvedBy).toBe('auto');
  });

  it('resolves open items when the console is removed', () => {
    const { manager, setStatus } = setup();
    setStatus('bex', 'needs_you');
    manager.remove('bex');
    expect(manager.actions[0].resolvedBy).toBe('auto');
  });

  it('files agent requests that only the user resolves, and can reopen and clear them', () => {
    const { manager, inbox, setStatus } = setup();
    const removed: string[][] = [];
    manager.on('actions-removed', (ids) => removed.push(ids));
    const item = inbox.request('ada', 'Need the Stripe key', 'test mode');
    setStatus('ada', 'working');
    expect(item.resolvedAt).toBeUndefined();
    inbox.setResolved(item.id, true);
    expect(item.resolvedBy).toBe('user');
    inbox.setResolved(item.id, false);
    expect(item.resolvedAt).toBeUndefined();
    inbox.setResolved(item.id, true);
    expect(inbox.clearResolved()).toBe(1);
    expect(manager.actions).toHaveLength(0);
    expect(removed).toEqual([[item.id]]);
    expect(() => inbox.setResolved('missing', true)).toThrow(/Unknown action/);
  });

  it('keeps at most MAX_RESOLVED_ACTIONS resolved items', () => {
    const { manager, inbox } = setup();
    for (let i = 0; i < MAX_RESOLVED_ACTIONS + 5; i++) {
      inbox.setResolved(inbox.request('ada', `r${i}`).id, true);
    }
    expect(manager.actions.filter((a) => a.resolvedAt)).toHaveLength(MAX_RESOLVED_ACTIONS);
    expect(manager.actions[0].title).toBe('r5');
  });
});
