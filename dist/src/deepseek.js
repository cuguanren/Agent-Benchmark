import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { BenchmarkError } from './types.js';
export const ONLINE_MODEL = 'deepseek-flash';
export function officialAdapter(apiKey) {
    if (!apiKey.trim())
        throw new BenchmarkError('invalid_input', 'DEEPSEEK_API_KEY is required');
    const options = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, thinking: 'disabled', reasoningEffort: 'off', maxTokens: 512,
        defaultContextWindow: 1_000_000, streamIdleTimeoutMs: 60_000, models: [{ id: ONLINE_MODEL, contextWindow: 1_000_000, maxTokens: 512 }] });
    const userId = randomUUID();
    return new DeepSeekAdapter({ options: () => ({ ...options, apiKeyEnv: credentialRef('DEEPSEEK_API_KEY'), retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'benchmark') }),
        resolveApiKey: async () => apiKey.trim(), resolveUserId: () => userId });
}
/** Raw TTY input suppresses credential echo; the value remains only in memory. */
export async function readApiKey(fromStdin) {
    if (!fromStdin) {
        const key = process.env.DEEPSEEK_API_KEY;
        if (!key?.trim())
            throw new BenchmarkError('invalid_input', 'Set DEEPSEEK_API_KEY or use --key-stdin');
        return key.trim();
    }
    return new Promise((resolve, reject) => {
        let buffer = '';
        const raw = process.stdin.isTTY;
        if (raw)
            process.stdin.setRawMode(true);
        const cleanup = () => { process.stdin.removeListener('data', onData); process.stdin.removeListener('end', onEnd); if (raw)
            process.stdin.setRawMode(false); process.stdin.pause(); };
        const onEnd = () => { cleanup(); reject(new BenchmarkError('invalid_input', 'No API key on stdin')); };
        const onData = (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('\u0003') || buffer.length > 512) {
                cleanup();
                reject(new BenchmarkError('cancelled', 'Credential input cancelled'));
                return;
            }
            if (/[\r\n]/.test(buffer)) {
                cleanup();
                const key = buffer.split(/[\r\n]/)[0].trim();
                if (key)
                    resolve(key);
                else
                    reject(new BenchmarkError('invalid_input', 'Empty API key'));
            }
        };
        process.stdin.on('data', onData);
        process.stdin.once('end', onEnd);
        process.stdin.resume();
    });
}
