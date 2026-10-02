import { randomUUID } from 'node:crypto';
import { BenchmarkError, ContextOverflow, estimateInput, estimateText, messageUnits } from './types.js';
export function callModel(session, model, options) {
    return session.exclusive(() => invokeModel(session, model, options));
}
/** Internal entry point for an already serialized transition. */
export async function invokeModel(session, model, options) {
    const config = session.snapshot.config;
    if (options.signal?.aborted)
        throw new BenchmarkError('cancelled', 'Request cancelled');
    messageUnits(options.messages);
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)
        throw new BenchmarkError('invalid_input', 'Output limit must be positive');
    const tools = options.purpose === 'agent' ? config.tools : [];
    const input = estimateInput(options.messages, tools);
    if (input + options.maxOutputTokens > config.capacityTokens)
        throw new ContextOverflow('Estimated request exceeds capacity');
    const reserved = input + options.maxOutputTokens;
    if (session.spentTokens + reserved > config.totalTokenBudget)
        throw new BenchmarkError('budget_exhausted', 'Request exceeds remaining task budget');
    const pending = { id: randomUUID(), purpose: options.purpose, status: 'pending', reservedTokens: reserved,
        chargedTokens: reserved, measurement: 'estimated', inputTokens: null, outputTokens: null };
    session.record('model/request', pending);
    session.record('model/input', { callId: pending.id, messages: options.messages, tools, maxOutputTokens: options.maxOutputTokens });
    const controller = new AbortController();
    let timer;
    let onAbort;
    let completed = false;
    try {
        const cancelled = new Promise((_, reject) => {
            const cancel = (message) => { controller.abort(); reject(new BenchmarkError('cancelled', message)); };
            onAbort = () => cancel('Request cancelled');
            options.signal?.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => cancel('Model request timed out'), config.timeoutMs);
            if (options.signal?.aborted)
                onAbort();
        });
        const result = await Promise.race([model.generate({ ...options, tools, signal: controller.signal }), cancelled]);
        if (!result || typeof result.text !== 'string')
            throw new BenchmarkError('provider_failed', 'Invalid model output');
        const usage = result.usage;
        if (usage && (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
            || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
            || (usage.cacheReadTokens !== undefined && (!Number.isSafeInteger(usage.cacheReadTokens) || usage.cacheReadTokens < 0 || usage.cacheReadTokens > usage.inputTokens)))) {
            throw new BenchmarkError('provider_failed', 'Invalid provider usage');
        }
        const call = { ...pending, status: 'success', chargedTokens: usage ? usage.inputTokens + usage.outputTokens : input + estimateText(result.text),
            measurement: usage ? 'actual' : 'estimated', inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
        session.record('model/response', call);
        completed = true;
        session.record('model/output', { callId: call.id, text: result.text });
        if (session.spentTokens > config.totalTokenBudget)
            throw new BenchmarkError('budget_exhausted', 'Reported consumption exceeded task budget');
        return result;
    }
    catch (error) {
        if (!completed && !(error instanceof BenchmarkError && error.code === 'storage_failed'))
            session.record('model/response', { ...pending, status: 'failed',
                failureCode: error instanceof ContextOverflow ? 'context_overflow' : error instanceof BenchmarkError ? error.code : 'provider_failed' });
        if (error instanceof BenchmarkError || error instanceof ContextOverflow)
            throw error;
        throw new BenchmarkError('provider_failed', 'Model request failed');
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (onAbort)
            options.signal?.removeEventListener('abort', onAbort);
    }
}
