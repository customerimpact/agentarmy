import { KeyRound } from 'lucide-react';

export function MissingToken({ invalid }: { invalid?: boolean }) {
  return (
    <div className="grid h-full place-items-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-2xl shadow-black/40">
        <div className="mx-auto grid size-11 place-items-center rounded-xl bg-accent/15 text-accent">
          <KeyRound size={20} />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-fg">
          {invalid ? 'This link is no longer valid' : 'Open the link from your terminal'}
        </h1>
        <p className="mt-2 leading-relaxed text-fg-muted">
          Open the link printed by{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">
            npx gridhive
          </code>
          . It carries a per-run token that keeps other websites from reaching your terminals.
        </p>
        {invalid && (
          <p className="mt-3 text-[12px] text-fg-subtle">
            The server was probably restarted, which creates a new token.
          </p>
        )}
      </div>
    </div>
  );
}
