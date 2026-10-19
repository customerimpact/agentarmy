import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ModelField, ProviderAccountSelect, ProviderSelect, ReadinessWarning, RunOnControl, useLoadProviders } from './ProviderPicker';
import { applyAllRows, cleanComposerRow, rowsRunOn } from '../lib/agent-choice';
import { readinessOf, providerShort } from '../lib/provider-readiness';
import { useReactFlow } from '@xyflow/react';
import { BookmarkPlus, Check, GitBranch, LoaderCircle, Minus, Plus, Rocket, Users, X } from 'lucide-react';
import { COMPOSER_ROLES, MAX_COMPOSER_ROWS, type ComposerRow } from '../../shared/protocol';
import { composerFrameSize } from '../../shared/composer';
import { useAccountList } from '../lib/accounts';
import { DEFAULT_SIZE } from '../lib/board-actions';
import { agentsLabel, teamApi, useLoops } from '../lib/loops';
import { getRecentFolders, rememberRecentFolder } from '../lib/recent-folders';
import { basename } from '../lib/status';
import { useBoard } from '../lib/store';
import { FolderPicker } from './FolderPicker';
import { Modal } from './Modal';
import { useRepoInfo } from './WorktreeToggle';

interface RowDraft extends ComposerRow {
  key: number;
  customRole: boolean;
}

let rowSeq = 0;
const blankRow = (role = 'General'): RowDraft => ({ key: ++rowSeq, role, prompt: '', name: '', customRole: false });
const fromRow = (row: ComposerRow): RowDraft => ({
  key: ++rowSeq,
  name: row.name ?? '',
  role: row.role ?? 'General',
  prompt: row.prompt ?? '',
  accountId: row.accountId,
  worktree: row.worktree,
  agent: row.agent,
  model: row.model,
  customRole: !!row.role && !(COMPOSER_ROLES as readonly string[]).includes(row.role),
});

const field = `rounded-md border border-line-strong bg-canvas px-2 py-1 text-[12.5px] text-fg outline-none
               placeholder:text-fg-subtle focus:border-accent`;

function RoleChips({ row, onChange }: { row: RowDraft; onChange: (patch: Partial<RowDraft>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {COMPOSER_ROLES.map((role) => {
        const on = !row.customRole && row.role === role;
        return (
          <button
            key={role}
            type="button"
            data-testid="composer-role-chip"
            aria-pressed={on}
            onClick={() => onChange({ role, customRole: false })}
            className={`h-6 rounded-full border px-2 text-[11.5px] font-medium transition-colors
                        ${on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-fg-muted hover:border-accent/40 hover:text-fg'}`}
          >
            {role}
          </button>
        );
      })}
      {row.customRole ? (
        <input
          autoFocus
          data-testid="composer-custom-role"
          value={row.role ?? ''}
          onChange={(e) => onChange({ role: e.target.value })}
          placeholder="Custom role"
          className={`${field} h-6 w-28 py-0 text-[11.5px]`}
        />
      ) : (
        <button
          type="button"
          onClick={() => onChange({ customRole: true, role: '' })}
          className="h-6 rounded-full border border-dashed border-line-strong px-2 text-[11.5px] text-fg-subtle hover:border-accent/50 hover:text-fg"
        >
          + Custom
        </button>
      )}
    </div>
  );
}

export function ComposerDialog() {
  const prefill = useLoops((s) => s.composerRows);
  const close = () => useLoops.getState().closeComposer();
  const flow = useReactFlow();
  const accounts = useAccountList();
  const [startFolder] = useState(() => getRecentFolders()[0]);
  const [cwd, setCwd] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [rows, setRows] = useState<RowDraft[]>(() => (prefill?.length ? prefill.map(fromRow) : [blankRow('Frontend'), blankRow('Backend'), blankRow('Tests')]));
  const [fillRole, setFillRole] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const repo = useRepoInfo(cwd);
  const inRepo = !!repo?.repoRoot;
  const providers = useLoadProviders();
  const runOn = rowsRunOn(rows);
  const missing = [...new Set(rows.map((r) => r.agent ?? 'claude'))].find(
    (k) => readinessOf(providers?.find((p) => p.id === k), k) === 'not_installed',
  );

  const patchRow = (key: number, patch: Partial<RowDraft>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setCount = (n: number) => {
    const count = Math.max(1, Math.min(MAX_COMPOSER_ROWS, n));
    setRows((list) =>
      count <= list.length ? list.slice(0, count) : [...list, ...Array.from({ length: count - list.length }, () => blankRow(list.at(-1)?.role || 'General'))],
    );
  };
  const fillAll = (role: string) => {
    if (!role) return;
    setRows((list) => list.map((r) => ({ ...r, role, customRole: false })));
    setFillRole('');
  };

  const cleanRows = (): ComposerRow[] =>
    rows.map((r) =>
      cleanComposerRow({
        ...(r.name?.trim() ? { name: r.name.trim() } : {}),
        role: r.role?.trim() || 'General',
        ...(r.prompt?.trim() ? { prompt: r.prompt.trim() } : {}),
        ...(r.accountId && r.accountId !== 'auto' ? { accountId: r.accountId } : {}),
        ...(r.worktree && inRepo ? { worktree: true } : {}),
        agent: r.agent,
        model: r.model,
      }),
    );

  // Top-left of the visible board if the grid fits there, else to the right of everything
  const pickOrigin = (): { x: number; y: number } => {
    const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
    const topLeft = rect ? flow.screenToFlowPosition({ x: rect.left + 48, y: rect.top + 64 }) : { x: 0, y: 0 };
    const size = composerFrameSize(rows.length, DEFAULT_SIZE);
    const existing = Object.values(useBoard.getState().consoles).map((c) => c.layout);
    const hits = existing.some(
      (e) => e.x < topLeft.x + size.width && e.x + e.width > topLeft.x && e.y < topLeft.y + size.height && e.y + e.height > topLeft.y,
    );
    if (!hits) return { x: Math.round(topLeft.x), y: Math.round(topLeft.y) };
    return { x: Math.round(Math.max(...existing.map((e) => e.x + e.width)) + 200), y: Math.round(Math.min(...existing.map((e) => e.y))) };
  };

  const launch = async () => {
    if (!cwd || launching || missing) return;
    setLaunching(true);
    setError(null);
    try {
      const result = await teamApi.compose({ cwd, projectName: projectName.trim() || undefined, rows: cleanRows(), origin: pickOrigin() });
      const store = useBoard.getState();
      for (const project of result.projects) store.upsertProject(project);
      for (const c of result.consoles) store.upsertConsole(c);
      rememberRecentFolder(cwd);
      close();
      const ids = result.consoles.map((c) => ({ id: c.id }));
      window.setTimeout(() => void flow.fitView({ nodes: ids, duration: 500, padding: 0.08, maxZoom: 1 }), 120);
      store.toast(`Launched ${result.projects[0]?.name ?? 'team'}: ${agentsLabel(result.consoles.length)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const saveTemplate = async () => {
    const name = saveName?.trim();
    if (!name) return;
    try {
      const t = await teamApi.saveTemplate({ name, rows: cleanRows() });
      setSaveName(null);
      useBoard.getState().toast(`Saved template ${t.name}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const allBranches = inRepo && rows.every((r) => r.worktree);

  return (
    <Modal title="Compose a team" onClose={close} width="max-w-4xl" testId="composer-dialog">
      <div className="aa-card-glow flex items-center gap-3 border-b border-line px-5 pt-4 pb-3">
        <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent">
          <Users size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">Compose a team</h2>
          <p className="mt-0.5 truncate text-fg-muted">Launch up to {MAX_COMPOSER_ROWS} agents in one step, each with a role and a first prompt.</p>
        </div>
      </div>

      <FolderPicker startPath={startFolder} onTargetChange={setCwd} heightClass="h-40" autoFocus={false} />

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2 px-5 py-2.5">
        <input
          data-testid="composer-project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder={`Project name (default: ${cwd ? basename(cwd) : 'folder name'})`}
          className={`${field} min-w-48 flex-1 py-1.5`}
        />
        <div className="flex items-center rounded-lg border border-line-strong bg-canvas" title="Number of agents">
          <button type="button" aria-label="Fewer agents" data-testid="composer-count-minus" onClick={() => setCount(rows.length - 1)} className="grid size-7 place-items-center text-fg-muted hover:text-fg disabled:opacity-40" disabled={rows.length <= 1}>
            <Minus size={13} />
          </button>
          <span data-testid="composer-count" className="w-6 text-center font-semibold text-fg tabular-nums">
            {rows.length}
          </span>
          <button type="button" aria-label="More agents" data-testid="composer-count-plus" onClick={() => setCount(rows.length + 1)} className="grid size-7 place-items-center text-fg-muted hover:text-fg disabled:opacity-40" disabled={rows.length >= MAX_COMPOSER_ROWS}>
            <Plus size={13} />
          </button>
        </div>
        <select data-testid="composer-fill-role" value={fillRole} onChange={(e) => fillAll(e.target.value)} className={`${field} py-1.5`}>
          <option value="">Fill all with role…</option>
          {COMPOSER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {inRepo && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-muted select-none" title="Give every agent its own git branch + worktree">
            <input
              type="checkbox"
              data-testid="composer-all-branches"
              checked={allBranches}
              onChange={(e) => setRows((list) => list.map((r) => ({ ...r, worktree: e.target.checked })))}
              className="accent-[var(--aa-accent)]"
            />
            <GitBranch size={12} className="text-accent" />
            Own branch each
          </label>
        )}
      </div>

      <div className="border-t border-line px-5 py-2.5">
        <RunOnControl
          value={runOn}
          testId="composer-run-on"
          label="All rows on"
          allowMixed={runOn === 'mixed'}
          onChange={(kind) => {
            // Switching the provider resets models (they are per CLI) and provider accounts
            if (kind !== 'mixed') setRows((list) => applyAllRows(list, kind, '').map((r) => ({ ...r, accountId: undefined })));
          }}
        />
      </div>

      <ol data-testid="composer-rows" className="aa-scroll flex max-h-[38vh] flex-col gap-2 overflow-y-auto px-5 py-3">
        {rows.map((row, i) => (
          <li key={row.key} data-testid="composer-row" className="rounded-xl border border-line bg-surface p-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-md bg-accent/12 text-[11px] font-semibold text-accent tabular-nums">{i + 1}</span>
              <input
                data-testid="composer-name"
                value={row.name ?? ''}
                onChange={(e) => patchRow(row.key, { name: e.target.value })}
                placeholder="Auto name"
                className={`${field} w-28 shrink-0`}
              />
              <div className="min-w-0 flex-1">
                <RoleChips row={row} onChange={(patch) => patchRow(row.key, patch)} />
              </div>
              <button
                type="button"
                aria-label={`Remove agent ${i + 1}`}
                disabled={rows.length <= 1}
                onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
                className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-error disabled:opacity-30"
              >
                <X size={13} />
              </button>
            </div>
            <div className="mt-2 flex items-start gap-2 pl-8">
              <textarea
                data-testid="composer-prompt"
                value={row.prompt ?? ''}
                rows={row.prompt?.includes('\n') ? 3 : 1}
                onChange={(e) => patchRow(row.key, { prompt: e.target.value })}
                placeholder="First prompt (optional). {name}, {role} and {team} are filled in."
                className={`${field} aa-scroll min-h-7 flex-1 resize-y leading-5`}
              />
              <ProviderSelect
                testId="composer-agent"
                value={row.agent ?? 'claude'}
                onChange={(agent) => patchRow(row.key, { agent, model: '', accountId: undefined })}
                className={`${field} w-32 shrink-0`}
              />
              <ModelField
                kind={row.agent ?? 'claude'}
                value={row.model ?? ''}
                onChange={(model) => patchRow(row.key, { model })}
                className="w-32 shrink-0"
                testId="composer-model"
              />
              {(row.agent ?? 'claude') !== 'claude' && (
                <ProviderAccountSelect
                  kind={row.agent ?? 'claude'}
                  value={row.accountId ?? 'auto'}
                  onChange={(accountId) => patchRow(row.key, { accountId })}
                  className="w-32 shrink-0"
                  testId="composer-account"
                />
              )}
              {(row.agent ?? 'claude') === 'claude' && accounts.length > 1 && (
                <select
                  data-testid="composer-account"
                  value={row.accountId ?? 'auto'}
                  onChange={(e) => patchRow(row.key, { accountId: e.target.value })}
                  className={`${field} w-32 shrink-0`}
                >
                  <option value="auto">Auto account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.status === 'needs_login'}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              {inRepo && (
                <label className="mt-1 flex shrink-0 cursor-pointer items-center gap-1 text-[11.5px] text-fg-muted select-none" title="Isolated branch (git worktree)">
                  <input
                    type="checkbox"
                    data-testid="composer-branch"
                    checked={!!row.worktree}
                    onChange={(e) => patchRow(row.key, { worktree: e.target.checked })}
                    className="accent-[var(--aa-accent)]"
                  />
                  <GitBranch size={11} />
                  Branch
                </label>
              )}
            </div>
            <ReadinessWarning kind={row.agent ?? 'claude'} className="mt-1 pl-8" />
          </li>
        ))}
        {rows.length < MAX_COMPOSER_ROWS && (
          <li>
            <button
              type="button"
              data-testid="composer-add-row"
              onClick={() => setCount(rows.length + 1)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2 text-[12.5px] font-medium text-fg-muted
                         hover:border-accent/50 hover:bg-accent/5 hover:text-fg"
            >
              <Plus size={13} />
              Add row
            </button>
          </li>
        )}
      </ol>

      {error && (
        <pre className="aa-scroll max-h-28 overflow-auto border-t border-error/30 bg-error/10 px-5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-error">{error}</pre>
      )}
      <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
        {saveName === null ? (
          <button
            type="button"
            data-testid="composer-save-template"
            onClick={() => setSaveName(projectName.trim() || '')}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-fg-muted hover:bg-hover hover:text-fg"
          >
            <BookmarkPlus size={14} />
            Save as template
          </button>
        ) : (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveTemplate();
            }}
          >
            <input
              autoFocus
              data-testid="composer-template-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setSaveName(null);
                }
              }}
              placeholder="Template name"
              className={`${field} w-44 py-1.5`}
            />
            <button type="submit" aria-label="Save template" data-testid="composer-template-save" disabled={!saveName.trim()} className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-40">
              <Check size={13} />
            </button>
            <button type="button" aria-label="Cancel" onClick={() => setSaveName(null)} className="grid size-7 place-items-center rounded-md text-fg-subtle hover:text-fg">
              <X size={13} />
            </button>
          </form>
        )}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-fg-subtle" title={cwd ?? ''}>
          {cwd ?? 'Pick a folder above'}
        </span>
        <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 font-medium text-fg-muted hover:bg-hover hover:text-fg">
          Cancel
        </button>
        <button
          type="button"
          data-testid="composer-launch"
          disabled={!cwd || launching || !!missing}
          title={missing ? `${providerShort(missing)} is not installed` : undefined}
          onClick={() => void launch()}
          className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
        >
          {launching ? <LoaderCircle size={13} className="animate-spin" /> : <Rocket size={13} />}
          Launch {agentsLabel(rows.length)}
        </button>
      </div>
    </Modal>
  );
}

// Templates gallery: the first card opens the Composer with blank rows
export function ScratchTemplateCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="template-scratch"
      onClick={onClick}
      className="group flex flex-col overflow-hidden rounded-xl border border-dashed border-line-strong bg-surface/60 text-left transition
                 hover:-translate-y-0.5 hover:border-accent/60 hover:bg-surface
                 focus-visible:border-accent focus-visible:outline-none"
    >
      <div className="grid h-32 place-items-center border-b border-dashed border-line bg-canvas/40">
        <span className="grid size-12 place-items-center rounded-2xl bg-accent/12 text-accent transition group-hover:scale-105">
          <Plus size={22} />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="font-semibold text-fg group-hover:text-accent">Start from scratch</span>
        <p className="text-[12px] leading-relaxed text-fg-muted">
          Compose up to {MAX_COMPOSER_ROWS} agents yourself: names, roles, first prompts, accounts and branches.
        </p>
      </div>
    </button>
  );
}

// "Custom" badge + delete for templates saved from the Composer
export function CustomTemplateTag({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const del = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    useBoard.getState().askConfirm({
      title: `Delete template ${name}?`,
      message: 'Agents launched from it stay on the board.',
      confirmLabel: 'Delete template',
      danger: true,
      onConfirm: () =>
        teamApi
          .deleteTemplate(id)
          .then(onDeleted)
          .catch((error: Error) => useBoard.getState().toast(`Delete failed: ${error.message}`)),
    });
  };
  return (
    <>
      <span data-testid="template-custom-badge" className="aa-label rounded-full border border-project-violet/45 px-1.5 py-[1px] text-project-violet">
        Custom
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Delete template ${name}`}
        data-testid="template-delete"
        onClick={del}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && del(e)}
        className="grid size-5 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-error"
      >
        <X size={12} />
      </span>
    </>
  );
}
