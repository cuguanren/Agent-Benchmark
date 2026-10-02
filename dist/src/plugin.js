import Schema from '@deepseek-ai/schemastery';
import NativeContextStrategy from './native.js';
import { resolveConfig } from './types.js';
import { BenchmarkPersistence } from './native-persistence.js';
export const name = 'agent-benchmark';
export const inject = ['llm', 'agents', 'sessions', 'tools', 'systemPrompt', 'sessionPersistence'];
const schema = Schema.object({
    strategy: Schema.union(['local-summary', 'window-reset']).default('local-summary'),
    capacityTokens: Schema.natural().min(1).default(32768), triggerTokens: Schema.natural().min(1).default(24576),
    outputReserveTokens: Schema.natural().min(1).default(1024), scope: Schema.union(['total', 'body-after-prefix']).default('body-after-prefix'),
    userRetentionTokens: Schema.natural().default(20000), summaryOutputTokens: Schema.natural().min(1).default(1024),
    totalTokenBudget: Schema.natural().min(1).default(200000), summaryRetries: Schema.natural().max(10).default(1),
    timeoutMs: Schema.natural().min(1).max(600000).default(60000), reminderTokens: Schema.natural().default(1024),
    hintBytes: Schema.natural().max(4000).default(4000), maxCalls: Schema.natural().min(1).max(10000).default(128),
    globalTokenBudget: Schema.natural().min(1).default(5000000),
});
export const Config = Schema.transform(schema, value => {
    const { strategy, maxCalls, globalTokenBudget, ...window } = value;
    resolveConfig(window);
    if (Object.values(value).some(v => typeof v === 'number' && !Number.isSafeInteger(v)))
        throw new Error('All benchmark limits must be safe integers');
    return { strategy, maxCalls, globalTokenBudget, ...window };
});
export async function apply(ctx, options) {
    if (!(ctx.sessionPersistence instanceof BenchmarkPersistence))
        throw new Error('agent-benchmark requires its JSONL persistence bundle; enable agent-benchmark/persistence before the strategy');
    if (ctx.agents.list().some(agent => agent.status === 'running'))
        throw new Error('Change benchmark configuration only when all Agents are idle');
    const { strategy, maxCalls, globalTokenBudget, ...config } = options;
    // The bundle fiber owns the service directly; it must not inject its own child provider.
    const service = new NativeContextStrategy(ctx, { strategy, config, maxCalls, globalTokenBudget, autoAttach: true });
    for (const agent of ctx.agents.list())
        await service.attach(agent);
}
