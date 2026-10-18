import { useState } from 'react';
import {
  ChevronRight,
  ClipboardList,
  Crosshair,
  Hand,
  Check,
  RotateCcw,
  TriangleAlert,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import type { ActionItem, ActionKind } from '../../shared/protocol';
import { api } from '../lib/api';
import { flyTo } from '../lib/board-actions';
import {
  openActions,
  projectOf,
  relativeTime,
  resolvedActions,
  uncoveredNeedsYou,
} from '../lib/fleet';
import { setSoundEnabled, useSoundEnabled } from '../lib/notify';
import { useBoard, useClock } from '../lib/store';

const KIND: Record<ActionKind, { icon: LucideIcon; box: string; label: string }> = {
  needs_you: { icon: Hand, box: 'bg-needs/15 text-needs ring-1 ring-needs/40', label: 'Needs you' },
  error: {
    icon: TriangleAlert,
    box: 'bg-error/15 text-error ring-1 ring-error/40',
    label: 'Error',
  },
  request: {
    icon: ClipboardList,
    box: 'bg-working/15 text-working ring-1 ring-working/40',
    label: 'Request',
  },
};

const fail = (what: string) => (error: unknown) =>
  useBoard.getState().toast(`${what} failed: ${(error as Error).message}`);

function resolve(id: string, resolved: boolean): void {
  api
    .resolveAction(id, resolved)
    .then(useBoard.getState().upsertAction)
    .catch(fail(resolved ? 'Mark done' : 'Reopen'));
}

function useSource(action: ActionItem): string {
  const consoles = useBoard((s) => s.consoles);
  const projects = useBoard((s) => s.projects);
  const c = action.consoleId ? consoles[action.consoleId] : undefined;
  if (!c) return action.consoleId ? 'Closed console' : 'AgentArmy';
  const project = projectOf(c, projects);
  return project ? `${c.name} · ${project.name}` : c.name;
}

// synthetic: a needs-you console the server has not filed an item for; it clears on its own
function ActionCard({
  action,
  now,
  synthetic = false,
}: {
  action: ActionItem;
  now: number;
  synthetic?: boolean;
}) {
  const kind = KIND[action.kind];
  const Icon = kind.icon;
  const source = useSource(action);
  const hasConsole = useBoard((s) => !!(action.consoleId && s.consoles[action.consoleId]));
  return (
    <li
      data-testid="action-item"
      data-kind={action.kind}
      className="rounded-xl border border-line bg-surface-2 p-2.5 transition-colors hover:border-line-strong"
    >
      <div className="flex gap-2.5">
        <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${kind.box}`}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 text-[13px] leading-5 font-medium text-fg">
              {action.title}
            </span>
            <span className="shrink-0 text-[10.5px] text-fg-subtle tabular-nums">
              {relativeTime(action.createdAt, now)}
            </span>
          </div>
          <div className="truncate text-[11.5px] text-fg-subtle">{source}</div>
          {action.detail && (
            <p className="mt-1 line-clamp-2 text-[12px] leading-[17px] text-fg-muted">
              {action.detail}
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 pl-[38px]">
        {hasConsole && (
          <button
            type="button"
            onClick={() => action.consoleId && void flyTo(action.consoleId)}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11.5px] font-semibold text-accent-fg
                       hover:brightness-110"
          >
            <Crosshair size={12} />
            Go to
          </button>
        )}
        {action.kind === 'needs_you' && (
          <span className="text-[11px] text-fg-subtle">Answer in the terminal</span>
        )}
        {!synthetic && (
          <button
            type="button"
            onClick={() => resolve(action.id, true)}
            className={`ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium
                      ${action.kind === 'needs_you' ? 'text-fg-subtle hover:bg-hover hover:text-fg' : 'text-fg-muted ring-1 ring-line-strong hover:bg-hover hover:text-fg'}`}
          >
            <Check size={12} />
            Done
          </button>
        )}
      </div>
    </li>
  );
}

export function ActionsPanel() {
  const actions = useBoard((s) => s.actions);
  const consoles = useBoard((s) => s.consoles);
  const now = useClock((s) => s.now);
  const sound = useSoundEnabled();
  const [showResolved, setShowResolved] = useState(false);
  const pending: ActionItem[] = uncoveredNeedsYou(consoles, actions).map((c) => ({
    id: `console:${c.id}`,
    consoleId: c.id,
    kind: 'needs_you',
    title: c.statusDetail || 'Waiting for your input',
    createdAt: c.statusChangedAt,
  }));
  const open = [...pending, ...openActions(actions)];
  const resolved = resolvedActions(actions);

  return (
    <div data-testid="actions-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">Action inbox</div>
          <div className="text-[11.5px] text-fg-subtle">
            {open.length ? `${open.length} waiting on you` : 'All clear'}
          </div>
        </div>
        <button
          type="button"
          data-testid="sound-toggle"
          aria-pressed={sound}
          title={sound ? 'Sound on: chime when something needs you' : 'Sound off'}
          onClick={() => setSoundEnabled(!sound)}
          className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium
                      ${sound ? 'border-line text-fg-muted hover:bg-hover hover:text-fg' : 'border-line text-fg-subtle hover:bg-hover'}`}
        >
          {sound ? <Volume2 size={13} /> : <VolumeX size={13} />}
          {sound ? 'Sound' : 'Muted'}
        </button>
      </div>

      <div className="aa-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {open.length === 0 ? (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <Check size={18} className="mx-auto text-resting" />
            <p className="mt-2 text-fg-muted">Nothing needs you right now.</p>
            <p className="mt-1 text-[11.5px] text-fg-subtle">
              Permission prompts, errors and agent requests show up here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {open.map((a) => (
              <ActionCard key={a.id} action={a} now={now} synthetic={a.id.startsWith('console:')} />
            ))}
          </ul>
        )}

        {resolved.length > 0 && (
          <section className="mt-4">
            <div className="flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={() => setShowResolved(!showResolved)}
                className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase
                           hover:text-fg-muted"
              >
                <ChevronRight
                  size={12}
                  className={`transition-transform ${showResolved ? 'rotate-90' : ''}`}
                />
                Resolved ({resolved.length})
              </button>
              <button
                type="button"
                onClick={() =>
                  api
                    .clearResolvedActions()
                    .then(() => useBoard.getState().removeActions(resolved.map((a) => a.id)))
                    .catch(fail('Clear resolved'))
                }
                className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-hover hover:text-fg"
              >
                Clear resolved
              </button>
            </div>
            {showResolved && (
              <ul className="mt-1 flex flex-col">
                {resolved.map((a) => (
                  <ResolvedRow key={a.id} action={a} now={now} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ResolvedRow({ action, now }: { action: ActionItem; now: number }) {
  const kind = KIND[action.kind];
  const Icon = kind.icon;
  const source = useSource(action);
  return (
    <li
      data-testid="action-resolved"
      className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover"
    >
      <Icon size={13} className="shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-fg-muted line-through decoration-fg-subtle/60">
          {action.title}
        </span>
        <span className="block truncate text-[10.5px] text-fg-subtle">
          {source} · {action.resolvedBy === 'auto' ? 'answered' : 'done'}{' '}
          {relativeTime(action.resolvedAt ?? action.createdAt, now)}
        </span>
      </span>
      <button
        type="button"
        onClick={() => resolve(action.id, false)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fg-subtle opacity-0
                   group-hover:opacity-100 hover:bg-elevated hover:text-fg focus-visible:opacity-100"
      >
        <RotateCcw size={11} />
        Reopen
      </button>
    </li>
  );
}
