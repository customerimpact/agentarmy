import { Asterisk, Braces, Code, Sparkles, SquareTerminal, Zap, type LucideIcon } from 'lucide-react';
import { AGENT_META, type AgentKind } from '../../shared/agents';

// Plain generic marks (no vendor logos) so each CLI is recognisable on the board
export const AGENT_ICONS: Record<AgentKind, LucideIcon> = {
  claude: Asterisk,
  codex: Braces,
  gemini: Sparkles,
  opencode: Code,
  grok: Zap,
  custom: SquareTerminal,
};

export function AgentIcon({ agent, size = 13, className }: { agent: AgentKind | undefined; size?: number; className?: string }) {
  const Icon = AGENT_ICONS[agent ?? 'claude'];
  return <Icon size={size} className={className} aria-label={AGENT_META[agent ?? 'claude'].label} />;
}
