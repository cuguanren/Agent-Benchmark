import { createHash } from 'node:crypto';
export class BenchmarkError extends Error {
    code;
    retryable;
    constructor(code, message, retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}
export class ContextOverflow extends Error {
}
export const DEFAULT_CONFIG = {
    capacityTokens: 8192, triggerTokens: 6000, outputReserveTokens: 512, scope: 'total',
    userRetentionTokens: 20_000, summaryOutputTokens: 512, totalTokenBudget: 100_000,
    summaryRetries: 1, timeoutMs: 30_000, reminderTokens: 512, hintBytes: 4000, tools: [],
};
export function resolveConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new BenchmarkError('invalid_input', 'Configuration must be an object');
    const config = { ...DEFAULT_CONFIG, ...input };
    for (const [key, value] of Object.entries(config)) {
        if (!(key in DEFAULT_CONFIG))
            throw new BenchmarkError('invalid_input', `Unknown config field: ${key}`);
        if (key === 'scope' || key === 'tools')
            continue;
        if (!Number.isSafeInteger(value) || value < 0)
            throw new BenchmarkError('invalid_input', `Invalid ${key}`);
    }
    if (!['total', 'body-after-prefix'].includes(config.scope) || !Array.isArray(config.tools)
        || config.tools.some(t => !t || typeof t.name !== 'string' || !t.name || typeof t.description !== 'string' || typeof t.parameters !== 'object' || !t.parameters || Array.isArray(t.parameters))
        || config.capacityTokens <= config.outputReserveTokens || config.triggerTokens < 1
        || config.triggerTokens > config.capacityTokens - config.outputReserveTokens
        || config.summaryOutputTokens < 1 || config.totalTokenBudget < 1 || config.timeoutMs < 1
        || config.hintBytes > 4000)
        throw new BenchmarkError('invalid_input', 'Invalid window, tools or budget configuration');
    return structuredClone(config);
}
export function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function truncateBytes(text, maxBytes) {
    let result = '';
    let used = 0;
    for (const char of text) {
        const n = Buffer.byteLength(char);
        if (used + n > maxBytes)
            break;
        result += char;
        used += n;
    }
    return result;
}
export function estimateText(text) { return Math.ceil(Buffer.byteLength(text) / 4); }
export function estimateInput(messages, tools = []) {
    return messages.reduce((n, m) => n + 6 + estimateText(m.text) + (m.toolCallId ? estimateText(m.toolCallId) : 0), 0)
        + (tools.length ? estimateText(JSON.stringify(tools)) : 0);
}
/** A call and result form one indivisible unit. P0 supports one call per assistant message. */
export function messageUnits(messages) {
    const units = [];
    const ids = new Set();
    for (let i = 0; i < messages.length; i++) {
        const item = messages[i];
        if (item.role === 'tool')
            throw new BenchmarkError('invalid_input', 'Orphan tool result');
        if (item.toolCallId) {
            const result = messages[++i];
            if (item.role !== 'assistant' || !result || result.role !== 'tool' || result.toolCallId !== item.toolCallId || ids.has(item.toolCallId)) {
                throw new BenchmarkError('invalid_input', 'Unbalanced or duplicate tool call');
            }
            ids.add(item.toolCallId);
            units.push([item, result]);
        }
        else
            units.push([item]);
    }
    return units;
}
