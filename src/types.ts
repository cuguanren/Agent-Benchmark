import { createHash } from 'node:crypto';

export type Strategy = 'local-summary' | 'window-reset';
export type FailureCode = 'context_exhausted' | 'summary_failed' | 'budget_exhausted' | 'output_limit' | 'cancelled' | 'storage_failed' | 'invalid_input' | 'provider_failed';
export class BenchmarkError extends Error {
  constructor(readonly code: FailureCode, message: string, readonly retryable = false) { super(message); }
}
export class ContextOverflow extends Error {}
export interface Message {
  id: string; windowId: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string;
  kind: 'initial' | 'normal' | 'summary' | 'reminder'; toolCallId?: string; toolName?: string;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Config {
  capacityTokens: number; triggerTokens: number; outputReserveTokens: number;
  scope: 'total' | 'body-after-prefix'; userRetentionTokens: number; summaryOutputTokens: number;
  totalTokenBudget: number; summaryRetries: number; timeoutMs: number;
  reminderTokens: number; hintBytes: number; tools: ToolDefinition[];
}
export const DEFAULT_CONFIG: Config = {
  capacityTokens: 8192, triggerTokens: 6000, outputReserveTokens: 512, scope: 'total',
  userRetentionTokens: 20_000, summaryOutputTokens: 512, totalTokenBudget: 100_000,
  summaryRetries: 1, timeoutMs: 30_000, reminderTokens: 512, hintBytes: 4000, tools: [],
};
export function resolveConfig(input: Partial<Config> = {}): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BenchmarkError('invalid_input', 'Configuration must be an object');
  const config = { ...DEFAULT_CONFIG, ...input };
  for (const [key, value] of Object.entries(config)) {
    if (!(key in DEFAULT_CONFIG)) throw new BenchmarkError('invalid_input', `Unknown config field: ${key}`);
    if (key === 'scope' || key === 'tools') continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new BenchmarkError('invalid_input', `Invalid ${key}`);
  }
  if (!['total', 'body-after-prefix'].includes(config.scope) || !Array.isArray(config.tools)
    || config.tools.some(t => !t || typeof t.name !== 'string' || !t.name || typeof t.description !== 'string' || typeof t.parameters !== 'object' || !t.parameters || Array.isArray(t.parameters))
    || config.capacityTokens <= config.outputReserveTokens || config.triggerTokens < 1
    || config.triggerTokens > config.capacityTokens - config.outputReserveTokens
    || config.summaryOutputTokens < 1 || config.totalTokenBudget < 1 || config.timeoutMs < 1
    || config.hintBytes > 4000) throw new BenchmarkError('invalid_input', 'Invalid window, tools or budget configuration');
  return structuredClone(config);
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function truncateBytes(text: string, maxBytes: number): string {
  let result = ''; let used = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (used + n > maxBytes) break; result += char; used += n; }
  return result;
}
export function estimateText(text: string): number { return Math.ceil(Buffer.byteLength(text) / 4); }
export function estimateInput(messages: readonly Message[], tools: ToolDefinition[] = []): number {
  return messages.reduce((n, m) => n + 6 + estimateText(m.text) + (m.toolCallId ? estimateText(m.toolCallId) : 0), 0)
    + (tools.length ? estimateText(JSON.stringify(tools)) : 0);
}
/** A call and result form one indivisible unit. P0 supports one call per assistant message. */
export function messageUnits(messages: readonly Message[]): Message[][] {
  const units: Message[][] = []; const ids = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i]!;
    if (item.role === 'tool') throw new BenchmarkError('invalid_input', 'Orphan tool result');
    if (item.toolCallId) {
      const result = messages[++i];
      if (item.role !== 'assistant' || !result || result.role !== 'tool' || result.toolCallId !== item.toolCallId || ids.has(item.toolCallId)) {
        throw new BenchmarkError('invalid_input', 'Unbalanced or duplicate tool call');
      }
      ids.add(item.toolCallId); units.push([item, result]);
    } else units.push([item]);
  }
  return units;
}
/** inputTokens includes cached input; cacheReadTokens is a subset, never added a second time. */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
export interface ModelRequest {
  messages: Message[]; tools: ToolDefinition[]; maxOutputTokens: number;
  purpose: 'agent' | 'summary'; signal: AbortSignal;
}
export interface ModelResult { text: string; usage?: Usage }
export interface Model { generate(request: ModelRequest): Promise<ModelResult> }
export interface CallRecord {
  id: string; purpose: 'agent' | 'summary'; status: 'pending' | 'success' | 'failed';
  reservedTokens: number; chargedTokens: number; measurement: 'actual' | 'estimated';
  inputTokens: number | null; outputTokens: number | null;
  failureCode?: FailureCode | 'context_overflow';
}
export interface Window { number: number; firstId: string; currentId: string; previousId: string | null; baselineTokens: number }
export interface Snapshot {
  id: string; strategy: Strategy; initial: string; config: Config; window: Window;
  active: Message[]; notes: Record<string, string>; calls: CallRecord[];
  reminderSent: boolean; requestedReset: boolean;
}
export interface JournalEvent { schemaVersion: 1; seq: number; type: string; data: unknown; previousHash: string; hash: string }
