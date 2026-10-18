import type { Template } from './protocol.js';

// Board layout rules shared by the server (template launch) and the UI (project frames).
// A project frame is drawn around its consoles' bounding box, grown by FRAME_PADDING on every
// side plus FRAME_TITLE_HEIGHT on top for the title bar.
export const FRAME_TITLE_HEIGHT = 36;
export const FRAME_PADDING = 20;
export const TEMPLATE_GAP = 40; // between consoles inside a team, and between frames
export const TEAM_COLUMNS = 2; // consoles per row inside a team frame
export const TEAMS_PER_ROW = 3; // team frames per row below the orchestrator

// Placeholders filled in at launch: {name} = console name, {team} = project (frame) name
const worker = (what: string): string =>
  `You are {name}, the ${what} agent in team "{team}". Wait for jobs from the orchestrator ` +
  `(they arrive as messages). Do each job, then report back with the agentarmy report_job tool. ` +
  `Reply "ready" now and wait.`;

const solo = (what: string): string =>
  `You are {name}, the ${what} agent in team "{team}". Reply "ready" and wait for my first task.`;

export const ORCHESTRATOR_PROMPT =
  'You are {name}, the orchestrator. You coordinate the other agents on this board with the ' +
  'agentarmy MCP tools: list_agents (who is there), send_job (give an agent a task), list_jobs ' +
  '(progress), report_job (close your own jobs), request_user_action (ask me for something). ' +
  'Teams: {roster}. Do not write code yourself; split work into jobs. ' +
  'Reply "ready" and wait for my goal.';

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'dev-hq',
    name: 'Dev HQ',
    description: 'Orchestrator + 3 teams of 4: Frontend, Backend, Reviewers (13 agents)',
    orchestrator: true,
    teams: [
      { name: 'Frontend', role: 'Frontend', count: 4, prompt: worker('Frontend') },
      { name: 'Backend', role: 'Backend', count: 4, prompt: worker('Backend') },
      { name: 'Reviewers', role: 'Reviewer', count: 4, prompt: worker('code Reviewer') },
    ],
  },
  {
    id: 'solo-reviewer',
    name: 'Solo + reviewer',
    description: 'One builder and one reviewer who checks its work',
    orchestrator: false,
    teams: [
      { name: 'Builder', role: 'Builder', count: 1, prompt: solo('Builder') },
      {
        name: 'Reviewer',
        role: 'Reviewer',
        count: 1,
        prompt:
          'You are {name}, the Reviewer in team "{team}". When asked, review the latest changes ' +
          '(git diff) for bugs and risks. Reply "ready" and wait.',
      },
    ],
  },
  {
    id: 'bug-squad',
    name: 'Bug squad',
    description: 'Orchestrator + 3 investigators who chase a bug in parallel',
    orchestrator: true,
    teams: [{ name: 'Investigators', role: 'Investigator', count: 3, prompt: worker('bug Investigator') }],
  },
  {
    id: 'full-stack-trio',
    name: 'Full-stack trio',
    description: 'Frontend, backend and tests, one agent each',
    orchestrator: false,
    teams: [
      { name: 'Frontend', role: 'Frontend', count: 1, prompt: solo('Frontend') },
      { name: 'Backend', role: 'Backend', count: 1, prompt: solo('Backend') },
      { name: 'Tests', role: 'Tester', count: 1, prompt: solo('Tests') },
    ],
  },
  {
    id: 'docs-crew',
    name: 'Docs crew',
    description: 'Orchestrator + 2 writers + 1 editor',
    orchestrator: true,
    teams: [
      { name: 'Writers', role: 'Writer', count: 2, prompt: worker('docs Writer') },
      { name: 'Editor', role: 'Editor', count: 1, prompt: worker('docs Editor') },
    ],
  },
  {
    id: 'research-build',
    name: 'Research & build',
    description: 'One researcher explores, two builders implement',
    orchestrator: false,
    teams: [
      {
        name: 'Research',
        role: 'Researcher',
        count: 1,
        prompt:
          'You are {name}, the Researcher in team "{team}". You read code and docs and write ' +
          'findings, you do not edit code. Reply "ready" and wait for a question.',
      },
      { name: 'Builders', role: 'Builder', count: 2, prompt: solo('Builder') },
    ],
  },
];

export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
