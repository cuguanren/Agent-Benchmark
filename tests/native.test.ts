import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter, CallId, createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createNativeRuntime } from '../src/native-runtime.js';
import { blockText, nativeUnits, readNativeState } from '../src/native.js';
import { BenchmarkError, hash } from '../src/types.js';
import { officialAdapter } from '../src/deepseek.js';

class Fixture extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const visible = request.messages.map(m => blockText(m.content)).join('\n');
    const last = request.messages.at(-1)!;
    let content: ContentBlock[];
    let tool = false;
    if (request.purpose === 'compaction') content = [{ type: 'text', text: 'Observed KEY: hidden_371; answer the next query.' }];
    else if (last.source.kind === 'user' && blockText(last.content).includes('phase1')) {
      content = [{ type: 'tool-call', id: CallId(`call-${this.requests.length}`), name: 'observe', arguments: '{}' }]; tool = true;
    } else if (request.tools?.some(t => t.name === 'notes_write') && last.source.kind === 'tool' && visible.includes('phase1') && !visible.includes('notes_write')) {
      content = [{ type: 'tool-call', id: CallId(`note-${this.requests.length}`), name: 'notes_write', arguments: JSON.stringify({ path: 'state', text: 'KEY: hidden_371' }) }]; tool = true;
    } else if (blockText(last.content).includes('phase2') && !visible.includes('KEY: hidden_371') && request.tools?.some(t => t.name === 'notes_read')) {
      content = [{ type: 'tool-call', id: CallId(`read-${this.requests.length}`), name: 'notes_read', arguments: '{"path":"state"}' }]; tool = true;
    } else content = [{ type: 'text', text: visible.includes('KEY: hidden_371') ? 'hidden_371' : 'missing' }];
    for (const [index, block] of content.entries()) yield { type: 'block-end', index, block };
    yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: tool ? { kind: 'tool-calls' } : { kind: 'stop' } };
  }
}
function followup(agent: Agent, text: string): void { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); }
function observe(agent: Agent): void {
  agent.ctx.tools.register(defineTool({ name: 'observe', description: 'Observe input data.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'KEY: hidden_371' }));
}

test('native loop compacts its own surface, meters all calls, and resumes persisted state', async t => {
  for (const strategyName of ['local-summary', 'window-reset'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'native-benchmark-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new Fixture(); const runtime = await createNativeRuntime({ strategy: strategyName, adapter, root: dir, config: { capacityTokens: 8192, triggerTokens: 7000 } });
    const handle = await runtime.ctx.agents.create({ sessionId: SessionId(`native-${strategyName}`), agentOptions: { provider: 'deepseek', model: 'fixture', maxTokens: 512 } });
    observe(handle.agent); await runtime.strategy.attach(handle.agent);
    followup(handle.agent, 'phase1 observe the hidden task data and prepare for later'); await handle.agent.whenIdle();
    const original = handle.agent.session.deriveMessages(); assert.ok(original.some(m => m.source.kind === 'tool'));
    nativeUnits(original);
    const before = readNativeState(handle.agent.session)!;
    assert.equal(before.calls.length, strategyName === 'window-reset' ? 3 : 2);
    assert.ok(before.calls.every(c => c.inputTokens === 120 && c.chargedTokens === 130));
    await runtime.strategy.compactNow(handle.agent, new AbortController().signal);
    const replacement = handle.agent.session.deriveMessages(); assert.equal(replacement.length, 1);
    assert.equal(readNativeState(handle.agent.session)!.window, 2);
    assert.equal(readNativeState(handle.agent.session)!.calls.filter(c => c.purpose === 'summary').length, strategyName === 'local-summary' ? 1 : 0);
    if (strategyName === 'window-reset') assert.ok(!blockText(replacement[0]!.content).includes('hidden_371'));
    followup(handle.agent, 'phase2 return the exact key'); await handle.agent.whenIdle();
    assert.equal(blockText(handle.agent.session.deriveMessages().at(-1)!.content), 'hidden_371');
    await runtime.ctx.sessions.flush(handle.agent.session);
    const snapshot = readNativeState(handle.agent.session)!; const activeHash = hash(handle.agent.session.deriveMessages()); const id = handle.agent.id;
    await handle.dispose(); await runtime.dispose();
    const restored = await createNativeRuntime({ strategy: strategyName, adapter: new Fixture(), root: dir, config: { capacityTokens: 8192, triggerTokens: 7000 } });
    const resumed = await restored.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'deepseek', model: 'fixture', maxTokens: 512 } });
    observe(resumed.agent); await restored.strategy.attach(resumed.agent);
    assert.equal(hash(readNativeState(resumed.agent.session)), hash(snapshot));
    assert.equal(hash(resumed.agent.session.deriveMessages()), activeHash);
    assert.ok(resumed.agent.session.events.some(e => e.type === 'tool/result'));
    await resumed.dispose(); await restored.dispose();
  }
});

test('native automatic pressure and budget failure keep exact native failure evidence', async () => {
  const runtime = await createNativeRuntime({ strategy: 'window-reset', adapter: new Fixture(), config: { triggerTokens: 50, scope: 'body-after-prefix', totalTokenBudget: 4000 }, maxCalls: 3 });
  const handle = await runtime.ctx.agents.create({ sessionId: SessionId('pressure'), agentOptions: { provider: 'deepseek', model: 'fixture', maxTokens: 100 } });
  await runtime.strategy.attach(handle.agent);
  followup(handle.agent, 'background '.repeat(30)); await handle.agent.whenIdle();
  followup(handle.agent, 'second '.repeat(30)); await handle.agent.whenIdle();
  assert.ok(readNativeState(handle.agent.session)!.window > 1);
  for (let i = 0; i < 3; i++) { followup(handle.agent, 'exhaust budget'); await handle.agent.whenIdle(); }
  const end = handle.agent.session.events.filter(e => e.type === 'turn/end').at(-1)!;
  assert.equal(end.data.reason.kind, 'error');
  assert.equal(readNativeState(handle.agent.session)!.calls.length, 3);
  await handle.dispose(); await runtime.dispose();
});

test('native pairing refuses orphan or interrupted tool results', () => {
  assert.throws(() => nativeUnits([{ ...createUserMessage({ source: { kind: 'tool', callId: CallId('missing') }, content: [{ type: 'tool-result', toolCallId: CallId('missing'), content: [] }] }) }]), (e: unknown) => e instanceof BenchmarkError && e.code === 'invalid_input');
});

test('native multi-call batch is indivisible and refuses missing, duplicate or interleaved results', () => {
  const ids = [CallId('a'), CallId('b')];
  const calls = createAssistantMessage({ source: { provider: 'deepseek', model: 'fixture' }, content: ids.map(id => ({ type: 'tool-call', id, name: 'observe', arguments: '{}' })) });
  const results = ids.map(callId => createToolResultMessage({ callId, content: [{ type: 'text', text: 'observed' }], isError: false }));
  assert.deepEqual(nativeUnits([calls, ...results]).map(u => u.length), [3]);
  assert.throws(() => nativeUnits([calls, results[0]!]));
  assert.throws(() => nativeUnits([calls, results[0]!, results[0]!, results[1]!]));
  assert.throws(() => nativeUnits([calls, createUserMessage({ source: { kind: 'user' }, content: [] }), ...results]));
});

test('native empty summary, cancellation and deadline preserve active surface and charged auxiliary attempts', async () => {
  for (const failure of ['empty', 'cancel', 'timeout'] as const) {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    class FailingSummary extends Fixture {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.purpose !== 'compaction') { yield* super.stream(options); return; }
        entered();
        if (failure !== 'empty') await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        yield { type: 'usage', usage: { inputTokens: 90, outputTokens: 0 } };
        yield { type: 'finish', reason: failure !== 'empty' ? { kind: 'aborted', failure: { message: 'fixture cancel', code: 'ABORTED' } } : { kind: 'stop' } };
      }
    }
    const runtime = await createNativeRuntime({ strategy: 'local-summary', adapter: new FailingSummary(), config: { capacityTokens: 8192, triggerTokens: 7000, timeoutMs: failure === 'timeout' ? 20 : 60000 } });
    const handle = await runtime.ctx.agents.create({ sessionId: SessionId(`native-failure-${failure}`), agentOptions: { provider: 'deepseek', model: 'fixture', maxTokens: 512 } });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      observe(handle.agent); await runtime.strategy.attach(handle.agent); followup(handle.agent, 'phase1'); await handle.agent.whenIdle();
      const surface = hash(handle.agent.session.deriveMessages()); const controller = new AbortController();
      const result = runtime.strategy.compactNow(handle.agent, controller.signal); const rejected = assert.rejects(result);
      await ready; if (failure === 'cancel') controller.abort(); await rejected;
      const state = readNativeState(handle.agent.session)!;
      assert.equal(state.window, 1); assert.equal(hash(handle.agent.session.deriveMessages()), surface);
      const auxiliary = state.calls.at(-1)!; assert.equal(auxiliary.purpose, 'summary'); assert.ok(auxiliary.chargedTokens > 0);
      assert.equal(handle.agent.session.events.filter(e => e.type === 'compaction/end').at(-1)!.data.error?.startsWith('uncommitted:'), true);
    } finally { clearTimeout(keepAlive); await handle.dispose(); await runtime.dispose(); }
  }
});

test('official adapter wire excludes checkpoint notes and retains the requested controls', async () => {
  const original = globalThis.fetch; let body: Record<string, any> | undefined;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init!.body as string) as Record<string, any>;
    const packets = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(packets.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const source = { kind: 'user' as const, benchmarkState: { notes: { secret: 'NOTE_MUST_STAY_OUT_OF_WIRE' } } };
    for await (const _chunk of officialAdapter('fixture-credential').stream({ provider: 'deepseek', model: 'deepseek-flash', temperature: 0, maxTokens: 4096,
      messages: [createUserMessage({ source, content: [{ type: 'text', text: 'Visible note directory only' }] })] })) {}
    assert.ok(body); assert.ok(!JSON.stringify(body).includes('NOTE_MUST_STAY_OUT_OF_WIRE'));
    assert.equal(body.max_tokens, 4096); assert.equal(body.temperature, 0); assert.deepEqual(body.thinking, { type: 'disabled' });
  } finally { globalThis.fetch = original; }
});
