import { registerBridgeTool, textResult, type BridgeToolResult } from '../bridge-tools.js';
import type { BrowserServiceImpl } from './browser-service.js';
import { READ_SCRIPT } from './page-scripts.js';

// Browser tools for agents (mcp__agentarmy__browser_*). Each console drives its own linked tile,
// which the user watches live on the board, with the agent's pointer drawn on top.

const READ_LIMIT = 8000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function errorResult(err: unknown): BridgeToolResult {
  return textResult(err instanceof Error ? err.message : String(err), true);
}

export function registerBrowserTools(service: BrowserServiceImpl): void {
  const linked = async (consoleId: string) => {
    const tile = service.tileForConsole(consoleId);
    if (!tile) throw new Error('You have no browser open. Call browser_open with a URL first.');
    return { tile, session: await service.session(tile.id) };
  };
  const where = async (tile: { url: string; title: string }, session: { refreshMeta(): Promise<void> }) => {
    await session.refreshMeta();
    return `Now at ${tile.url}${tile.title ? ` — "${tile.title}"` : ''}`;
  };

  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (consoleId: string, input: Record<string, unknown>) => Promise<BridgeToolResult>,
  ) =>
    registerBridgeTool({
      name,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      handler: async (consoleId, input) => {
        try {
          return await handler(consoleId, input ?? {});
        } catch (err) {
          return errorResult(err);
        }
      },
    });

  tool(
    'browser_open',
    'Open a URL in your own live browser tile on the GridHive board (a real Chromium the user watches, next to your terminal). ' +
      'Creates the tile the first time, then reuses it. Use this instead of other browser tools when the user asks you to open, check or test a web page. ' +
      'Then use browser_screenshot to see it, browser_read for its text, and browser_click / browser_type / browser_press / browser_scroll to interact.',
    { url: { type: 'string', description: 'Full URL or bare domain (example.com, localhost:3000)' } },
    ['url'],
    async (consoleId, input) => {
      const url = str(input.url);
      if (!url) return textResult('url is required', true);
      let tile = service.tileForConsole(consoleId);
      if (!tile) tile = service.createTile({ linkedConsoleId: consoleId });
      const session = await service.session(tile.id);
      const error = await session.navigate(url);
      if (error) return textResult(`Could not load the page: ${error}`, true);
      return textResult(`Opened in browser tile ${tile.id}. ${await where(tile, session)}`);
    },
  );

  tool(
    'browser_navigate',
    'Navigate your browser tile to a URL, or go back / forward / reload.',
    {
      url: { type: 'string', description: 'URL to load (omit when using action)' },
      action: { type: 'string', enum: ['back', 'forward', 'reload'] },
    },
    [],
    async (consoleId, input) => {
      const { tile, session } = await linked(consoleId);
      const action = str(input.action);
      if (action === 'back' || action === 'forward' || action === 'reload') {
        await session.history(action);
        await session.settle();
        return textResult(await where(tile, session));
      }
      const url = str(input.url);
      if (!url) return textResult('Give a url or an action', true);
      const error = await session.navigate(url);
      if (error) return textResult(`Could not load the page: ${error}`, true);
      return textResult(await where(tile, session));
    },
  );

  tool(
    'browser_screenshot',
    'Take a screenshot of the visible part of the page in your browser tile.',
    {},
    [],
    async (consoleId) => {
      const { tile, session } = await linked(consoleId);
      const data = await session.screenshot();
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: `${await where(tile, session)} (viewport ${session.viewport.width}x${session.viewport.height})` },
        ],
      };
    },
  );

  tool(
    'browser_click',
    'Click in your browser tile: on the element matching a CSS selector, on the element whose visible text contains `text`, or at viewport pixel x,y (as seen in browser_screenshot). The user sees your pointer move and click.',
    {
      selector: { type: 'string' },
      text: { type: 'string', description: 'Visible text (or aria-label/placeholder) of the element to click' },
      x: { type: 'number' },
      y: { type: 'number' },
      double: { type: 'boolean', description: 'Double click' },
    },
    [],
    async (consoleId, input) => {
      const { tile, session } = await linked(consoleId);
      const x = num(input.x);
      const y = num(input.y);
      let target: { x: number; y: number; label: string };
      if (x !== null && y !== null && !str(input.selector) && !str(input.text)) {
        target = { x, y, label: `(${Math.round(x)}, ${Math.round(y)})` };
      } else {
        target = await session.locate(str(input.selector), str(input.text));
      }
      await session.click(target, input.double === true ? 2 : 1);
      await session.settle();
      return textResult(`Clicked ${target.label} at (${target.x}, ${target.y}). ${await where(tile, session)}`);
    },
  );

  tool(
    'browser_type',
    'Type text in your browser tile: into the element matching `selector` (clicked first), or into whatever has focus. Set submit to press Enter afterwards.',
    {
      text: { type: 'string' },
      selector: { type: 'string' },
      submit: { type: 'boolean' },
    },
    ['text'],
    async (consoleId, input) => {
      const text = typeof input.text === 'string' ? input.text : '';
      const { tile, session } = await linked(consoleId);
      const selector = str(input.selector);
      if (selector) await session.click(await session.locate(selector, null));
      if (text) await session.send('Input.insertText', { text });
      if (input.submit === true) {
        await session.pressKey('Enter');
        await session.settle();
      }
      return textResult(`Typed ${JSON.stringify(text.slice(0, 80))}${input.submit === true ? ' and pressed Enter' : ''}. ${await where(tile, session)}`);
    },
  );

  tool(
    'browser_press',
    'Press a key in your browser tile, e.g. Enter, Tab, Escape, ArrowDown, Backspace, or a combo like Control+A.',
    { key: { type: 'string' } },
    ['key'],
    async (consoleId, input) => {
      const key = str(input.key);
      if (!key) return textResult('key is required', true);
      const { tile, session } = await linked(consoleId);
      await session.pressKey(key);
      await session.settle();
      return textResult(`Pressed ${key}. ${await where(tile, session)}`);
    },
  );

  tool(
    'browser_scroll',
    'Scroll the page in your browser tile. Positive deltaY scrolls down (in pixels, e.g. 600 is about one screen).',
    { deltaY: { type: 'number' }, deltaX: { type: 'number' } },
    [],
    async (consoleId, input) => {
      const { session } = await linked(consoleId);
      const deltaY = num(input.deltaY) ?? 600;
      const deltaX = num(input.deltaX) ?? 0;
      const at = session.cursor ?? { x: session.viewport.width / 2, y: session.viewport.height / 2 };
      if (!session.cursor) await session.moveTo(at);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY });
      await new Promise((r) => setTimeout(r, 300));
      const pos = await session.evaluate<{ y: number; h: number; vh: number }>(
        '({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight })',
      );
      return textResult(`Scrolled. Now at y=${pos.y} of ${pos.h} (viewport ${pos.vh} high).`);
    },
  );

  tool(
    'browser_read',
    'Read the page in your browser tile: its visible text and a list of links, buttons and inputs (with selectors you can pass to browser_click / browser_type).',
    {},
    [],
    async (consoleId) => {
      const { session } = await linked(consoleId);
      const page = await session.evaluate<{
        url: string;
        title: string;
        text: string;
        items: { role: string; name: string; selector: string; inView: boolean }[];
        scrollY: number;
        scrollHeight: number;
        viewportHeight: number;
      }>(READ_SCRIPT);
      const text = page.text.length > READ_LIMIT ? `${page.text.slice(0, READ_LIMIT)}\n… (truncated)` : page.text;
      const items = page.items
        .map((i) => `- ${i.role}${i.name ? ` "${i.name}"` : ''}${i.selector ? `  [${i.selector}]` : ''}${i.inView ? '' : ' (off screen)'}`)
        .join('\n');
      return textResult(
        `URL: ${page.url}\nTitle: ${page.title}\nScroll: ${page.scrollY}/${page.scrollHeight} (viewport ${page.viewportHeight})\n\n` +
          `--- Text ---\n${text}\n\n--- Interactive elements ---\n${items || '(none)'}`,
      );
    },
  );

  tool(
    'browser_close',
    'Close your browser tile and remove it from the board.',
    {},
    [],
    async (consoleId) => {
      const tile = service.tileForConsole(consoleId);
      if (!tile) return textResult('You have no browser open.');
      await service.deleteTile(tile.id);
      return textResult('Browser closed.');
    },
  );
}
