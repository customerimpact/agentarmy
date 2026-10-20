import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xterm/xterm/css/xterm.css';
import '../styles.css';
import { initTheme } from '../lib/theme';
import { PhoneApp } from './PhoneApp';

// The phone page (src/web/phone.html), served by the phone server (src/server/phone) on the local network
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
);
