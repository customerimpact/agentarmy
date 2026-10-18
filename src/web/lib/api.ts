import type {
  ActionItem,
  BoardState,
  BrowserTile,
  CloneRequest,
  CloneResponse,
  ConsoleInfo,
  ConsoleLayout,
  CreateConsoleRequest,
  CreateProjectRequest,
  FsListResponse,
  LaunchTemplateRequest,
  LaunchTemplateResponse,
  Project,
  PublicSettings,
  SettingsPatch,
  Template,
  UpdateConsoleRequest,
  UpdateProjectRequest,
  WebhookKind,
} from '../../shared/protocol';
import { getToken } from './auth';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-agentarmy-token'] = token;
  // Only declare JSON when there is a body: Fastify rejects an empty body sent as application/json
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    // Same-origin is the default, but be explicit: the HttpOnly auth cookie must ride along
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      message = data.message || data.error || message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const consolePath = (id: string) => `/api/consoles/${encodeURIComponent(id)}`;
const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const browserPath = (id: string) => `/api/browsers/${encodeURIComponent(id)}`;

type BrowserRequest = {
  url?: string;
  layout?: Partial<ConsoleLayout>;
  linkedConsoleId?: string | null;
};

export const api = {
  getState: () => request<BoardState>('GET', '/api/state'),
  createConsole: (req: CreateConsoleRequest) => request<ConsoleInfo>('POST', '/api/consoles', req),
  updateConsole: (id: string, req: UpdateConsoleRequest) =>
    request<ConsoleInfo>('PATCH', consolePath(id), req),
  deleteConsole: (id: string) => request<{ ok: true }>('DELETE', consolePath(id)),
  restartConsole: (id: string) => request<ConsoleInfo>('POST', `${consolePath(id)}/restart`),
  resumeAll: () => request<{ resumed: number }>('POST', '/api/resume-all'),
  putViewport: (viewport: { x: number; y: number; zoom: number }) =>
    request<{ ok: true }>('PUT', '/api/viewport', viewport),
  sendText: (id: string, text: string) =>
    request<{ ok: true }>('POST', `${consolePath(id)}/send`, { text }),
  resolveAction: (id: string, resolved: boolean) =>
    request<ActionItem>('PATCH', `/api/actions/${encodeURIComponent(id)}`, { resolved }),
  clearResolvedActions: () => request<{ removed: number }>('POST', '/api/actions/clear-resolved'),
  deleteJob: (id: string) => request<{ ok: true }>('DELETE', `/api/jobs/${encodeURIComponent(id)}`),
  createProject: (req: CreateProjectRequest) => request<Project>('POST', '/api/projects', req),
  updateProject: (id: string, req: UpdateProjectRequest) =>
    request<Project>('PATCH', projectPath(id), req),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', projectPath(id)),
  closeProject: (id: string) => request<Project>('POST', `${projectPath(id)}/close`),
  openProject: (id: string) => request<Project>('POST', `${projectPath(id)}/open`),
  listTemplates: () => request<Template[]>('GET', '/api/templates'),
  launchTemplate: (id: string, req: LaunchTemplateRequest) =>
    request<LaunchTemplateResponse>('POST', `/api/templates/${encodeURIComponent(id)}/launch`, req),
  cloneRepo: (req: CloneRequest) => request<CloneResponse>('POST', '/api/git/clone', req),
  createBrowser: (req: BrowserRequest) => request<BrowserTile>('POST', '/api/browsers', req),
  updateBrowser: (id: string, req: BrowserRequest) =>
    request<BrowserTile>('PATCH', browserPath(id), req),
  deleteBrowser: (id: string) => request<{ ok: true }>('DELETE', browserPath(id)),
  getSettings: () => request<PublicSettings>('GET', '/api/settings'),
  patchSettings: (patch: SettingsPatch) => request<PublicSettings>('PATCH', '/api/settings', patch),
  resetSettings: () => request<PublicSettings>('POST', '/api/settings/reset'),
  testWebhook: (kind: WebhookKind) =>
    request<{ ok: true }>('POST', '/api/settings/test-webhook', { kind }),
  listDir: (path?: string) =>
    request<FsListResponse>(
      'GET',
      path ? `/api/fs/list?path=${encodeURIComponent(path)}` : '/api/fs/list',
    ),
};
