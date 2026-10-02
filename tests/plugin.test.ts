import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { Fiber } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Persistence from '../src/native-persistence.js';
import * as plugin from '../src/plugin.js';
import { readNativeState } from '../src/native.js';
import type { NativeContextStrategy } from '../src/native.js';
import { CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { resourcePath, sourceFiles } from '../src/resources.js';

class Fixture extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: request.purpose === 'compaction' ? 'Keep the key and user constraints.' : 'READY' } };
    yield { type: 'usage', usage: { inputTokens: 5000, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function host(root: string, options: Partial<plugin.Config> = {}) {
  const ctx = new Context(); const fibers: Fiber[] = []; const adapter = new Fixture();
  const load = async (p: any, config?: any) => { const fiber = ctx.plugin(p, config); fibers.push(fiber); await fiber.await(); assert.equal(fiber.state, 2); return fiber; };
  await load(Llm); ctx.llm.registerAdapter(['fixture'], adapter);
  await load(Sessions); await load(Agents); await load(Prompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: 'Follow the user task.' });
  await load(Tools, { mode: 'native' }); await load(Persistence, { root, compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 });
  const config = plugin.Config({ strategy: 'window-reset', capacityTokens: 8192, triggerTokens: 7000, outputReserveTokens: 128, totalTokenBudget: 30000, globalTokenBudget: 12000, ...options });
  let fiber = await load(plugin, config); await load(Loop, { agents: [], maxParallelToolCalls: 1 });
  return { ctx, adapter, reload: async () => { await fiber.dispose(); fiber = await load(plugin, config); }, unload: () => fiber.dispose(),
    dispose: async () => { for (const f of fibers.reverse()) await f.dispose(); await ctx.fiber.dispose(); } };
}
function followup(agent: any, text = 'Remember the task') { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); return agent.whenIdle(); }
function temporary(t: test.TestContext) { const root = mkdtempSync(join(tmpdir(), 'benchmark-plugin-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('plugin schema validates limits and installed resources ignore caller cwd', () => {
  assert.equal(plugin.Config({}).strategy, 'local-summary');
  for (const input of [{ strategy: 'unknown' }, { capacityTokens: 100, outputReserveTokens: 200 }, { maxCalls: 0 }, { triggerTokens: 1.5 }, { hintBytes: 4001 }]) assert.throws(() => plugin.Config(input as any));
  assert.ok(resourcePath('src/python_workspace.py').endsWith(join('src', 'python_workspace.py')));
  assert.ok(sourceFiles()['plugin.ts']?.includes('export async function apply'));
});

test('installed plugin auto-attaches, caps output, and resumes the same ID without double charging', async t => {
  const runtime = await host(temporary(t)); t.after(() => runtime.dispose());
  let handle = await runtime.ctx.agents.create({ sessionId: SessionId('auto'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 10000 } });
  await followup(handle.agent); assert.equal(runtime.adapter.requests[0]!.maxTokens, 128);
  assert.ok(runtime.adapter.requests[0]!.tools?.some(tool => tool.name === 'notes_write'));
  const strategy = runtime.ctx.compaction as NativeContextStrategy;
  strategy.recovery(handle.agent.session, 'notes_write', { path: 'key', text: 'OBSERVED_KEY' });
  await strategy.compactNow(handle.agent, new AbortController().signal);
  assert.equal(readNativeState(handle.agent.session)!.window, 2);
  for (let i = 0; i < 3; i++) {
    await runtime.ctx.sessions.flush(handle.agent.session); await handle.dispose();
    handle = await runtime.ctx.agents.resume({ resumeSessionId: SessionId('auto'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 10000 } });
  }
  await followup(handle.agent, 'Continue');
  assert.equal(readNativeState(handle.agent.session)!.calls.length, 2);
  assert.equal(readNativeState(handle.agent.session)!.notes.key, 'OBSERVED_KEY');
  assert.equal(handle.agent.session.events.filter(e => e.type === 'turn/end').at(-1)!.data.reason.kind, 'completed');
  await handle.dispose();
});

test('plugin unload/reload removes tools and reattaches existing idle sessions exactly once', async t => {
  const runtime = await host(temporary(t), { globalTokenBudget: 50000 }); t.after(() => runtime.dispose());
  const handle = await runtime.ctx.agents.create({ sessionId: SessionId('reload'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128 } });
  await followup(handle.agent); await runtime.reload(); await followup(handle.agent);
  assert.equal(runtime.adapter.requests.at(-1)!.tools!.filter(t => t.name === 'notes_write').length, 1);
  await runtime.unload(); await followup(handle.agent);
  assert.ok(!(runtime.adapter.requests.at(-1)!.tools ?? []).some(t => t.name.startsWith('notes_')));
  assert.equal(readNativeState(handle.agent.session)!.calls.length, 2); // unloaded turn bypasses benchmark middleware
  await handle.dispose();
});

test('forked observed history inherits notes but has independent window IDs and ledger', async t => {
  const runtime = await host(temporary(t), { globalTokenBudget: 50000 }); t.after(() => runtime.dispose());
  const parent = await runtime.ctx.agents.create({ sessionId: SessionId('parent'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128 } });
  await followup(parent.agent);
  (runtime.ctx.compaction as NativeContextStrategy).recovery(parent.agent.session, 'notes_write', { path: 'key', text: 'OBSERVED_KEY' });
  const child = await runtime.ctx.agents.create({ sessionId: SessionId('child'), meta: { parentSession: parent.agent.id }, seed: parent.agent.session.events, agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128 } });
  await followup(child.agent);
  const state = readNativeState(child.agent.session)!; assert.equal(state.firstWindowId, 'child:w1'); assert.equal(state.calls.length, 1); assert.equal(state.notes.key, 'OBSERVED_KEY');
  assert.equal(readNativeState(parent.agent.session)!.calls.length, 1);
  await child.dispose(); await parent.dispose();
});

test('manual flush failure reports committed state and makes exactly one close attempt', async t => {
  const runtime = await host(temporary(t)); t.after(() => runtime.dispose());
  const handle = await runtime.ctx.agents.create({ sessionId: SessionId('flush-failure'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128 } });
  await followup(handle.agent);
  const flush = runtime.ctx.sessions.flush; runtime.ctx.sessions.flush = async () => { throw new Error('fixture disk failure'); };
  try {
    await assert.rejects(runtime.ctx.compaction.compactNow(handle.agent, new AbortController().signal, 'fixture-command' as any), (error: unknown) => error instanceof ManualCompactionError && error.code === 'persistence');
    assert.equal(readNativeState(handle.agent.session)!.window, 2);
    assert.equal(handle.agent.session.events.filter(e => e.type === 'compaction/end').length, 1);
    assert.equal(handle.agent.session.events.filter(e => e.type === 'compaction/start').at(-1)!.data.sourceCommandId, 'fixture-command');
    assert.equal(handle.agent.session.events.filter(e => e.type === 'benchmark/compaction-failure').at(-1)!.data.committed, true);
  } finally { runtime.ctx.sessions.flush = flush; await runtime.ctx.sessions.flush(handle.agent.session); await handle.dispose(); }
});

test('manual region rejects an active Agent and durable unmatched compaction lock', async t => {
  const runtime = await host(temporary(t)); t.after(() => runtime.dispose());
  const handle = await runtime.ctx.agents.create({ sessionId: SessionId('busy'), agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128 } });
  await followup(handle.agent); const nodes = handle.agent.session.surface.nodes;
  let release!: () => void; const held = handle.agent.runMaintenance(() => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(runtime.ctx.compaction.compactRegion(nodes[0]!, nodes.at(-1)!, handle.agent), (error: unknown) => error instanceof ManualCompactionError && error.code === 'busy');
  release(); await held;
  const id = CompactionId('fixture-open'); handle.agent.session.append('compaction/start', { compactionId: id, turn: null });
  await assert.rejects(runtime.ctx.compaction.compactNow(handle.agent, new AbortController().signal), (error: unknown) => error instanceof ManualCompactionError && error.code === 'busy');
  assert.equal(readNativeState(handle.agent.session)!.window, 1);
  handle.agent.session.append('compaction/end', { compactionId: id, turn: null }); await handle.dispose();
});
