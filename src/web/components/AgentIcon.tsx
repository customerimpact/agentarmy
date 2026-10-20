import type { ComponentType } from 'react';
import { SquareTerminal } from 'lucide-react';
import { AGENT_META, type AgentKind } from '../../shared/agents';
import { BrandIcon, type BrandAgent } from './brand-icons';

type IconProps = { size?: number; className?: string; strokeWidth?: number };

// Each CLI shows its own logo (Claude, Codex, Gemini, OpenCode, Grok); custom commands a terminal
const brand = (agent: BrandAgent): ComponentType<IconProps> =>
  function Brand({ size, className }: IconProps) {
    return <BrandIcon agent={agent} size={size} className={className} />;
  };

export const AGENT_ICONS: Record<AgentKind, ComponentType<IconProps>> = {
  claude: brand('claude'),
  codex: brand('codex'),
  gemini: brand('gemini'),
  opencode: brand('opencode'),
  grok: brand('grok'),
  custom: SquareTerminal,
};

export function AgentIcon({ agent, size = 13, className }: { agent: AgentKind | undefined; size?: number; className?: string }) {
  const kind = agent ?? 'claude';
  if (kind === 'custom') return <SquareTerminal size={size} className={className} aria-label={AGENT_META.custom.label} />;
  return <BrandIcon agent={kind} size={size} className={className} label={AGENT_META[kind].label} />;
}
