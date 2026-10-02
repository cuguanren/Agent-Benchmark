import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmService, { LlmAdapter, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import ContextBenchmarkService, { normalizeUsage } from '../src/dsh.js';
import { BenchmarkError, Session } from '../src/index.js';

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  outcome: 'stop' | 'overflow' | 'truncated' = 'stop';
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (this.outcome === 'overflow') { yield { type: 'finish', reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'too large' } } }; return; }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'part' };
    yield { type: 'text-delta', index: 0, text: ' summary' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'part summary' } };
    yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 3, reasoningTokens: 2 } };
    yield { type: 'finish', reason: this.outcome === 'truncated' ? { kind: 'max-tokens' } : { kind: 'stop' } };
  }
}

test('real Cordis + LlmService compose the bridge and preserve IDs/tool pairs/usage', async t => {
  const ctx = new Context();
  const llmFiber = ctx.plugin(LlmService); await llmFiber.inertia;
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter);
  const bridge = ctx.plugin(ContextBenchmarkService, { provider: 'fixture', model: 'test', temperature: 0 }); await bridge.inertia;
  t.after(async () => { await bridge.dispose(); await llmFiber.dispose(); });
  assert.ok(ctx.contextBenchmark);
  const s = ctx.contextBenchmark.create({ id: 'dsh', strategy: 'local-summary', initial: 'initial' });
  s.append('assistant', '{"path":"x"}', 'tool-1', 'read'); const original = s.append('tool', 'observed data', 'tool-1');
  await ctx.contextBenchmark.transition(s);
  assert.equal(adapter.requests.length, 1);
  const request = adapter.requests[0]!; assert.equal(request.purpose, 'compaction'); assert.equal(request.maxTokens, 512);
  const call = request.messages.find(m => m.role === 'assistant')!;
  assert.deepEqual(call.content, [{ type: 'tool-call', id: 'tool-1', name: 'read', arguments: '{"path":"x"}' }]);
  const result = request.messages.find(m => m.id === original.id)!;
  assert.equal(result.role, 'user'); assert.deepEqual(result.source, { kind: 'tool', callId: 'tool-1' });
  assert.equal(s.snapshot.calls[0]!.inputTokens, 35); assert.equal(s.snapshot.calls[0]!.outputTokens, 3); assert.equal(s.spentTokens, 38);
  assert.equal(s.snapshot.active.find(m => m.kind === 'summary')!.text.split('part summary').length - 1, 1);
  await bridge.dispose(); assert.throws(() => s.append('user', 'after disposal'), (e: unknown) => e instanceof BenchmarkError && e.code === 'storage_failed');
});

test('bridge rejects truncated stream and turns provider overflow into bounded trimming', async t => {
  const ctx = new Context(); const llmFiber = ctx.plugin(LlmService); await llmFiber.inertia;
  const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter);
  const bridge = ctx.plugin(ContextBenchmarkService, { provider: 'fixture', model: 'test' }); await bridge.inertia;
  t.after(async () => { await bridge.dispose(); await llmFiber.dispose(); });
  adapter.outcome = 'truncated';
  const s = Session.create({ id: 'cut', strategy: 'local-summary', initial: '' });
  await assert.rejects(ctx.contextBenchmark.transition(s), (e: unknown) => e instanceof BenchmarkError && e.code === 'summary_failed');
  assert.equal(s.snapshot.window.number, 1);
  adapter.outcome = 'overflow'; adapter.requests.length = 0;
  s.append('user', 'one removable message');
  await assert.rejects(ctx.contextBenchmark.transition(s), (e: unknown) => e instanceof BenchmarkError && e.code === 'context_exhausted');
  assert.equal(adapter.requests.length, 2); assert.equal(s.snapshot.calls.length, 3);
});

test('dsh usage normalizes disjoint cache once and rejects invalid counters', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 3, reasoningTokens: 2 }), { inputTokens: 35, outputTokens: 3, cacheReadTokens: 20 });
  assert.throws(() => normalizeUsage({ inputTokens: -1, outputTokens: 0 }), (e: unknown) => e instanceof BenchmarkError && e.code === 'provider_failed');
});
