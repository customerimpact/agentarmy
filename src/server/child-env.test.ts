import { describe, expect, it } from 'vitest';
import { childEnv } from './consoles.js';

describe('childEnv', () => {
  it('hides API keys so consoles use the subscription login', () => {
    const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't' });
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('keeps API keys when AGENTARMY_USE_API_KEY=1', () => {
    const env = childEnv({ ANTHROPIC_API_KEY: 'sk-x', AGENTARMY_USE_API_KEY: '1' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
  });

  it('drops parent Claude session variables and enables task tools', () => {
    const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
  });
});
