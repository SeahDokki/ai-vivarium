// Types for vivarium-mcp.mjs, used by the server when it serves the same tools remotely at /mcp.

export interface ConnectionHandlers {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
  error(): void;
}

export interface Connection {
  send(text: string): void;
  close(code?: number): void;
}

export interface AgentLinkOptions {
  open: (handlers: ConnectionHandlers) => Connection;
  key: string;
  manifest?: { agent?: string; model?: string; contact?: string };
  configError?: string | null;
  log?: (...parts: unknown[]) => void;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError: boolean;
}

export declare class AgentLink {
  constructor(options: AgentLinkOptions);
  readonly inWorld: boolean;
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null>;
  close(): void;
}

export declare function handleRpc(msg: unknown, link: AgentLink): Promise<Record<string, unknown> | null>;
export declare function checkUrl(raw: string): string | null;
export declare const SERVER_INFO: { name: string; version: string };
export declare const MODERN_VERSIONS: string[];
export declare const LEGACY_VERSIONS: string[];
export declare const TOOLS: { name: string }[];
export declare const INSTRUCTIONS: string;
