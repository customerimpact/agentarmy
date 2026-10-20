import { describe, expect, it } from 'vitest';
import type { Job } from '../shared/protocol.js';
import { JobService, MAX_JOBS, shortJobId } from './jobs.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

function setup() {
  const ctx = fakeManager([fakeConsole('ada'), fakeConsole('bex', 'resting'), fakeConsole('cy', 'suspended')]);
  const events: Job['status'][] = [];
  ctx.manager.on('job', (job) => events.push(job.status));
  return { ...ctx, jobs: new JobService(ctx.manager), events };
}

describe('JobService', () => {
  it('types the job into the target with a header and report instructions', () => {
    const { jobs, typed } = setup();
    const { job } = jobs.send('ada', { to: 'BEX', title: 'Say pong', message: 'Reply with pong.' });
    expect(job).toMatchObject({ fromId: 'ada', toId: 'bex', title: 'Say pong', status: 'sent' });
    expect(typed).toHaveLength(1);
    expect(typed[0].id).toBe('bex');
    expect(typed[0].text).toBe(
      `[GridHive job ${shortJobId(job.id)} from Ada] Say pong\nReply with pong.\n\n` +
        `When finished, call the gridhive report_job tool with job_id "${job.id}" and a short result.`,
    );
  });

  it('refuses itself, unknown, stopped and waiting targets', () => {
    const { jobs, setStatus } = setup();
    expect(() => jobs.send('ada', { to: 'ada', title: 't', message: 'm' })).toThrow(/yourself/);
    expect(() => jobs.send('ada', { to: 'nobody', title: 't', message: 'm' })).toThrow(/No agent called/);
    expect(() => jobs.send('ada', { to: 'cy', title: 't', message: 'm' })).toThrow(/not running/);
    setStatus('bex', 'needs_you', 'Allow Bash?');
    expect(() => jobs.send('ada', { to: 'bex', title: 't', message: 'm' })).toThrow(/waiting on the user/);
    expect(jobs.list()).toHaveLength(0);
  });

  it('still sends to a working agent and says so', () => {
    const { jobs, setStatus } = setup();
    setStatus('bex', 'working');
    expect(jobs.send('ada', { to: 'bex', title: 't', message: 'm' }).targetWasWorking).toBe(true);
  });

  it('goes sent -> working -> done on the target hooks and tells the sender when no report came', () => {
    const { manager, jobs, typed, events } = setup();
    const { job } = jobs.send('ada', { to: 'bex', title: 'Say pong', message: 'm' });
    manager.handleHook('bex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `[GridHive job ${shortJobId(job.id)} from Ada] Say pong`,
    });
    expect(job.status).toBe('working');
    manager.handleHook('bex', { hook_event_name: 'Stop', last_assistant_message: 'pong' });
    expect(job.status).toBe('done');
    expect(job.result).toBeUndefined();
    expect(events).toEqual(['sent', 'working', 'done']);
    expect(typed.at(-1)).toMatchObject({ id: 'ada' });
    expect(typed.at(-1)!.text).toMatch(/without calling report_job.*pong/);
  });

  it('matches the job named in the prompt when several are waiting', () => {
    const { manager, jobs } = setup();
    const first = jobs.send('ada', { to: 'bex', title: 'one', message: 'm' }).job;
    const second = jobs.send('ada', { to: 'bex', title: 'two', message: 'm' }).job;
    manager.handleHook('bex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `[GridHive job ${shortJobId(second.id)} from Ada] two`,
    });
    expect(first.status).toBe('sent');
    expect(second.status).toBe('working');
  });

  it('report_job stores the result, notifies the sender, and a later Stop changes nothing', () => {
    const { manager, jobs, typed } = setup();
    const { job } = jobs.send('ada', { to: 'bex', title: 'Say pong', message: 'm' });
    manager.handleHook('bex', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    expect(() => jobs.report('ada', job.id, { result: 'nope' })).toThrow(/Only the agent/);
    jobs.report('bex', shortJobId(job.id), { result: 'pong' });
    expect(job).toMatchObject({ status: 'done', result: 'pong' });
    expect(typed.at(-1)).toEqual({
      id: 'ada',
      text: `[GridHive] Bex finished "Say pong" (job ${shortJobId(job.id)}): pong`,
    });
    const count = typed.length;
    manager.handleHook('bex', { hook_event_name: 'Stop' });
    expect(typed).toHaveLength(count);
  });

  it('truncates long results in the note to the sender', () => {
    const { jobs, typed } = setup();
    const { job } = jobs.send('ada', { to: 'bex', title: 't', message: 'm' });
    jobs.report('bex', job.id, { result: 'x'.repeat(5000), status: 'failed' });
    expect(job.status).toBe('failed');
    expect(typed.at(-1)!.text.length).toBeLessThan(1700);
    expect(typed.at(-1)!.text).toContain('could not finish');
  });

  it('holds the note while the sender waits on a permission prompt', () => {
    const { jobs, typed, setStatus } = setup();
    const { job } = jobs.send('ada', { to: 'bex', title: 't', message: 'm' });
    setStatus('ada', 'needs_you');
    jobs.report('bex', job.id, { result: 'ok' });
    expect(typed.filter((t) => t.id === 'ada')).toHaveLength(0);
    setStatus('ada', 'working');
    expect(typed.filter((t) => t.id === 'ada')).toHaveLength(1);
  });

  it('fails working jobs on StopFailure and open jobs when the target is removed', () => {
    const { manager, jobs } = setup();
    const a = jobs.send('ada', { to: 'bex', title: 'a', message: 'm' }).job;
    manager.handleHook('bex', { hook_event_name: 'UserPromptSubmit' });
    manager.handleHook('bex', { hook_event_name: 'StopFailure', error: 'rate_limit' });
    expect(a).toMatchObject({ status: 'failed', result: 'rate_limit' });
    const b = jobs.send('ada', { to: 'bex', title: 'b', message: 'm' }).job;
    manager.remove('bex');
    expect(b.status).toBe('failed');
  });

  it('deletes jobs and caps the list by dropping the oldest finished ones', () => {
    const { manager, jobs } = setup();
    const removed: string[] = [];
    manager.on('job-removed', (id) => removed.push(id));
    for (let i = 0; i < MAX_JOBS; i++) {
      manager.jobs.push({
        id: `old-${i}`, fromId: 'ada', toId: 'bex', title: 't', message: 'm',
        status: i === 0 ? 'working' : 'done', createdAt: i, updatedAt: i,
      });
    }
    jobs.send('ada', { to: 'bex', title: 'new', message: 'm' });
    expect(manager.jobs).toHaveLength(MAX_JOBS);
    expect(removed).toEqual(['old-1']);
    expect(manager.jobs[0].id).toBe('old-0');
    expect(jobs.remove('old-0')).toBe(true);
    expect(jobs.remove('old-0')).toBe(false);
  });
});
