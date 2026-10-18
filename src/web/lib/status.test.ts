import { describe, expect, it } from 'vitest';
import { modelShortName } from './status';

describe('modelShortName', () => {
  it('shortens Claude model ids', () => {
    expect(modelShortName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelShortName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelShortName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(modelShortName('claude-opus-4')).toBe('Opus 4');
    expect(modelShortName('claude-opus-5-5[1m]')).toBe('Opus 5.5');
  });
  it('passes unknown ids through and handles empty', () => {
    expect(modelShortName('gpt-5')).toBe('gpt-5');
    expect(modelShortName(undefined)).toBeNull();
  });
});
