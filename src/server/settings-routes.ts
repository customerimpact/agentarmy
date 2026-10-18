import type { FastifyInstance } from 'fastify';
import type { PublicSettings, WebhookKind } from '../shared/protocol.js';
import { SettingsError, type SettingsStore } from './settings.js';
import type { WebhookNotifier } from './webhooks.js';

export interface SettingsRouteOptions {
  settings: SettingsStore;
  notifier: WebhookNotifier;
  port: number;
}

export async function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): Promise<void> {
  const { settings, notifier, port } = options;
  const view = (): PublicSettings => settings.publicView({ port });

  app.get('/api/settings', async () => view());

  app.patch('/api/settings', async (request, reply) => {
    try {
      settings.patch(request.body ?? {});
      return view();
    } catch (err) {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/settings/reset', async () => {
    settings.reset();
    return view();
  });

  app.post('/api/settings/test-webhook', async (request, reply) => {
    const kind = (request.body as { kind?: unknown } | undefined)?.kind;
    if (kind !== 'slack' && kind !== 'discord') {
      return reply.code(400).send({ error: 'kind must be "slack" or "discord"' });
    }
    try {
      await notifier.sendTest(kind as WebhookKind);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
