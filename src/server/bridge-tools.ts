// Registry of tools that the agentarmy MCP server (running inside every console) exposes to Claude.
// The MCP process is a thin proxy: it lists tools from GET /bridge/:consoleId/tools and forwards
// calls to POST /bridge/:consoleId/tools/:name. All logic lives here in the AgentArmy server.

export interface BridgeToolContent {
  type: 'text' | 'image';
  text?: string; // for 'text'
  data?: string; // base64, for 'image'
  mimeType?: string; // for 'image', e.g. 'image/png'
}

export interface BridgeToolResult {
  content: BridgeToolContent[];
  isError?: boolean;
}

export interface BridgeTool {
  name: string; // snake_case, shown to Claude as mcp__agentarmy__<name>
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  // consoleId is the console whose Claude called the tool
  handler: (consoleId: string, input: Record<string, unknown>) => Promise<BridgeToolResult>;
}

const tools = new Map<string, BridgeTool>();

export function registerBridgeTool(tool: BridgeTool): void {
  tools.set(tool.name, tool);
}

export function listBridgeTools(): BridgeTool[] {
  return [...tools.values()];
}

export function getBridgeTool(name: string): BridgeTool | undefined {
  return tools.get(name);
}

export function textResult(text: string, isError = false): BridgeToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
