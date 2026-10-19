import { Repeat } from 'lucide-react';
import { relativeTime } from '../lib/fleet';
import { useLoops } from '../lib/loops';
import { useClock } from '../lib/store';

// Progress tab: each loop's recent runs, drawn like the job timeline
export function LoopProgress() {
  const loops = useLoops((s) => s.loops);
  const now = useClock((s) => s.now);
  const runs = Object.values(loops)
    .flatMap((loop) => (loop.history ?? []).map((entry) => ({ loop, entry })))
    .sort((a, b) => b.entry.at - a.entry.at)
    .slice(0, 12);
  if (!runs.length) return null;
  return (
    <section data-testid="loop-progress" className="mt-2 px-1">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        Loop runs
        <button
          type="button"
          onClick={() => useLoops.getState().openLoops()}
          className="ml-auto font-medium tracking-normal text-accent normal-case hover:underline"
        >
          Manage
        </button>
      </h3>
      <ol className="relative ml-1 border-l border-line pl-0">
        {runs.map(({ loop, entry }) => {
          const ok = entry.sentTo.length > 0;
          const retired = entry.note?.startsWith('Retired');
          return (
            <li key={`${loop.id}-${entry.at}`} data-testid="loop-run" className="relative pb-3 pl-4">
              <span className={`absolute top-[6px] -left-[4.5px] size-2 rounded-full ring-2 ring-surface ${ok ? 'bg-accent' : 'bg-line-strong'}`} />
              <div className="flex items-center gap-1 text-[11.5px] text-fg-subtle">
                <Repeat size={11} className="text-accent/80" />
                <span className="truncate font-medium text-fg-muted">{loop.name}</span>
                <span className="ml-auto shrink-0 tabular-nums">{relativeTime(entry.at, now)}</span>
              </div>
              <div className="mt-0.5 flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-fg">
                  {ok ? `Sent to ${entry.sentTo.join(', ')}` : entry.note}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-medium ring-1
                              ${retired ? 'bg-resting/12 text-resting ring-resting/30' : ok ? 'bg-working/12 text-working ring-working/30' : 'bg-hover text-fg-muted ring-line-strong'}`}
                >
                  {retired ? 'retired' : ok ? 'sent' : 'skipped'}
                </span>
              </div>
              {entry.skipped.length > 0 && (
                <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-fg-muted">Skipped {entry.skipped.join(', ')}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
