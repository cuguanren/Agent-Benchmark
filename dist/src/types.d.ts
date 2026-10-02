export type Strategy = 'local-summary' | 'window-reset';
export type FailureCode = 'context_exhausted' | 'summary_failed' | 'budget_exhausted' | 'output_limit' | 'cancelled' | 'storage_failed' | 'invalid_input' | 'provider_failed';
export declare class BenchmarkError extends Error {
    readonly code: FailureCode;
    readonly retryable: boolean;
    constructor(code: FailureCode, message: string, retryable?: boolean);
}
export declare class ContextOverflow extends Error {
}
export interface Message {
    id: string;
    windowId: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    text: string;
    kind: 'initial' | 'normal' | 'summary' | 'reminder';
    toolCallId?: string;
    toolName?: string;
}
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
export interface Config {
    capacityTokens: number;
    triggerTokens: number;
    outputReserveTokens: number;
    scope: 'total' | 'body-after-prefix';
    userRetentionTokens: number;
    summaryOutputTokens: number;
    totalTokenBudget: number;
    summaryRetries: number;
    timeoutMs: number;
    reminderTokens: number;
    hintBytes: number;
    tools: ToolDefinition[];
}
export declare const DEFAULT_CONFIG: Config;
export declare function resolveConfig(input?: Partial<Config>): Config;
export declare function hash(value: unknown): string;
export declare function truncateBytes(text: string, maxBytes: number): string;
export declare function estimateText(text: string): number;
export declare function estimateInput(messages: readonly Message[], tools?: ToolDefinition[]): number;
/** A call and result form one indivisible unit. P0 supports one call per assistant message. */
export declare function messageUnits(messages: readonly Message[]): Message[][];
/** inputTokens includes cached input; cacheReadTokens is a subset, never added a second time. */
export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
}
export interface ModelRequest {
    messages: Message[];
    tools: ToolDefinition[];
    maxOutputTokens: number;
    purpose: 'agent' | 'summary';
    signal: AbortSignal;
}
export interface ModelResult {
    text: string;
    usage?: Usage;
}
export interface Model {
    generate(request: ModelRequest): Promise<ModelResult>;
}
export interface CallRecord {
    id: string;
    purpose: 'agent' | 'summary';
    status: 'pending' | 'success' | 'failed';
    reservedTokens: number;
    chargedTokens: number;
    measurement: 'actual' | 'estimated';
    inputTokens: number | null;
    outputTokens: number | null;
    failureCode?: FailureCode | 'context_overflow';
}
export interface Window {
    number: number;
    firstId: string;
    currentId: string;
    previousId: string | null;
    baselineTokens: number;
}
export interface Snapshot {
    id: string;
    strategy: Strategy;
    initial: string;
    config: Config;
    window: Window;
    active: Message[];
    notes: Record<string, string>;
    calls: CallRecord[];
    reminderSent: boolean;
    requestedReset: boolean;
}
export interface JournalEvent {
    schemaVersion: 1;
    seq: number;
    type: string;
    data: unknown;
    previousHash: string;
    hash: string;
}
