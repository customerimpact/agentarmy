import { describe, expect, it } from 'vitest';
import { parseTeamMention } from './team-mention';

const projects = [
  { id: 'fe', name: 'Frontend' },
  { id: 'hq', name: 'Dev HQ' },
  { id: 'hqfe', name: 'Dev HQ · Frontend' },
  { id: 'ada', name: 'Ada' },
];

describe('parseTeamMention', () => {
  it('reads @team:<name> and @<name>', () => {
    expect(parseTeamMention('@team:Frontend fix the header', projects)).toEqual({ projectId: 'fe', rest: 'fix the header' });
    expect(parseTeamMention('@frontend  fix it', projects)).toEqual({ projectId: 'fe', rest: 'fix it' });
    expect(parseTeamMention('@Frontend', projects)).toEqual({ projectId: 'fe', rest: '' });
  });

  it('prefers the longest name and accepts quotes', () => {
    expect(parseTeamMention('@Dev HQ · Frontend ship it', projects)?.projectId).toBe('hqfe');
    expect(parseTeamMention('@Dev HQ ship it', projects)?.projectId).toBe('hq');
    expect(parseTeamMention('@team:"Dev HQ" go', projects)).toEqual({ projectId: 'hq', rest: 'go' });
  });

  it('needs a word boundary and an @ at the start', () => {
    expect(parseTeamMention('@Frontends go', projects)).toBeNull();
    expect(parseTeamMention('hello @Frontend', projects)).toBeNull();
    expect(parseTeamMention('@team:Nobody go', projects)).toBeNull();
  });

  it('lets a console with the same name win unless team: is explicit', () => {
    expect(parseTeamMention('@Ada hi', projects, ['Ada'])).toBeNull();
    expect(parseTeamMention('@team:Ada hi', projects, ['Ada'])?.projectId).toBe('ada');
  });
});
