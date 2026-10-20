import { useMemo, useState } from 'react';
import { Check, Copy, Download, GitBranch, LoaderCircle, Share2, TriangleAlert } from 'lucide-react';
import { AGENT_META } from '../../shared/agents';
import type { Template } from '../../shared/protocol';
import { badgeMarkdown, decodeRecipe, recipeFromTemplate, recipeLink, type Recipe } from '../../shared/recipes';
import { teamApi } from '../lib/loops';
import { useBoard } from '../lib/store';

function CopyField({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => useBoard.getState().toast('Could not copy; select the text and copy it yourself'));
  };
  return (
    <label className="block">
      <span className="aa-label text-fg-subtle">{label}</span>
      <div className="mt-1 flex gap-2">
        <input
          readOnly
          data-testid={testId}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11.5px] text-fg outline-none
                     focus:border-accent"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[12px] font-medium text-fg
                     hover:border-accent/60 hover:text-accent"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </label>
  );
}

// Agents of a recipe with their role, CLI, model and the first prompt they will get
function RecipeRows({ recipe }: { recipe: Recipe }) {
  return (
    <ol className="space-y-2" data-testid="recipe-rows">
      {recipe.rows.map((row, i) => (
        <li key={i} className="rounded-lg border border-line bg-surface px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <span className="font-semibold text-fg">{row.name || `Agent ${i + 1}`}</span>
            <span className="text-fg-muted">{row.role || 'General'}</span>
            <span className="aa-label rounded-md border border-line-strong px-1.5 py-[1px] text-fg-muted">
              {AGENT_META[row.agent ?? 'claude'].short}
              {row.model ? ` · ${row.model}` : ''}
            </span>
            {row.worktree && (
              <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle">
                <GitBranch size={11} /> own branch
              </span>
            )}
          </div>
          {row.prompt ? (
            <pre className="aa-scroll mt-1.5 max-h-28 overflow-auto rounded-md bg-canvas/60 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
              {row.prompt}
            </pre>
          ) : (
            <p className="mt-1 text-[11.5px] text-fg-subtle">No first prompt</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ShareRecipePanel({ template }: { template: Template }) {
  const recipe = useMemo(() => recipeFromTemplate(template), [template]);
  return (
    <div className="aa-scroll max-h-[64vh] space-y-4 overflow-y-auto p-5" data-testid="recipe-share">
      <p className="text-fg-muted">
        Anyone with this link can add <span className="font-semibold text-fg">{recipe.name}</span> to their own GridHive.
        It holds the roles, agents, models and prompts below. Your accounts and folders are not included.
      </p>
      <CopyField label="Share link" value={recipeLink(recipe)} testId="recipe-share-link" />
      <CopyField label='"Run in GridHive" badge for a README (Markdown)' value={badgeMarkdown(recipe)} testId="recipe-share-badge" />
      <RecipeRows recipe={recipe} />
    </div>
  );
}

export function ImportRecipePanel({
  initial,
  onImported,
  onCancel,
}: {
  initial: string;
  onImported: (template: Template) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo((): { recipe: Recipe } | { error: string } | null => {
    if (!input.trim()) return null;
    try {
      return { recipe: decodeRecipe(input) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [input]);
  const recipe = parsed && 'recipe' in parsed ? parsed.recipe : null;

  const save = async () => {
    if (!recipe || saving) return;
    setSaving(true);
    setError(null);
    try {
      const template = await teamApi.saveTemplate({
        name: recipe.name,
        ...(recipe.description ? { description: recipe.description } : {}),
        rows: recipe.rows,
      });
      useBoard.getState().toast(`Added ${template.name} to your templates`);
      onImported(template);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="aa-scroll max-h-[64vh] space-y-4 overflow-y-auto p-5" data-testid="recipe-import">
        <label className="block">
          <span className="aa-label text-fg-subtle">Recipe link</span>
          <textarea
            data-testid="recipe-import-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            placeholder="https://gridhive.dev/r#…"
            className="mt-1 w-full resize-none rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11.5px] text-fg outline-none placeholder:text-fg-subtle
                       focus:border-accent"
          />
        </label>
        {parsed && 'error' in parsed && (
          <p data-testid="recipe-import-error" className="text-[12px] text-error">
            {parsed.error}
          </p>
        )}
        {recipe && (
          <>
            <div>
              <h3 className="text-[14px] font-semibold text-fg">{recipe.name}</h3>
              {recipe.description && <p className="text-fg-muted">{recipe.description}</p>}
            </div>
            <p className="flex gap-2 rounded-lg border border-needs/40 bg-needs/10 px-3 py-2 text-[12px] text-fg">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-needs" />
              Each agent gets its prompt below as its first message when you launch. Read them first: only use recipes
              from people you trust.
            </p>
            <RecipeRows recipe={recipe} />
          </>
        )}
        {error && <p className="text-[12px] text-error">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-line bg-surface-2 px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 font-medium text-fg-muted
                     hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="recipe-import-save"
          disabled={!recipe || saving}
          onClick={() => void save()}
          className="aa-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold disabled:opacity-50"
        >
          {saving ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
          Add to my templates
        </button>
      </div>
    </>
  );
}

// Small share icon on a template card (the card itself is a button, so this is a span)
export function ShareTemplateButton({ name, onShare }: { name: string; onShare: () => void }) {
  const share = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    onShare();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Share template ${name}`}
      title="Share as a link"
      data-testid="template-share"
      onClick={share}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && share(e)}
      className="grid size-5 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-accent"
    >
      <Share2 size={12} />
    </span>
  );
}
