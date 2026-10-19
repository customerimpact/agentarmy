import type { Project } from '../../shared/protocol';

export interface TeamMention {
  projectId: string;
  rest: string; // the message without the mention
}

// "@team:Frontend fix the header", "@Frontend fix the header" or '@team:"Dev HQ · Frontend" ...'
// at the start of the text. The longest project name wins; a plain "@name" yields to a console
// of the same name (consoleNames) so "@Ada" still means the agent.
export function parseTeamMention(
  text: string,
  projects: Pick<Project, 'id' | 'name'>[],
  consoleNames: string[] = [],
): TeamMention | null {
  const m = /^\s*@(team:)?/i.exec(text);
  if (!m) return null;
  const explicit = !!m[1];
  let body = text.slice(m[0].length);

  const quoted = /^"([^"]+)"(\s+|$)/.exec(body);
  if (quoted) {
    const name = quoted[1].trim().toLowerCase();
    const project = projects.find((p) => p.name.trim().toLowerCase() === name);
    return project ? { projectId: project.id, rest: body.slice(quoted[0].length).trim() } : null;
  }

  const lower = body.toLowerCase();
  let best: Pick<Project, 'id' | 'name'> | null = null;
  for (const p of projects) {
    const name = p.name.trim().toLowerCase();
    if (!name || !lower.startsWith(name)) continue;
    const next = body.charAt(name.length);
    if (next && !/\s/.test(next)) continue;
    if (!best || name.length > best.name.trim().length) best = p;
  }
  if (!best) return null;
  const nameLength = best.name.trim().length;
  if (!explicit && consoleNames.some((n) => n.trim().toLowerCase() === best.name.trim().toLowerCase())) return null;
  body = body.slice(nameLength);
  return { projectId: best.id, rest: body.trim() };
}
