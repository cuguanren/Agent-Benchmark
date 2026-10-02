import { randomUUID } from 'node:crypto';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import CompactionEngine, { CompactionId, ManualCompactionError, compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { createUserMessage, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BenchmarkError, estimateText, hash, resolveConfig, truncateBytes } from './types.js';
import { normalizeUsage } from './dsh.js';
import { SUMMARY_PREFIX, SUMMARIZATION_PROMPT } from './strategies.js';
export function blockText(blocks) {
    return blocks.map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? blockText(b.content) : b.type === 'tool-call' ? `${b.name} ${b.arguments}` : '').join('\n');
}
export function requestSize(messages, system = '', tools = []) {
    return estimateText(system) + messages.reduce((sum, m) => sum + 6 + estimateText(JSON.stringify(m.content)), 0)
        + (tools.length ? estimateText(JSON.stringify(tools)) : 0);
}
/** Keeps multi-call assistant blocks and all matching results indivisible. */
export function nativeUnits(messages) {
    const units = [];
    let current = [];
    const pending = new Set();
    const seen = new Set();
    for (const m of messages) {
        if (!pending.size && current.length) {
            units.push(current);
            current = [];
        }
        if (pending.size && m.source.kind !== 'tool')
            throw new BenchmarkError('invalid_input', 'Interrupted native tool batch');
        current.push(m);
        for (const b of m.content) {
            if (b.type === 'tool-call') {
                if (seen.has(b.id))
                    throw new BenchmarkError('invalid_input', 'Duplicate native tool ID');
                pending.add(b.id);
                seen.add(b.id);
            }
            if (b.type === 'tool-result' && !pending.delete(b.toolCallId))
                throw new BenchmarkError('invalid_input', 'Orphan native result');
        }
    }
    if (pending.size)
        throw new BenchmarkError('invalid_input', 'Unfinished native tool batch');
    if (current.length)
        units.push(current);
    return units;
}
export function readNativeState(session) {
    for (const e of [...session.events].reverse()) {
        if (e.type === 'benchmark/state')
            return structuredClone(e.data);
        if (e.type === 'benchmark/request')
            return structuredClone(e.data.state);
        if (e.type === 'user/message') {
            const source = e.data.source;
            if (source.benchmarkState)
                return structuredClone(source.benchmarkState);
        }
    }
    return undefined;
}
export class NativeContextStrategy extends CompactionEngine {
    options;
    static inject = ['llm', 'agents', 'sessions', 'tools', 'systemPrompt'];
    config;
    budget;
    attached = new Map();
    attaching = new Map();
    toolDisposers = new Map();
    accounted = new Map();
    overflowRetries = new Set();
    constructor(ctx, options) {
        super(ctx);
        this.options = options;
        this.config = resolveConfig(options.config);
        this.budget = options.budget ?? { spent: 0 };
        if (!['local-summary', 'window-reset'].includes(options.strategy))
            throw new BenchmarkError('invalid_input', 'Invalid native strategy');
        ctx.on('agent/disposed', ({ agent }) => this.detach(agent));
        if (options.autoAttach) {
            ctx.on('agent/created', ({ agent }) => {
                this.state(agent.session); // synchronous checkpoint validation vetoes invalid publication
                void this.attach(agent).catch(error => ctx.logger.warn(`Benchmark attachment failed: ${String(error)}`));
            });
            ctx.on('agent/request', async (payload, next) => {
                const request = await next();
                if (!this.attached.has(payload.agent.id))
                    return request;
                return { ...request, maxTokens: Math.min(request.maxTokens ?? this.config.outputReserveTokens, this.config.outputReserveTokens) };
            });
        }
        ctx.effect(() => async () => {
            await Promise.all([...this.attached.values()].map(agent => agent.whenIdle()));
            for (const agent of this.attached.values())
                this.detach(agent);
            this.attaching.clear();
            this.overflowRetries.clear();
        });
        ctx.on('agent/pre-step', async (payload, next) => {
            if (options.autoAttach)
                await this.attach(payload.agent);
            if (!this.attached.has(payload.agent.id))
                return next();
            const decision = await next();
            if (decision.kind === 'reject')
                return decision;
            const agent = payload.agent;
            const state = this.state(agent.session);
            const header = await this.header(agent, payload.signal);
            const input = requestSize([...agent.session.deriveMessages(), ...decision.messages], header.system, header.tools);
            const body = this.config.scope === 'total' ? input : Math.max(0, input - state.baselineTokens);
            const remaining = Math.min(this.config.triggerTokens - body, this.config.capacityTokens - this.config.outputReserveTokens - input);
            if (state.requested || remaining <= 0)
                await this.compact(agent, payload.signal, decision.messages);
            else if (state.strategy === 'window-reset' && !state.reminded && remaining <= this.config.reminderTokens) {
                state.reminded = true;
                this.save(agent.session, state);
                decision.messages.push(createUserMessage({ source: { kind: 'plugin', plugin: 'agent-benchmark' }, content: [{ type: 'text', text: 'Window budget is low. Explicitly save useful task state in notes, or retain history item IDs, before the next window.' }] }));
            }
            return decision;
        });
        ctx.on('agent/request-error', async (payload, next) => {
            const key = `${payload.agent.id}:${payload.turn}:${payload.step}`;
            if (!this.attached.has(payload.agent.id) || payload.failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || this.overflowRetries.has(key))
                return next();
            this.overflowRetries.add(key);
            const result = await this.compact(payload.agent, payload.signal);
            return result ? { kind: 'retry' } : next();
        });
        const self = this;
        ctx.on('llm/stream', async function* (options, next) {
            const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
            if (!agent || !self.attached.has(agent.id)) {
                yield* next();
                return;
            }
            const state = self.state(agent.session);
            const maxTokens = options.maxTokens;
            if (!maxTokens || !Number.isSafeInteger(maxTokens))
                throw new LlmError('Finite benchmark output limit required', 'BENCHMARK_INVALID_INPUT');
            const input = requestSize(options.messages, options.system, options.tools);
            const reserved = input + maxTokens;
            const spent = state.calls.reduce((n, c) => n + c.chargedTokens, 0);
            if (input + maxTokens > self.config.capacityTokens)
                throw new LlmError('Benchmark request capacity exceeded', CONTEXT_WINDOW_EXCEEDED_CODE);
            if (state.calls.length >= (self.options.maxCalls ?? 32) || spent + reserved > self.config.totalTokenBudget
                || self.budget.spent + reserved > (self.options.globalTokenBudget ?? 1_000_000))
                throw new LlmError('Benchmark budget exhausted', 'BENCHMARK_BUDGET_EXHAUSTED');
            const call = { id: randomUUID(), purpose: options.purpose === 'compaction' ? 'summary' : 'agent', status: 'pending',
                reservedTokens: reserved, chargedTokens: reserved, measurement: 'estimated', inputTokens: null, outputTokens: null };
            state.calls.push(call);
            self.budget.spent += reserved;
            self.accounted.set(agent.id, spent + reserved);
            agent.session.append('benchmark/request', { state, callId: call.id, request: { messages: options.messages, system: options.system ?? '', tools: options.tools ?? [], maxTokens } });
            let usage;
            let status = 'failed';
            let failureCode = 'provider_failed';
            try {
                for await (const chunk of next()) {
                    if (chunk.type === 'usage')
                        usage = chunk.usage;
                    if (chunk.type === 'finish') {
                        status = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls' ? 'success' : 'failed';
                        failureCode = chunk.reason.kind === 'aborted' ? 'cancelled' : chunk.reason.kind === 'max-tokens' ? 'output_limit' : chunk.reason.kind === 'error' && chunk.reason.failure.code === CONTEXT_WINDOW_EXCEEDED_CODE ? 'context_overflow' : 'provider_failed';
                    }
                    yield chunk;
                }
            }
            catch (error) {
                failureCode = options.signal?.aborted ? 'cancelled' : error instanceof LlmError && error.code === CONTEXT_WINDOW_EXCEEDED_CODE ? 'context_overflow' : 'provider_failed';
                throw error;
            }
            finally {
                const latest = self.state(agent.session);
                const record = latest.calls.find(c => c.id === call.id);
                record.status = status;
                if (status === 'failed')
                    record.failureCode = failureCode;
                if (usage) {
                    const normalized = normalizeUsage(usage);
                    record.measurement = 'actual';
                    record.inputTokens = normalized.inputTokens;
                    record.outputTokens = normalized.outputTokens;
                    record.chargedTokens = normalized.inputTokens + normalized.outputTokens;
                }
                self.budget.spent += record.chargedTokens - reserved;
                self.save(agent.session, latest);
                self.accounted.set(agent.id, latest.calls.reduce((n, c) => n + c.chargedTokens, 0));
            }
        });
    }
    state(session) {
        const state = readNativeState(session);
        if (state) {
            if (state.schemaVersion !== 1 || state.configHash !== hash(this.config) || state.strategy !== this.options.strategy)
                throw new BenchmarkError('invalid_input', 'Native checkpoint configuration differs');
            if (state.firstWindowId === `${session.id}:w1`)
                return state;
            // A factory fork copies observed seed history, but starts its own budget and window IDs.
            if (!session.header.parentSession)
                throw new BenchmarkError('invalid_input', 'Native checkpoint belongs to another session');
            return { ...this.initialState(session), notes: state.notes };
        }
        return this.initialState(session);
    }
    initialState(session) {
        const window = `${session.id}:w1`;
        return { schemaVersion: 1, strategy: this.options.strategy, configHash: hash(this.config), window: 1, firstWindowId: window,
            previousWindowId: null, currentWindowId: window, baselineTokens: 0, notes: {}, calls: [], requested: false, reminded: false };
    }
    save(session, state) { session.append('benchmark/state', state); }
    attach(agent) {
        if (this.attached.has(agent.id)) {
            if (this.attached.get(agent.id) !== agent)
                return Promise.reject(new BenchmarkError('invalid_input', 'Different live Agent has the same session ID'));
            return this.attaching.get(agent.id);
        }
        this.state(agent.session);
        this.attached.set(agent.id, agent);
        const ready = this.initialize(agent);
        this.attaching.set(agent.id, ready);
        return ready;
    }
    async initialize(agent) {
        try {
            const restored = readNativeState(agent.session);
            const state = this.state(agent.session);
            if (this.options.strategy === 'window-reset')
                this.registerRecovery(agent);
            if (!restored || restored.firstWindowId !== state.firstWindowId) {
                const header = await this.header(agent, new AbortController().signal);
                state.baselineTokens = requestSize([], header.system, header.tools);
                this.save(agent.session, state);
            }
            const spent = state.calls.reduce((sum, c) => sum + c.chargedTokens, 0);
            this.budget.spent += spent - (this.accounted.get(agent.id) ?? 0);
            this.accounted.set(agent.id, spent);
        }
        catch (error) {
            this.detach(agent);
            throw error;
        }
    }
    detach(agent) {
        if (this.attached.get(agent.id) !== agent)
            return;
        for (const dispose of this.toolDisposers.get(agent.id) ?? [])
            dispose();
        this.toolDisposers.delete(agent.id);
        this.attached.delete(agent.id);
        this.attaching.delete(agent.id);
        for (const key of this.overflowRetries)
            if (key.startsWith(`${agent.id}:`))
                this.overflowRetries.delete(key);
    }
    async header(agent, signal) {
        const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
        return { system: renderPrompt(assembly), tools: assembly.tools };
    }
    registerRecovery(agent) {
        const definitions = [
            ['notes_write', 'Save a session-local checkpoint note. This is an explicit agent action.', { path: { type: 'string', required: true }, text: { type: 'string', required: true } }],
            ['notes_read', 'Read note text after a window reset; offsets are Unicode code points, maxBytes is UTF-8 bytes.', { path: { type: 'string', required: true }, offset: { type: 'integer' }, maxBytes: { type: 'integer' } }],
            ['notes_list', 'List stored note paths and sizes.', {}],
            ['notes_search', 'Literal search in note paths and text.', { query: { type: 'string', required: true } }],
            ['history_windows', 'List window identifiers in this session.', {}],
            ['history_items', 'List durable message IDs for a window.', { windowId: { type: 'string', required: true } }],
            ['history_search', 'Literal search of durable observed messages, returning stable IDs.', { query: { type: 'string', required: true } }],
            ['history_read', 'Read a durable message by stable ID; bounded text only.', { id: { type: 'string', required: true }, offset: { type: 'integer' }, maxBytes: { type: 'integer' } }],
            ['new_context', 'Request a new window at the next complete tool batch boundary; save state first.', {}],
        ];
        const disposers = [];
        this.toolDisposers.set(agent.id, disposers);
        for (const [name, description, parameters] of definitions)
            disposers.push(agent.ctx.tools.register(defineTool({ name, description, parameters,
                output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
                execute: async (args) => this.recovery(agent.session, name, args) })));
    }
    recovery(session, name, args) {
        const state = this.state(session);
        if (state.strategy !== 'window-reset')
            throw new BenchmarkError('invalid_input', 'Recovery unavailable in summary group');
        const path = args.path;
        if (name.startsWith('notes_') && name !== 'notes_list' && name !== 'notes_search' && (typeof path !== 'string' || !path || path.length > 200
            || path.includes('\\') || path.startsWith('/') || path.split('/').some(x => ['', '.', '..', '__proto__', 'constructor', 'prototype'].includes(x))))
            throw new BenchmarkError('invalid_input', 'Invalid virtual note path');
        const bounded = (text) => {
            const offset = args.offset ?? 0;
            const maxBytes = args.maxBytes ?? 4000;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16000)
                throw new BenchmarkError('invalid_input', 'Invalid read range');
            const chars = [...text];
            const output = truncateBytes(chars.slice(offset).join(''), maxBytes);
            return { text: output, nextOffset: offset + [...output].length, truncated: offset + [...output].length < chars.length };
        };
        const archive = () => {
            let windowId = state.firstWindowId;
            return session.events.flatMap(e => {
                if (e.type === 'user/message') {
                    const meta = e.data.source.benchmarkState;
                    if (meta?.firstWindowId === state.firstWindowId)
                        windowId = meta.currentWindowId;
                }
                const message = session.deriveEventMessage(e);
                return message ? [{ id: message.id, windowId, role: message.role, text: blockText(message.content) }] : [];
            });
        };
        switch (name) {
            case 'notes_write':
                if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 1_000_000)
                    throw new BenchmarkError('invalid_input', 'Invalid note text');
                state.notes[path] = args.text;
                this.save(session, state);
                return { path, bytes: Buffer.byteLength(args.text) };
            case 'notes_read':
                if (!Object.hasOwn(state.notes, path))
                    throw new BenchmarkError('invalid_input', 'Unknown note');
                return bounded(state.notes[path]);
            case 'notes_list': return { items: Object.entries(state.notes).slice(0, 50).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) })), truncated: Object.keys(state.notes).length > 50 };
            case 'notes_search': {
                if (typeof args.query !== 'string')
                    throw new BenchmarkError('invalid_input', 'Expected query');
                const hits = Object.entries(state.notes).filter(([p, t]) => p.includes(args.query) || t.includes(args.query));
                return { items: hits.slice(0, 50).map(([path]) => ({ path })), truncated: hits.length > 50 };
            }
            case 'history_windows': return { items: Array.from({ length: state.window }, (_, i) => `${session.id}:w${i + 1}`).slice(-100), truncated: state.window > 100 };
            case 'history_items':
            case 'history_search': {
                if (name === 'history_items' && (typeof args.windowId !== 'string' || !Array.from({ length: state.window }, (_, i) => `${session.id}:w${i + 1}`).includes(args.windowId)))
                    throw new BenchmarkError('invalid_input', 'Unknown history window');
                if (name === 'history_search' && typeof args.query !== 'string')
                    throw new BenchmarkError('invalid_input', 'Expected query');
                const items = archive().filter(m => name === 'history_items' ? m.windowId === args.windowId : m.text.includes(args.query));
                return { items: items.slice(0, 50).map(({ text, ...item }) => ({ ...item, bytes: Buffer.byteLength(text) })), truncated: items.length > 50 };
            }
            case 'history_read': {
                const item = archive().find(m => m.id === args.id);
                if (!item)
                    throw new BenchmarkError('invalid_input', 'Unknown history ID');
                return { id: item.id, ...bounded(item.text) };
            }
            case 'new_context':
                state.requested = true;
                this.save(session, state);
                return { requested: true };
            default: throw new BenchmarkError('invalid_input', 'Unknown native recovery tool');
        }
    }
    async compactIfNeeded(agent, trigger, signal) {
        const native = this.ctx.agents.get(agent.session.id);
        if (!native)
            throw new BenchmarkError('invalid_input', 'No live native Agent');
        const header = await this.header(native, signal);
        const state = this.state(agent.session);
        const input = requestSize(agent.session.deriveMessages(), header.system, header.tools);
        if (trigger !== 'context-overflow' && !state.requested && input - (this.config.scope === 'body-after-prefix' ? state.baselineTokens : 0) < this.config.triggerTokens && input + this.config.outputReserveTokens < this.config.capacityTokens)
            return null;
        return this.compact(native, signal);
    }
    compactNow(agent, signal, sourceCommandId) {
        signal.throwIfAborted();
        const native = this.ctx.agents.get(agent.session.id);
        if (!native)
            throw new BenchmarkError('invalid_input', 'No live native Agent');
        try {
            return agent.runMaintenance(async (inner) => {
                try {
                    return await this.compact(native, AbortSignal.any([signal, inner]), [], sourceCommandId);
                }
                catch (error) {
                    signal.throwIfAborted();
                    if (inner.aborted)
                        throw new ManualCompactionError('cancelled', 'Agent cancelled manual compaction', { cause: error });
                    if (error instanceof ManualCompactionError)
                        throw error;
                    throw new ManualCompactionError(error instanceof BenchmarkError && error.code === 'invalid_input' ? 'changed' : 'summary', 'Manual compaction failed', { cause: error });
                }
            });
        }
        catch (error) {
            throw new ManualCompactionError('busy', 'Manual compaction requires an idle Agent', { cause: error });
        }
    }
    async compactRegion(start, end, agent, signal = new AbortController().signal) {
        const nodes = agent.session.surface.nodes;
        if (start !== nodes[0] || end !== nodes.at(-1))
            throw new BenchmarkError('invalid_input', 'Window strategies support complete active surface regions only');
        const native = this.ctx.agents.get(agent.session.id);
        if (!native)
            throw new BenchmarkError('invalid_input', 'No live native Agent');
        const result = await this.compactNow(native, signal);
        if (!result)
            throw new BenchmarkError('invalid_input', 'Empty surface');
        return result;
    }
    async summarize(agent, messages, system, signal) {
        signal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        let units = nativeUnits(messages);
        let retries = 0;
        for (;;) {
            try {
                let text = '';
                let usage;
                let finish = false;
                for await (const chunk of this.ctx.llm.stream({ provider: agent.options.provider, model: agent.options.model, sessionId: agent.id,
                    system, messages: [...units.flat(), createUserMessage({ source: { kind: 'plugin', plugin: 'agent-benchmark' }, content: [{ type: 'text', text: SUMMARIZATION_PROMPT }] })],
                    maxTokens: this.config.summaryOutputTokens, purpose: 'compaction', signal })) {
                    if (chunk.type === 'block-end' && chunk.block.type === 'text')
                        text += chunk.block.text;
                    if (chunk.type === 'usage')
                        usage = chunk.usage;
                    if (chunk.type === 'finish') {
                        finish = true;
                        if (chunk.reason.kind === 'error')
                            throw new LlmError('Summary provider failed', chunk.reason.failure.code);
                        if (chunk.reason.kind !== 'stop')
                            throw new BenchmarkError(chunk.reason.kind === 'aborted' ? 'cancelled' : 'summary_failed', 'Incomplete summary');
                    }
                }
                if (!finish || !text.trim())
                    throw new BenchmarkError('summary_failed', 'Empty or unfinished summary');
                return { text: text.trim(), ...(usage ? { usage } : {}) };
            }
            catch (error) {
                if (error instanceof LlmError && error.code === CONTEXT_WINDOW_EXCEEDED_CODE && units.length)
                    units.shift();
                else if (error instanceof LlmError && ['RATE_LIMIT', 'TRANSPORT'].includes(error.code) && retries++ < this.config.summaryRetries)
                    continue;
                else
                    throw error;
            }
        }
    }
    async compact(agent, signal, pending = [], sourceCommandId) {
        signal.throwIfAborted();
        const session = agent.session;
        const messages = session.deriveMessages();
        nativeUnits(messages);
        const nodes = [...session.surface.nodes];
        if (!nodes.length)
            return null;
        const compactionId = CompactionId(randomUUID());
        const beforeSeq = session.seq;
        const state = this.state(session);
        const header = await this.header(agent, signal);
        const shadowedRange = { start: nodes[0], end: nodes.at(-1) };
        // Recheck the durable lock after the asynchronous prompt assembly.
        let open = false;
        for (const event of session.events) {
            if (event.type === 'session/end-seed' || event.type === 'compaction/end')
                open = false;
            if (event.type === 'compaction/start')
                open = true;
        }
        if (open)
            throw new ManualCompactionError('busy', 'Compaction already in progress');
        const lifecycle = { compactionId, turn: null, ...(sourceCommandId ? { sourceCommandId } : {}) };
        const shadowedTokenCount = requestSize(messages);
        const start = session.append('compaction/start', lifecycle);
        let committed = false;
        let closing = false;
        try {
            const summarized = state.strategy === 'local-summary' ? await this.summarize(agent, messages, header.system, signal) : { text: '' };
            // Re-read metering after the auxiliary call, preserving every charged attempt.
            const next = this.state(session);
            next.window++;
            next.previousWindowId = next.currentWindowId;
            next.currentWindowId = `${session.id}:w${next.window}`;
            next.requested = false;
            next.reminded = false;
            let retained = '';
            if (state.strategy === 'local-summary') {
                let remaining = this.config.userRetentionTokens;
                const parts = [];
                for (const m of [...messages].reverse())
                    if (m.role === 'user' && m.source.kind === 'user' && !isCompactCheckpointSource(m.source)) {
                        const value = blockText(m.content);
                        const keep = truncateBytes(value, remaining * 4);
                        if (keep)
                            parts.push(keep);
                        remaining -= estimateText(keep);
                        if (keep !== value || !remaining)
                            break;
                    }
                retained = parts.reverse().join('\n');
            }
            const directory = truncateBytes(Object.entries(next.notes).sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => `${p}\t${Buffer.byteLength(t)} bytes`).join('\n'), this.config.hintBytes);
            const text = [`First window: ${next.firstWindowId}`, `Previous window: ${next.previousWindowId}`, `Current window: ${next.currentWindowId}`,
                ...(state.strategy === 'local-summary' ? [retained, SUMMARY_PREFIX + summarized.text] : directory ? [`Available notes (read explicitly):\n${directory}`] : [])].filter(Boolean).join('\n');
            const source = { ...compactCheckpointSource(compactionId), benchmarkState: next };
            const replacement = createUserMessage({ source, content: [{ type: 'text', text }] });
            const size = requestSize([replacement, ...pending], header.system, header.tools);
            if (size + this.config.outputReserveTokens > this.config.capacityTokens)
                throw new BenchmarkError('context_exhausted', 'Native replacement exceeds capacity');
            if (next.calls.reduce((n, c) => n + c.chargedTokens, 0) > this.config.totalTokenBudget)
                throw new BenchmarkError('budget_exhausted', 'Native summary exceeded task budget');
            next.baselineTokens = requestSize([replacement], header.system, header.tools);
            // source was snapshotted by createUserMessage; construct again after computing the baseline.
            const checkpoint = createUserMessage({ source: { ...source, benchmarkState: next }, content: [{ type: 'text', text }] });
            signal.throwIfAborted();
            // Only auxiliary non-surface events may have been added during summarization.
            if (hash(session.surface.nodes) !== hash(nodes))
                throw new BenchmarkError('invalid_input', 'Native surface changed during compaction');
            const summaryBase = { compactionId, summary: checkpoint.content, shadowedRange, shadowedSeqs: nodes, shadowedTokenCount, provider: agent.options.provider, model: agent.options.model };
            const summary = state.strategy === 'local-summary'
                ? session.append('compaction/summary', { ...summaryBase, maxTokens: this.config.summaryOutputTokens, rawOutput: [{ type: 'text', text: summarized.text }], llmStreamCall: true, ...(summarized.usage ? { usage: summarized.usage } : {}) })
                : session.append('compaction/summary', summaryBase);
            session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', ...shadowedRange }, sourceEventSeqs: [...nodes, summary.seq] });
            committed = true;
            closing = true;
            const end = session.append('compaction/end', lifecycle);
            try {
                await this.ctx.sessions.flush(session);
            }
            catch (error) {
                session.append('benchmark/compaction-failure', { compactionId, committed, stage: 'persistence' });
                throw new ManualCompactionError('persistence', 'Compaction durability checkpoint failed after memory commit', { cause: error });
            }
            return { compactionId, startSeq: start.seq, summarySeq: summary.seq, endSeq: end.seq, summary: checkpoint.content, shadowedRange, shadowedSeqs: nodes, shadowedTokenCount };
        }
        catch (error) {
            if (!closing) {
                session.append('compaction/end', { ...lifecycle, error: `${committed ? 'committed' : 'uncommitted'}:${error instanceof BenchmarkError ? error.code : error instanceof LlmError ? error.code : 'failure'}:started-at-${beforeSeq}` });
            }
            else if (!(error instanceof ManualCompactionError))
                throw new ManualCompactionError('commit', 'Compaction close failed', { cause: error });
            throw error;
        }
    }
}
export default NativeContextStrategy;
