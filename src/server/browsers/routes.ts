import type { FastifyInstance } from 'fastify';
import type { ConsoleManager } from '../consoles.js';

// Browser tiles: launches Chromium, streams screencast frames, forwards input.
// The returned object handles the browser-* WebSocket messages for one socket.
export interface BrowserSocketHandler {
  onMessage(msg: unknown, send: (msg: unknown) => void): boolean; // true when handled
  onClose(): void;
}

export interface BrowserService {
  forSocket(send: (msg: unknown) => void): BrowserSocketHandler;
  shutdown(): Promise<void>;
}

export async function registerBrowserRoutes(
  _app: FastifyInstance,
  _options: { manager: ConsoleManager },
): Promise<BrowserService> {
  // implemented by the browser-tiles work stream
  return {
    forSocket: () => ({ onMessage: () => false, onClose: () => undefined }),
    shutdown: async () => undefined,
  };
}
