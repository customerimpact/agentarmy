import type { ReactNode } from 'react';
import { Panel } from '@xyflow/react';
import {
  Circle,
  Eraser,
  Eye,
  EyeOff,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { DRAW_COLORS, type ShapeFill, type StrokeDash, type StrokeWidth } from '../../../shared/drawings';
import { useDrawVoicePrefs } from '../../lib/draw-voice-prefs';
import { useDrawings, type DrawTool } from '../../lib/drawing/store';
import { colorVar } from './ShapeSvg';

// Left tool rail for drawing: draw-mode toggle, tools, undo/redo, show/hide, and a style card
// (colour, width, dash, fill, opacity) that also restyles the selected shapes.

const TOOLS: { tool: DrawTool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
  { tool: 'pen', label: 'Pen', key: 'P', icon: Pencil },
  { tool: 'line', label: 'Line', key: 'L', icon: Minus },
  { tool: 'arrow', label: 'Arrow (snaps to consoles)', key: 'A', icon: MoveUpRight },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { tool: 'text', label: 'Text', key: 'T', icon: Type },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: Eraser },
];

const btn = `grid size-8 place-items-center rounded-lg text-fg-muted transition-colors
             hover:bg-hover hover:text-fg
             disabled:opacity-35 disabled:hover:bg-transparent`;

function RailButton({
  label,
  onClick,
  active,
  disabled,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={`${btn} ${active ? 'bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent' : ''}`}
    >
      {children}
    </button>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; title: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`grid h-6 min-w-7 flex-1 place-items-center rounded-md px-1 text-[11px] font-medium
                      ${value === o.value ? 'bg-elevated text-fg shadow-sm' : 'text-fg-subtle hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StyleCard() {
  const style = useDrawings((s) => s.style);
  const selected = useDrawings((s) => s.selected);
  const shapes = useDrawings((s) => s.shapes);
  const setStyle = useDrawings((s) => s.setStyle);
  // With a selection, show the first selected shape's style
  const shown = (selected.length && shapes[selected[0]]?.style) || style;
  const widthIcon = (w: StrokeWidth) => <span className="block rounded-full bg-current" style={{ width: 14, height: w === 'S' ? 1.5 : w === 'M' ? 3 : 5 }} />;
  return (
    <div data-draw-ui data-testid="draw-style" className="pointer-events-auto flex w-44 flex-col gap-2.5 rounded-xl border border-line-strong bg-elevated/95 p-2.5 shadow-xl shadow-black/30 backdrop-blur">
      <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Colour">
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={shown.color === c}
            aria-label={c}
            title={c}
            data-testid={`draw-color-${c}`}
            onClick={() => setStyle({ color: c })}
            className={`size-7 rounded-full border-2 transition-transform
                        hover:scale-110
                        ${shown.color === c ? 'border-fg' : 'border-transparent'}`}
            style={{ background: colorVar(c) }}
          />
        ))}
      </div>
      <Seg<StrokeWidth>
        label="Width"
        value={shown.width}
        onChange={(width) => setStyle({ width })}
        options={(['S', 'M', 'L'] as const).map((w) => ({ value: w, label: widthIcon(w), title: `Width ${w}` }))}
      />
      <Seg<StrokeDash>
        label="Line style"
        value={shown.dash}
        onChange={(dash) => setStyle({ dash })}
        options={[
          { value: 'solid', label: 'Solid', title: 'Solid line' },
          { value: 'dashed', label: 'Dashed', title: 'Dashed line' },
        ]}
      />
      <Seg<ShapeFill>
        label="Fill"
        value={shown.fill}
        onChange={(fill) => setStyle({ fill })}
        options={[
          { value: 'none', label: 'No fill', title: 'No fill' },
          { value: 'soft', label: 'Soft', title: 'Soft tinted fill' },
        ]}
      />
      <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
        Opacity
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={shown.opacity}
          aria-label="Opacity"
          onChange={(e) => useDrawings.setState({ style: { ...useDrawings.getState().style, opacity: Number(e.target.value) } })}
          // Restyle the selection once, on release, so a drag is one undo step
          onPointerUp={(e) => setStyle({ opacity: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e) => setStyle({ opacity: Number((e.target as HTMLInputElement).value) })}
          className="min-w-0 flex-1 accent-[var(--aa-accent)]"
        />
      </label>
    </div>
  );
}

export function DrawRail() {
  const active = useDrawings((s) => s.active);
  const tool = useDrawings((s) => s.tool);
  const canUndo = useDrawings((s) => s.canUndo);
  const canRedo = useDrawings((s) => s.canRedo);
  const selectedCount = useDrawings((s) => s.selected.length);
  const show = useDrawVoicePrefs((s) => s.prefs.showDrawings);
  const { setActive, setTool, undo, redo, removeSelected } = useDrawings.getState();
  const setShow = (value: boolean) => useDrawVoicePrefs.getState().setPrefs({ showDrawings: value });

  return (
    <Panel position="center-left" className="!m-3" style={{ pointerEvents: 'none' }}>
      <div className="flex items-center gap-2">
        <div
          data-draw-ui
          data-testid="draw-rail"
          className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-xl border border-line bg-surface/95 p-1 shadow-lg shadow-black/25 backdrop-blur"
        >
          <RailButton
            label={active ? 'Leave draw mode (D / Esc)' : 'Draw and annotate (D)'}
            testId="draw-toggle"
            active={active}
            onClick={() => {
              if (!active && !show) setShow(true);
              setActive(!active);
            }}
          >
            <PenLine size={15} />
          </RailButton>
          {active && (
            <>
              <div className="my-0.5 h-px w-5 bg-line" />
              {TOOLS.map(({ tool: t, label, key, icon: Icon }) => (
                <RailButton key={t} label={`${label} (${key})`} testId={`draw-tool-${t}`} active={tool === t} onClick={() => setTool(t)}>
                  <Icon size={15} />
                </RailButton>
              ))}
              <div className="my-0.5 h-px w-5 bg-line" />
              <RailButton label="Undo (Ctrl+Z)" testId="draw-undo" disabled={!canUndo} onClick={undo}>
                <Undo2 size={15} />
              </RailButton>
              <RailButton label="Redo (Ctrl+Shift+Z)" testId="draw-redo" disabled={!canRedo} onClick={redo}>
                <Redo2 size={15} />
              </RailButton>
            </>
          )}
          {(active || selectedCount > 0) && (
            <RailButton label="Delete selected shapes (Del)" testId="draw-delete" disabled={!selectedCount} onClick={removeSelected}>
              <Trash2 size={15} />
            </RailButton>
          )}
          <RailButton label={show ? 'Hide drawings' : 'Show drawings'} testId="draw-visibility" active={!show} onClick={() => setShow(!show)}>
            {show ? <Eye size={15} /> : <EyeOff size={15} />}
          </RailButton>
        </div>
        {show && ((active && tool !== 'eraser') || selectedCount > 0) && <StyleCard />}
      </div>
    </Panel>
  );
}
