import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { DesktopTitleBar } from './components/DesktopTitleBar';
import { isDesktop, startDesktopChrome } from './lib/desktop';
import { initToken } from './lib/auth';
import { installZoomMouseFix } from './lib/zoom-mouse-fix';
import { initTheme } from './lib/theme';
import { installThemeShortcut } from './lib/theme-shortcut';

// Must run before anything renders so the token never stays in the address bar
initToken();
installZoomMouseFix();
initTheme();
installThemeShortcut();
startDesktopChrome();

// xterm measures its cell size once at open; if the webfont isn't ready yet it measures the
// fallback font and every glyph lands slightly off-grid. Wait briefly for the fonts first.
async function loadFonts(): Promise<void> {
  const fonts = Promise.all([
    document.fonts.load('13px "JetBrains Mono Variable"'),
    document.fonts.load('bold 13px "JetBrains Mono Variable"'),
    document.fonts.load('13px "Inter Variable"'),
  ]).catch(() => undefined);
  await Promise.race([fonts, new Promise((resolve) => window.setTimeout(resolve, 1500))]);
}

void loadFonts().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {isDesktop ? (
        // Desktop app: our own title strip above the app (no native title bar)
        <div className="flex h-full flex-col">
          <DesktopTitleBar />
          <div className="min-h-0 flex-1">
            <App />
          </div>
        </div>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
});
