import { useEffect, useState } from 'react';
import { LaunchOnButton, TemplateCardAgents, TemplateRunStep, useLaunchBlocked } from './TemplateRunStep';
import { buildTemplateLaunch, defaultChoice, loadChoice, saveChoice, type RunChoice } from '../lib/agent-choice';
import { useLoadProviders } from './ProviderPicker';
import type { ProviderKind } from '../lib/provider-readiness';
import { useReactFlow } from '@xyflow/react';
import { ArrowLeft, Link2, LayoutTemplate, LoaderCircle, Rocket, Users } from 'lucide-react';
import { PROJECT_COLORS, type Template } from '../../shared/protocol';
import {
  BUILTIN_TEMPLATES,
  FRAME_PADDING,
  FRAME_TITLE_HEIGHT,
  TEAM_COLUMNS,
  TEAMS_PER_ROW,
  TEMPLATE_GAP,
} from '../../shared/templates';
import { api } from '../lib/api';
import { DEFAULT_SIZE } from '../lib/board-actions';
import { getRecentFolders, rememberRecentFolder } from '../lib/recent-folders';
import { basename, projectColorVar } from '../lib/status';
import { useBoard } from '../lib/store';
import { FolderPicker } from './FolderPicker';
import { Modal } from './Modal';
import { WorktreeToggle } from './WorktreeToggle';
import { AccountPicker } from './settings/AccountsSettings';
import { CustomTemplateTag, ScratchTemplateCard } from './ComposerDialog';
import { useLoops } from '../lib/loops';
import { ImportRecipePanel, ShareRecipePanel, ShareTemplateButton } from './RecipePanels';

export function agentCount(t: Pick<Template, 'orchestrator' | 'teams'>): number {
  return (t.orchestrator ? 1 : 0) + t.teams.reduce((sum, team) => sum + team.count, 0);
}

// Same arithmetic as the server's layoutTemplate, to find room for the whole layout
function layoutSize(t: Pick<Template, 'orchestrator' | 'teams'>): { width: number; height: number } {
  const team = (count: number) => {
    const cols = Math.min(TEAM_COLUMNS, Math.max(count, 1));
    const rows = Math.ceil(Math.max(count, 1) / TEAM_COLUMNS);
    return {
      width: cols * DEFAULT_SIZE.width + (cols - 1) * TEMPLATE_GAP + 2 * FRAME_PADDING,
      height:
        FRAME_TITLE_HEIGHT +
        rows * DEFAULT_SIZE.height +
        (rows - 1) * TEMPLATE_GAP +
        2 * FRAME_PADDING,
    };
  };
  const sizes = t.teams.map((x) => team(x.count));
  let width: number = DEFAULT_SIZE.width;
  let height = t.orchestrator ? DEFAULT_SIZE.height + TEMPLATE_GAP * 2 : 0;
  for (let i = 0; i < sizes.length; i += TEAMS_PER_ROW) {
    const row = sizes.slice(i, i + TEAMS_PER_ROW);
    width = Math.max(width, row.reduce((s, r) => s + r.width, 0) + (row.length - 1) * TEMPLATE_GAP);
    height += Math.max(...row.map((r) => r.height)) + TEMPLATE_GAP;
  }
  return { width, height };
}

const teamColor = (index: number) => projectColorVar(PROJECT_COLORS[(index + 1) % PROJECT_COLORS.length]);

// Mini schematic: orchestrator dot on top wired to team boxes with one cell per agent
export function TemplateSchematic({ template }: { template: Template }) {
  const W = 240;
  const H = 120;
  const teams = template.teams;
  const n = Math.max(teams.length, 1);
  const gap = 10;
  const boxW = Math.min(70, (W - 20 - gap * (n - 1)) / n);
  const startX = (W - (boxW * n + gap * (n - 1))) / 2;
  const boxY = template.orchestrator ? 58 : 34;
  const orch = { x: W / 2, y: 20 };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" aria-hidden>
      {teams.map((team, i) => {
        const x = startX + i * (boxW + gap);
        const cols = Math.min(TEAM_COLUMNS, Math.max(team.count, 1));
        const rows = Math.ceil(team.count / TEAM_COLUMNS);
        const cellGap = 4;
        const cellW = (boxW - 12 - (cols - 1) * cellGap) / cols;
        const cellH = Math.min(14, (40 - (rows - 1) * cellGap) / rows);
        const boxH = 18 + rows * cellH + (rows - 1) * cellGap + 6;
        const color = teamColor(i);
        return (
          <g key={team.name}>
            {template.orchestrator && (
              <path
                className="aa-flow"
                d={`M${orch.x},${orch.y + 6} C${orch.x},${orch.y + 26} ${x + boxW / 2},${boxY - 22} ${x + boxW / 2},${boxY}`}
                fill="none"
                stroke="var(--aa-accent)"
                strokeOpacity={0.55}
                strokeWidth={1.2}
              />
            )}
            {!template.orchestrator && i > 0 && (
              <path
                className="aa-flow"
                d={`M${x - gap},${boxY + boxH / 2} L${x},${boxY + boxH / 2}`}
                stroke="var(--aa-accent)"
                strokeOpacity={0.5}
                strokeWidth={1.2}
              />
            )}
            <rect
              x={x}
              y={boxY}
              width={boxW}
              height={boxH}
              rx={6}
              fill={`color-mix(in srgb, ${color} 8%, transparent)`}
              stroke={color}
              strokeOpacity={0.6}
            />
            <text
              x={x + 6}
              y={boxY + 11}
              fontSize={7}
              fontFamily="var(--font-mono)"
              letterSpacing={0.6}
              fill={color}
            >
              {team.name.toUpperCase().slice(0, Math.max(3, Math.floor(boxW / 5.2)))}
            </text>
            {Array.from({ length: team.count }, (_, k) => (
              <rect
                key={k}
                x={x + 6 + (k % TEAM_COLUMNS) * (cellW + cellGap)}
                y={boxY + 17 + Math.floor(k / TEAM_COLUMNS) * (cellH + cellGap)}
                width={cellW}
                height={cellH}
                rx={2.5}
                fill="var(--aa-surface-2)"
                stroke="var(--aa-line-strong)"
              />
            ))}
          </g>
        );
      })}
      {template.orchestrator && (
        <g>
          <circle cx={orch.x} cy={orch.y} r={13} fill="var(--aa-accent)" opacity={0.18} />
          <circle cx={orch.x} cy={orch.y} r={6.5} fill="var(--aa-accent)" />
          <circle cx={orch.x} cy={orch.y} r={2.4} fill="var(--aa-accent-fg)" />
        </g>
      )}
    </svg>
  );
}

export function TemplatesDialog() {
  const close = () => useBoard.getState().setTemplatesOpen(false);
  const flow = useReactFlow();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Template | null>(null);
  // Share a template as a link, or import one from a link (opened from gridhive.dev/r or the app link)
  const [sharing, setSharing] = useState<Template | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const pendingImport = useBoard((s) => s.recipeImport);
  useEffect(() => {
    if (pendingImport === null) return;
    setChosen(null);
    setSharing(null);
    setImporting(pendingImport);
    useBoard.setState({ recipeImport: null });
  }, [pendingImport]);
  const [cwd, setCwd] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [accountId, setAccountId] = useState('auto');
  const [run, setRun] = useState<RunChoice>(defaultChoice);
  // Remembered "Run on" per template, re-read when the gallery reopens
  const [remembered, setRemembered] = useState<Record<string, RunChoice>>({});
  useLoadProviders();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startFolder] = useState(() => getRecentFolders()[0]);
  const blocked = useLaunchBlocked(chosen, run);

  useEffect(() => {
    let cancelled = false;
    api
      .listTemplates()
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setRemembered(Object.fromEntries(list.flatMap((t) => {
          const c = loadChoice(t.id);
          return c ? [[t.id, c]] : [];
        })));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // Older server without /api/templates: show the built-in set so the gallery still works
        if (BUILTIN_TEMPLATES.length) setTemplates(BUILTIN_TEMPLATES);
        else setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choiceFor = (t: Template): RunChoice => remembered[t.id] ?? loadChoice(t.id) ?? defaultChoice();
  const choose = (t: Template, runOn?: ProviderKind) => {
    setChosen(t);
    const base = choiceFor(t);
    setRun(runOn ? { ...base, runOn } : base);
    setProjectName(t.name);
    setError(null);
  };

  // Top-left of the visible board if the layout fits there, else to the right of everything
  const pickOrigin = (t: Template): { x: number; y: number } => {
    const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
    const zoom = flow.getViewport().zoom || 1;
    const topLeft = rect
      ? flow.screenToFlowPosition({ x: rect.left + 48, y: rect.top + 64 })
      : { x: 0, y: 0 };
    const size = layoutSize(t);
    const existing = Object.values(useBoard.getState().consoles).map((c) => c.layout);
    const hits = existing.some(
      (e) =>
        e.x < topLeft.x + size.width &&
        e.x + e.width > topLeft.x &&
        e.y < topLeft.y + size.height &&
        e.y + e.height > topLeft.y,
    );
    if (!hits) return { x: Math.round(topLeft.x), y: Math.round(topLeft.y) };
    const right = Math.max(...existing.map((e) => e.x + e.width));
    const top = Math.min(...existing.map((e) => e.y));
    return { x: Math.round(right + 160 / zoom + 120), y: Math.round(top) };
  };

  const launch = async () => {
    if (!chosen || !cwd || launching || blocked) return;
    setLaunching(true);
    setError(null);
    try {
      const result = await api.launchTemplate(
        chosen.id,
        buildTemplateLaunch(chosen, run, {
          cwd,
          projectName: projectName.trim() || undefined,
          origin: pickOrigin(chosen),
          ...(isolated ? { worktrees: true } : {}),
          ...(accountId !== 'auto' ? { accountId } : {}),
        }),
      );
      saveChoice(chosen.id, run);
      setRemembered((m) => ({ ...m, [chosen.id]: run }));
      const store = useBoard.getState();
      for (const project of result.projects) store.upsertProject(project);
      for (const c of result.consoles) store.upsertConsole(c);
      rememberRecentFolder(cwd);
      close();
      const ids = result.consoles.map((c) => ({ id: c.id }));
      // Let React Flow mount and measure the new nodes first
      window.setTimeout(() => {
        void flow.fitView({ nodes: ids, duration: 500, padding: 0.08, maxZoom: 1 });
      }, 120);
      store.toast(`Launched ${chosen.name}: ${result.consoles.length} agents`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Modal
      title="Templates"
      onClose={close}
      width={chosen || sharing || importing !== null ? 'max-w-3xl' : 'max-w-4xl'}
      testId="templates-dialog"
    >
      <div className="aa-card-glow flex items-center gap-3 border-b border-line px-5 pt-4 pb-3">
        {chosen || sharing || importing !== null ? (
          <button
            type="button"
            aria-label="Back to templates"
            onClick={() => {
              setChosen(null);
              setSharing(null);
              setImporting(null);
            }}
            className="grid size-7 place-items-center rounded-lg text-fg-muted
                       hover:bg-hover hover:text-fg"
          >
            <ArrowLeft size={15} />
          </button>
        ) : (
          <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent">
            <LayoutTemplate size={15} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">
            {chosen ? chosen.name : sharing ? `Share ${sharing.name}` : importing !== null ? 'Import a recipe' : 'Start from a template'}
          </h2>
          <p className="mt-0.5 truncate text-fg-muted">
            {chosen
              ? 'Pick the project folder. Every agent starts there with its role and first prompt.'
              : sharing
                ? 'Send the link to a teammate or put the badge in a README.'
                : importing !== null
                  ? 'Paste a recipe link someone shared. It is saved as a template; nothing starts yet.'
                  : 'Launch a ready-made team of agents with roles, grouped on the board.'}
          </p>
        </div>
        {!chosen && !sharing && importing === null && (
          <button
            type="button"
            data-testid="recipe-import-open"
            onClick={() => setImporting('')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12px] font-medium text-fg
                       hover:border-accent/60 hover:text-accent"
          >
            <Link2 size={13} />
            Import link
          </button>
        )}
      </div>

      {sharing && <ShareRecipePanel template={sharing} />}

      {importing !== null && (
        <ImportRecipePanel
          initial={importing}
          onCancel={() => setImporting(null)}
          onImported={(template) => {
            setTemplates((list) => [...(list ?? []).filter((t) => t.id !== template.id), template]);
            setImporting(null);
            choose(template);
          }}
        />
      )}

      {!chosen && !sharing && importing === null && (
        <div className="aa-scroll max-h-[64vh] overflow-y-auto p-4">
          {!templates && !loadError && (
            <div className="flex items-center justify-center gap-2 py-16 text-fg-subtle">
              <LoaderCircle size={16} className="animate-spin" />
              Loading templates…
            </div>
          )}
          {loadError && (
            <p className="py-12 text-center text-fg-muted">
              Templates aren't available on this server yet.
              <span className="mt-1 block font-mono text-[11px] text-fg-subtle">{loadError}</span>
            </p>
          )}
          {templates && (
            <div className="grid grid-cols-1 gap-3
                            sm:grid-cols-2
                            lg:grid-cols-3">
              <ScratchTemplateCard
                onClick={() => {
                  close();
                  useLoops.getState().openComposer();
                }}
              />
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid="template-card"
                  data-template-id={t.id}
                  onClick={() => choose(t)}
                  className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-left transition
                             hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-[0_12px_40px_-12px_color-mix(in_srgb,var(--aa-glow)_45%,transparent)]
                             focus-visible:border-accent focus-visible:outline-none"
                >
                  <div className="aa-card-glow relative h-32 border-b border-line bg-canvas/60 px-3 pt-2">
                    <TemplateSchematic template={t} />
                    <LaunchOnButton current={choiceFor(t).runOn} onPick={(kind) => choose(t, kind)} />
                  </div>
                  <div className="flex flex-1 flex-col gap-1 p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg group-hover:text-accent">{t.name}</span>
                      <ShareTemplateButton name={t.name} onShare={() => setSharing(t)} />
                      {t.custom && (
                        <CustomTemplateTag
                          id={t.id}
                          name={t.name}
                          onDeleted={() => setTemplates((list) => list?.filter((x) => x.id !== t.id) ?? null)}
                        />
                      )}
                      <span className="aa-label ml-auto inline-flex items-center gap-1 rounded-full bg-accent/12 px-2 py-[2px] text-accent">
                        <Users size={10} />
                        {agentCount(t)}
                      </span>
                    </div>
                    <p className="text-[12px] leading-relaxed text-fg-muted">{t.description}</p>
                    <TemplateCardAgents template={t} choice={choiceFor(t)} />
                    <div className="mt-auto flex flex-wrap gap-1 pt-2">
                      {t.orchestrator && (
                        <span className="aa-label rounded-md border border-accent/40 px-1.5 py-[1px] text-accent">
                          Orchestrator
                        </span>
                      )}
                      {t.teams.map((team, i) => (
                        <span
                          key={team.name}
                          className="aa-label rounded-md border px-1.5 py-[1px]"
                          style={{
                            color: teamColor(i),
                            borderColor: `color-mix(in srgb, ${teamColor(i)} 40%, transparent)`,
                          }}
                        >
                          {team.name} · {team.count}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {chosen && (
        <>
          <TemplateRunStep template={chosen} choice={run} onChange={setRun} />
          <FolderPicker startPath={startFolder} onTargetChange={setCwd} heightClass="h-56" />
          {error && (
            <pre className="aa-scroll max-h-32 overflow-auto border-t border-error/30 bg-error/10 px-5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-error">
              {error}
            </pre>
          )}
          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-fg-subtle" title={cwd ?? ''}>
                {cwd ?? ' '}
              </div>
              <input
                data-testid="template-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void launch();
                }}
                placeholder={`Project name (default: ${cwd ? basename(cwd) : chosen.name})`}
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-fg outline-none placeholder:text-fg-subtle
                           focus:border-accent"
              />
              <WorktreeToggle
                path={cwd}
                checked={isolated}
                onChange={setIsolated}
                label="Give each agent its own branch"
              />
              {!run.accounts.claude && <AccountPicker value={accountId} onChange={setAccountId} />}
              {blocked && (
                <div data-testid="template-blocked" className="mt-1 text-[11.5px] text-needs">
                  {blocked}: pick another provider or install it first.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-1.5 font-medium text-fg-muted
                         hover:bg-hover hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="template-launch"
              disabled={!cwd || launching || !!blocked}
              onClick={() => void launch()}
              className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
            >
              {launching ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Rocket size={13} />
              )}
              Launch {agentCount(chosen)} agents
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
