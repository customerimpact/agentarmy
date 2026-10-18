import { formatTokens, formatUsd } from '../../shared/usage';
import { useUsage } from '../lib/usage';

// "12.3k tok" on a console header: weighted tokens of every session this console has had (30 days)
export function UsageChip({ id }: { id: string }) {
  const usage = useUsage((s) => s.live?.consoles[id]);
  if (!usage || usage.weighted <= 0) return null;
  return (
    <span
      data-testid="console-tokens"
      className="shrink-0 rounded-md bg-hover px-1.5 py-[1px] font-mono text-[10.5px] text-fg-muted tabular-nums"
      title={`${formatTokens(usage.total)} tokens in total (${formatTokens(usage.weighted)} weighted: cache reads count a tenth) · ≈${formatUsd(usage.costUsd)} API-equivalent, last 30 days`}
    >
      {formatTokens(usage.weighted)} tok
    </span>
  );
}
