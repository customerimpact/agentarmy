import type { FastifyInstance } from 'fastify';
import type { ConsoleManager } from './consoles.js';

// Projects, templates, git clone and POST /api/consoles/:id/send.
export async function registerWorkspaceRoutes(
  _app: FastifyInstance,
  _options: { manager: ConsoleManager },
): Promise<void> {
  // implemented by the workspace work stream
}
