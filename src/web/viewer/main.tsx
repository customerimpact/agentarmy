import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import '../styles.css';
import { ViewerApp } from './ViewerApp';

// gridhive.dev/s/<id>: a live, read-only view of a board someone shared (built into site/app)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewerApp />
  </StrictMode>,
);
