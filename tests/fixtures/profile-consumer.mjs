import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { BenchmarkPersistence } from 'dsh-agent-benchmark/persistence';
import { readNativeState } from 'dsh-agent-benchmark/native';

export const inject = ['llm', 'agents', 'sessions', 'compaction', 'sessionPersistence', 'tools'];
class Fixture extends LlmAdapter {
  requests = [];
  async *stream(request) {
    this.requests.push(request);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: request.purpose === 'compaction' ? 'Remember OBSERVED_KEY and continue the user task.' : 'READY' } };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) {
  const adapter = new Fixture(); ctx.llm.registerAdapter(['release-fixture'], adapter);
  setTimeout(async () => {
    try {
      assert.ok(ctx.sessionPersistence instanceof BenchmarkPersistence, 'host persistence must share the plugin instance');
      const strategy = process.env.BENCHMARK_PROFILE_STRATEGY;
      const options = { provider: 'release-fixture', model: 'fixture', maxTokens: 10000 };
      const sessionId = SessionId(`release-smoke-${strategy}`);
      let handle = await ctx.agents.create({ sessionId, agentOptions: options });
      const followup = async text => { handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await handle.agent.whenIdle(); };
      await followup('Remember OBSERVED_KEY');
      assert.equal(adapter.requests.length, 1); assert.equal(adapter.requests[0].maxTokens, 128);
      assert.equal(adapter.requests[0].tools.some(t => t.name === 'notes_write'), strategy === 'window-reset');
      if (strategy === 'window-reset') ctx.compaction.recovery(handle.agent.session, 'notes_write', { path: 'key', text: 'OBSERVED_KEY' });
      await ctx.compaction.compactNow(handle.agent, new AbortController().signal);
      assert.equal(readNativeState(handle.agent.session).window, 2);
      await ctx.sessions.flush(handle.agent.session); await handle.dispose();
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options });
      await followup('Continue');
      const state = readNativeState(handle.agent.session);
      assert.equal(state.window, 2); assert.equal(state.calls.length, strategy === 'window-reset' ? 2 : 3);
      if (strategy === 'window-reset') assert.equal(state.notes.key, 'OBSERVED_KEY');
      else assert.ok(handle.agent.session.deriveMessages().some(m => JSON.stringify(m.content).includes('Remember OBSERVED_KEY')));
      assert.ok(state.calls.every(c => c.measurement === 'actual'));
      assert.equal(handle.agent.session.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed');
      await ctx.sessions.flush(handle.agent.session); await handle.dispose();
      const result = { status: 'passed', strategy, calls: state.calls.length, windows: state.window, notes: Object.keys(state.notes), outputLimits: adapter.requests.map(r => r.maxTokens) };
      await ctx.root.fiber.dispose(); fs.writeFileSync(process.env.BENCHMARK_PROFILE_REPORT, JSON.stringify(result, null, 2)); process.exit(0);
    } catch (error) { console.error(error); await ctx.root.fiber.dispose(); process.exit(1); }
  }, 1000);
}
