import type { FastifyInstance } from 'fastify';
import type { ConsoleManager } from './consoles.js';

export interface OrchestrationOptions {
  manager: ConsoleManager;
  port: number;
  token: string;
}

// Jobs, actions, todos/activity/model tracking, and the /bridge routes used by the MCP server.
export async function registerOrchestrationRoutes(
  _app: FastifyInstance,
  _options: OrchestrationOptions,
): Promise<void> {
  // implemented by the orchestration work stream
}
