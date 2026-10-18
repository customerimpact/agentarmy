import { LoaderCircle } from 'lucide-react';
import type { ConsoleStatus } from '../../shared/protocol';
import { STATUS_META } from '../lib/status';

export function StatusDot({ status, size = 8 }: { status: ConsoleStatus; size?: number }) {
  if (status === 'starting') {
    return <LoaderCircle className="shrink-0 animate-spin text-idle" size={size + 4} />;
  }
  const pulsing = status === 'working' || status === 'needs_you';
  return (
    <span
      className={`relative inline-block shrink-0 rounded-full ${STATUS_META[status].dot}
                  ${pulsing ? 'aa-ping' : ''}`}
      style={{
        width: size,
        height: size,
        boxShadow: pulsing ? `0 0 ${size}px ${STATUS_META[status].cssVar}` : undefined,
      }}
    />
  );
}
