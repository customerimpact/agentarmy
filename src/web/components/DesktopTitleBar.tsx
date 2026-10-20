import { useEffect, useState } from 'react';
import { DESKTOP_TITLE_BAR_HEIGHT } from '../../shared/desktop-api';
import { attentionCount, needsYouLabel } from '../lib/fleet';
import { useBoard } from '../lib/store';

// Desktop app only (see lib/desktop.ts): the window has no native title bar, so this strip is the
// draggable area. Windows draws the minimize/maximize/close buttons over its right end, macOS its
// traffic lights over the left end.
const IS_MAC = window.agentarmyDesktop?.platform === 'darwin';
const WINDOW_BUTTONS_WIDTH = IS_MAC ? 12 : 144;
const TRAFFIC_LIGHTS_WIDTH = IS_MAC ? 80 : 12;

function useDocumentTitle(): string {
  const [title, setTitle] = useState(document.title);
  useEffect(() => {
    const element = document.querySelector('title');
    if (!element) return;
    const observer = new MutationObserver(() => setTitle(document.title));
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return title;
}

export function DesktopTitleBar() {
  const title = useDocumentTitle().replace(/^\(\d+\)\s*/, '');
  const count = useBoard((s) => (s.loaded ? attentionCount(s.consoles, s.actions) : 0));

  return (
    <div
      data-desktop-titlebar
      className="aa-titlebar flex shrink-0 items-center gap-2 border-b border-line bg-surface text-fg select-none"
      style={{ height: DESKTOP_TITLE_BAR_HEIGHT, paddingLeft: TRAFFIC_LIGHTS_WIDTH, paddingRight: WINDOW_BUTTONS_WIDTH }}
      onDoubleClick={(e) => e.preventDefault()}
    >
      <img src="/icon.svg" alt="" className="size-4" draggable={false} />
      <span className="truncate text-[12px] font-medium text-fg-muted">{title || 'AgentArmy'}</span>
      {count > 0 && (
        <button
          type="button"
          onClick={() => useBoard.getState().setSidebarTab('actions')}
          className="rounded-full bg-needs px-2 py-px text-[11px] font-semibold text-black
                     hover:brightness-110"
        >
          {needsYouLabel(count)}
        </button>
      )}
    </div>
  );
}
