import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type {
  AppSettings,
  PermissionModeSetting,
  PublicSettings,
  StartupResume,
  WebhookInfo,
} from '../shared/protocol.js';
import { agentArmyHome } from './store.js';

// App settings, persisted next to state.json. Webhook URLs are secrets: they are stored here
// but never sent back to the browser (see publicView) and never logged.

export interface StoredSettings extends AppSettings {
  slackWebhookUrl: string;
  discordWebhookUrl: string;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  model: '',
  permissionMode: '',
  extraArgs: '',
  enableTasks: true,
  useApiKey: false,
  claudePath: '',
  startupResume: 'ask',
  browserPath: '',
  slackWebhookUrl: '',
  discordWebhookUrl: '',
};

export class SettingsError extends Error {}

const PERMISSION_MODES: PermissionModeSetting[] = ['', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
const STARTUP_MODES: StartupResume[] = ['ask', 'always', 'never'];
// Flags AgentArmy sets itself; letting the user pass them would break resume, hooks or the bridge
const RESERVED_FLAGS = ['--session-id', '--resume', '-r', '--continue', '-c', '--settings', '--mcp-config', '--print', '-p'];
const MODEL_RE = /^[A-Za-z0-9._:\-[\]]{1,100}$/;
const MAX_TEXT = 1000;

// Shell-like split: whitespace separates, single or double quotes group, backslash escapes
// a quote inside double quotes. No variables, globs or other shell features.
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && input[i + 1] === '"') current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (quote) throw new SettingsError('Extra flags have an unclosed quote');
  if (has) out.push(current);
  return out;
}

function validateExtraArgs(value: string): void {
  const args = splitArgs(value);
  for (const arg of args) {
    const flag = arg.split('=')[0];
    if (RESERVED_FLAGS.includes(flag)) {
      throw new SettingsError(`${flag} is managed by AgentArmy and cannot be set here`);
    }
    // cmd.exe (used for .cmd shims on Windows) cannot pass a literal double quote safely
    if (arg.includes('"')) throw new SettingsError('Extra flags cannot contain a literal double quote');
  }
}

export function isSlackWebhook(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/.test(url);
}

export function isDiscordWebhook(url: string): boolean {
  return /^https:\/\/((ptb|canary)\.)?discord(app)?\.com\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url);
}

function text(key: string, value: unknown): string {
  if (typeof value !== 'string') throw new SettingsError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) throw new SettingsError(`${key} is too long`);
  return trimmed;
}

function bool(key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SettingsError(`${key} must be true or false`);
  return value;
}

// Validates a PATCH body; unknown keys are rejected so typos don't silently do nothing
export function validatePatch(raw: unknown): Partial<StoredSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettingsError('Expected a JSON object');
  }
  const out: Partial<StoredSettings> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case 'model': {
        const model = text(key, value);
        if (model && !MODEL_RE.test(model)) throw new SettingsError('Model must be a model alias or id, like "sonnet" or "claude-opus-4-1"');
        out.model = model;
        break;
      }
      case 'permissionMode':
        if (!PERMISSION_MODES.includes(value as PermissionModeSetting)) {
          throw new SettingsError(`permissionMode must be one of ${PERMISSION_MODES.filter(Boolean).join(', ')} or ""`);
        }
        out.permissionMode = value as PermissionModeSetting;
        break;
      case 'extraArgs': {
        const args = text(key, value);
        validateExtraArgs(args);
        out.extraArgs = args;
        break;
      }
      case 'enableTasks':
      case 'useApiKey':
        out[key] = bool(key, value);
        break;
      case 'claudePath':
      case 'browserPath':
        out[key] = text(key, value);
        break;
      case 'startupResume':
        if (!STARTUP_MODES.includes(value as StartupResume)) {
          throw new SettingsError(`startupResume must be one of ${STARTUP_MODES.join(', ')}`);
        }
        out.startupResume = value as StartupResume;
        break;
      case 'slackWebhookUrl': {
        const url = text(key, value);
        if (url && !isSlackWebhook(url)) throw new SettingsError('Slack webhook must look like https://hooks.slack.com/services/...');
        out.slackWebhookUrl = url;
        break;
      }
      case 'discordWebhookUrl': {
        const url = text(key, value);
        if (url && !isDiscordWebhook(url)) throw new SettingsError('Discord webhook must look like https://discord.com/api/webhooks/...');
        out.discordWebhookUrl = url;
        break;
      }
      default:
        throw new SettingsError(`Unknown setting: ${key}`);
    }
  }
  return out;
}

// Extra claude arguments for a newly launched or restarted console
export function claudeLaunchArgs(settings: AppSettings): string[] {
  const args: string[] = [];
  if (settings.model) args.push('--model', settings.model);
  if (settings.permissionMode) args.push('--permission-mode', settings.permissionMode);
  if (settings.extraArgs) {
    try {
      args.push(...splitArgs(settings.extraArgs));
    } catch {
      // validated on save; a hand-edited file with a bad quote is ignored rather than breaking launches
    }
  }
  return args;
}

export function webhookInfo(url: string): WebhookInfo {
  return url ? { set: true, hint: url.slice(-4) } : { set: false, hint: '' };
}

let cachedVersion: string | null = null;

// package.json sits at the repo/package root: ../../ from src/server, ../ from dist/cli.js
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'agentarmy' && pkg.version) return (cachedVersion = pkg.version);
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  return (cachedVersion = 'unknown');
}

function sanitize(raw: unknown): StoredSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return settings;
  // Keep each valid field; a single bad value must not wipe the rest
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    try {
      Object.assign(settings, validatePatch({ [key]: value }));
    } catch {
      // ignore invalid or unknown fields from older/newer versions
    }
  }
  return settings;
}

export interface SettingsEvents {
  change: [StoredSettings];
}

// filePath null keeps settings in memory only (tests, or servers built without a store)
export class SettingsStore extends EventEmitter<SettingsEvents> {
  private current: StoredSettings;

  constructor(readonly filePath: string | null = path.join(agentArmyHome(), 'settings.json')) {
    super();
    this.current = this.load();
  }

  get(): StoredSettings {
    return this.current;
  }

  patch(raw: unknown): StoredSettings {
    const patch = validatePatch(raw);
    this.current = { ...this.current, ...patch };
    this.save();
    this.emit('change', this.current);
    return this.current;
  }

  reset(): StoredSettings {
    this.current = { ...DEFAULT_SETTINGS };
    this.save();
    this.emit('change', this.current);
    return this.current;
  }

  publicView(extra: { port: number }): PublicSettings {
    const { slackWebhookUrl, discordWebhookUrl, ...settings } = this.current;
    return {
      settings,
      slack: webhookInfo(slackWebhookUrl),
      discord: webhookInfo(discordWebhookUrl),
      version: packageVersion(),
      dataDir: agentArmyHome(),
      port: extra.port,
    };
  }

  private load(): StoredSettings {
    if (!this.filePath) return { ...DEFAULT_SETTINGS };
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      return sanitize(JSON.parse(raw));
    } catch {
      const backup = `${this.filePath}.${Date.now()}.bad`;
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        // ignore
      }
      console.warn(`[agentarmy] Could not read ${this.filePath}; saved as ${backup} and using defaults`);
      return { ...DEFAULT_SETTINGS };
    }
  }

  // Atomic write like StateStore; 0600 because the file holds webhook secrets
  private save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(this.current, null, 2);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.filePath);
    } catch {
      fs.writeFileSync(this.filePath, json, { mode: 0o600 });
      fs.rmSync(tmp, { force: true });
    }
  }
}

// The live store, for modules that are not handed one explicitly (browser tiles)
let active: SettingsStore | null = null;

export function setActiveSettings(store: SettingsStore | null): void {
  active = store;
}

export function activeSettings(): StoredSettings {
  return active?.get() ?? DEFAULT_SETTINGS;
}
