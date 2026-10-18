import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerOrchestrationRoutes } from './orchestration-routes.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

async function setup() {
  const ctx = fakeManager([
    fakeConsole('ada', 'idle', { x: 0, y: 0, width: 100, height: 100 }),
    fakeConsole('far', 'idle', { x: 3000, y: 0, width: 100, height: 100 }),
    fakeConsole('bex', 'resting', { x: 300, y: 400, width: 100, height: 100 }),
  ]);
  const app = Fastify();
  await registerOrchestrationRoutes(app, { manager: ctx.manager, port: 1, token: 't' });
  return { ...ctx, app };
}

describe('orchestration routes', () => {
  it('lists bridge tools for a known console only', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/bridge/ada/tools' });
    const names = (res.json().tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_agents', 'send_job', 'report_job', 'list_jobs', 'request_user_action']));
    expect((await app.inject({ method: 'GET', url: '/bridge/nope/tools' })).statusCode).toBe(404);
  });

  it('returns other agents nearest first with board distances', async () => {
    const { app } = await setup();
    const agents = (await app.inject({ method: 'GET', url: '/bridge/ada/agents' })).json();
    expect(agents.map((a: { name: string }) => a.name)).toEqual(['Bex', 'Far']);
    expect(agents[0].distance).toBe(500);
    const text = (await app.inject({ method: 'POST', url: '/bridge/ada/tools/list_agents', payload: {} })).json();
    expect(text.content[0].text).toMatch(/You are Ada[\s\S]*- Bex \[resting\] 500px away/);
  });

  it('runs send_job and report_job end to end through the tool route', async () => {
    const { app, typed, manager } = await setup();
    const sent = await app.inject({
      method: 'POST',
      url: '/bridge/ada/tools/send_job',
      payload: { to: 'bex', title: 'Say pong', message: 'Reply with pong' },
    });
    expect(sent.json().isError).toBeUndefined();
    const job = manager.jobs[0];
    expect(typed[0].id).toBe('bex');
    const reported = await app.inject({
      method: 'POST',
      url: `/bridge/bex/tools/report_job`,
      payload: { job_id: job.id, result: 'pong' },
    });
    expect(reported.json().content[0].text).toMatch(/Reported/);
    expect(typed.at(-1)).toMatchObject({ id: 'ada' });
    const self = await app.inject({
      method: 'POST',
      url: '/bridge/ada/tools/send_job',
      payload: { to: 'ada', title: 't', message: 'm' },
    });
    expect(self.json()).toMatchObject({ isError: true });
    expect((await app.inject({ method: 'POST', url: '/bridge/ada/tools/nope', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).json()).toEqual({ ok: true });
  });

  it('files, resolves and clears action items', async () => {
    const { app } = await setup();
    const item = (
      await app.inject({ method: 'POST', url: '/bridge/ada/actions', payload: { title: 'Need a key' } })
    ).json();
    expect(item).toMatchObject({ kind: 'request', consoleId: 'ada', title: 'Need a key' });
    const patched = await app.inject({ method: 'PATCH', url: `/api/actions/${item.id}`, payload: { resolved: true } });
    expect(patched.json().resolvedBy).toBe('user');
    expect((await app.inject({ method: 'PATCH', url: '/api/actions/x', payload: { resolved: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/actions/clear-resolved' })).json()).toEqual({ removed: 1 });
  });
});
