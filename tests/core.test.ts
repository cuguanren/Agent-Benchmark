import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, BenchmarkError, ContextOverflow, estimateInput, hash, messageUnits, RecoveryTools, callModel, transition, ensureWindow, resolveConfig } from '../src/index.js';
import type { Model, ModelRequest, Strategy } from '../src/index.js';
import { runConformance } from '../src/conformance.js';

const model: Model = { async generate() { return { text: 'KEY: observed_123. Continue the unfinished task.' }; } };
function session(strategy: Strategy = 'local-summary', config = {}): Session { return Session.create({ id: 'test', strategy, initial: 'Initial instructions.', config }); }
function code(expected: string): (error: unknown) => boolean { return error => error instanceof BenchmarkError && error.code === expected; }

test('summary replaces raw tool/assistant context, keeps users and durable observations', async () => {
  const s = session();
  s.append('user', 'Preserve my constraint'); s.append('assistant', '{}', 'call', 'observe');
  const original = s.append('tool', 'KEY: observed_123', 'call'); s.append('assistant', 'large intermediate reasoning');
  const input: ModelRequest[] = [];
  await transition(s, { async generate(request) { input.push(request); return model.generate(request); } });
  assert.equal(input.length, 1); assert.ok(input[0]!.messages.some(m => m.id === original.id));
  assert.equal(s.snapshot.window.number, 2); assert.equal(s.snapshot.window.previousId, 'test:w1');
  assert.ok(s.snapshot.active.some(m => m.kind === 'summary' && m.text.includes('observed_123')));
  assert.ok(s.snapshot.active.some(m => m.role === 'user' && m.text === 'Preserve my constraint'));
  assert.ok(s.snapshot.active.every(m => m.role !== 'tool' && m.role !== 'assistant'));
  assert.deepEqual(s.history.find(m => m.id === original.id), original);
  assert.equal(s.snapshot.calls[0]!.measurement, 'estimated'); assert.equal(s.snapshot.calls[0]!.inputTokens, null);
});

test('user retention obeys UTF-8 budget without mutating archived text; old summary excluded', async () => {
  const s = session('local-summary', { userRetentionTokens: 2 });
  s.append('user', 'old user text'); const original = s.append('user', '中文🙂测试');
  await transition(s, model);
  const retained = s.snapshot.active.filter(m => m.kind === 'normal' && m.role === 'user');
  assert.equal(retained.length, 1); assert.equal(retained[0]!.text, '中文');
  assert.equal(s.history.find(m => m.id === original.id)!.text, '中文🙂测试');
  await transition(s, model);
  assert.equal(s.snapshot.active.filter(m => m.kind === 'summary').length, 1);
  assert.ok(!s.snapshot.active.some(m => m.kind === 'normal' && m.text.includes('Another model')));
});

test('reset has zero model requests, no automatic notes, explicit recovery adds context', async () => {
  const s = session('window-reset'); const tools = new RecoveryTools(s);
  const original = s.append('user', 'early observation secret-value');
  tools.execute('notes.write', { path: 'work/state', text: 'secret-value' });
  await transition(s, { async generate() { throw new Error('Must not invoke summary'); } });
  assert.equal(s.snapshot.calls.length, 0); assert.equal(s.snapshot.active.length, 3);
  assert.ok(!s.snapshot.active.some(m => m.text.includes('secret-value')));
  assert.ok(s.hint().includes('work/state')); assert.equal(s.history.find(m => m.id === original.id)!.text, original.text);
  const before = s.status().inputTokens;
  const restored = tools.execute('notes.read', { path: 'work/state' }) as { text: string };
  assert.equal(restored.text, 'secret-value'); assert.equal(s.status().inputTokens, before);
  s.append('assistant', '{"path":"work/state"}', 'read', 'notes.read'); s.append('tool', restored.text, 'read');
  assert.ok(s.status().inputTokens > before);
  const empty = session('window-reset'); await transition(empty, model); assert.deepEqual(empty.snapshot.notes, {});
});

test('bounded notes/history, literal search, Unicode ranges and virtual paths', () => {
  const s = session('window-reset', { hintBytes: 10 }); const tools = new RecoveryTools(s);
  tools.execute('notes.write', { path: '中文/state', text: '中🙂abc' });
  assert.ok(Buffer.byteLength(s.hint()) <= 10);
  assert.deepEqual(tools.execute('notes.read', { path: '中文/state', offset: 1, maxBytes: 4 }), { path: '中文/state', text: '🙂', offset: 1, nextOffset: 2, truncated: true });
  assert.deepEqual(tools.execute('notes.search', { query: '.' }), { items: [], truncated: false });
  assert.throws(() => tools.execute('notes.write', { path: '../x', text: 'x' }), code('invalid_input'));
  assert.throws(() => tools.execute('notes.write', { path: '__proto__', text: 'x' }), code('invalid_input'));
  assert.throws(() => tools.execute('history.read', { id: 'not-in-this-session' }), code('invalid_input'));
  assert.throws(() => new RecoveryTools(session()).execute('history.windows'), code('invalid_input'));
  assert.throws(() => tools.execute('notes.read', { path: '中文/state', maxBytes: -1 }), code('invalid_input'));
});

test('empty/provider/budget/oversized summary errors preserve active state and strategy', async () => {
  for (const failure of ['empty', 'provider', 'budget', 'oversized'] as const) {
    const s = session('local-summary', failure === 'budget' ? { totalTokenBudget: 1 } : {});
    s.append('user', 'keep this'); const before = hash(s.snapshot.active);
    const bad: Model = { async generate() {
      if (failure === 'provider') throw new Error('provider error');
      return { text: failure === 'empty' ? '  ' : 'x'.repeat(40_000) };
    } };
    await assert.rejects(transition(s, bad), code({ empty: 'summary_failed', provider: 'provider_failed', budget: 'budget_exhausted', oversized: 'context_exhausted' }[failure]));
    assert.equal(hash(s.snapshot.active), before); assert.equal(s.snapshot.window.number, 1); assert.equal(s.snapshot.strategy, 'local-summary');
    assert.equal((s.events.at(-1)!.data as { committed: boolean }).committed, false);
    assert.equal(s.snapshot.calls.length, failure === 'budget' ? 0 : 1);
  }
});

test('provider overflow removes the oldest complete call/result unit and charges both attempts', async () => {
  const s = session(); s.append('assistant', '{}', 'old', 'observe'); s.append('tool', 'old large tool result', 'old'); s.append('user', 'recent');
  const requests: ModelRequest[] = [];
  await transition(s, { async generate(request) { requests.push(request); if (requests.length === 1) throw new ContextOverflow(); return { text: 'valid summary' }; } });
  assert.equal(requests.length, 2); requests.forEach(r => assert.doesNotThrow(() => messageUnits(r.messages)));
  assert.ok(requests[0]!.messages.some(m => m.toolCallId === 'old')); assert.ok(requests[1]!.messages.every(m => m.toolCallId !== 'old'));
  assert.equal(s.snapshot.calls[0]!.status, 'failed'); assert.equal(s.snapshot.calls[1]!.status, 'success'); assert.ok(s.spentTokens > 0);
  assert.equal(s.snapshot.calls[0]!.failureCode, 'context_overflow');
});

test('retry is bounded, nonretryable errors stop and failed attempts remain in budget', async () => {
  const s = session('local-summary', { summaryRetries: 1 }); let calls = 0;
  await assert.rejects(transition(s, { async generate() { calls++; throw new BenchmarkError('provider_failed', 'retryable', true); } }), code('provider_failed'));
  assert.equal(calls, 2); assert.equal(s.snapshot.calls.length, 2); assert.equal(s.snapshot.window.number, 1);
  const r = session(); calls = 0;
  await transition(r, { async generate() { if (++calls === 1) throw new BenchmarkError('provider_failed', 'once', true); return { text: 'summary' }; } });
  assert.equal(calls, 2); assert.equal(r.snapshot.window.number, 2);
});

test('reported input includes cache once; auxiliary cost over budget prevents commit', async () => {
  const s = session('local-summary', { totalTokenBudget: 1000 });
  await assert.rejects(transition(s, { async generate() { return { text: 'summary', usage: { inputTokens: 900, outputTokens: 200, cacheReadTokens: 500 } }; } }), code('budget_exhausted'));
  assert.equal(s.spentTokens, 1100); assert.equal(s.snapshot.window.number, 1); assert.equal(s.snapshot.calls[0]!.measurement, 'actual');
  await assert.rejects(transition(s, model), code('budget_exhausted')); assert.equal(s.snapshot.calls.length, 1);
});

test('cancelled hooks, explicit abort and timeout end without replacing the window', async () => {
  const s = session(); await assert.rejects(transition(s, model, { preHook: () => false }), code('cancelled')); assert.equal(s.snapshot.calls.length, 0);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(transition(s, model, { signal: aborted.signal }), code('cancelled'));
  const timed = session('local-summary', { timeoutMs: 15 }); let signal: AbortSignal | undefined;
  await assert.rejects(transition(timed, { generate(request) { signal = request.signal; return new Promise(() => {}); } }), code('cancelled'));
  assert.equal(signal!.aborted, true); assert.equal(timed.snapshot.window.number, 1); assert.equal(timed.snapshot.calls[0]!.status, 'failed');
});

test('post hook failure reports committed state; persistence failure does not publish replacement', async t => {
  const s = session('window-reset'); await assert.rejects(transition(s, model, { postHook() { throw new Error('post hook'); } }), code('provider_failed'));
  assert.equal(s.snapshot.window.number, 2); assert.equal((s.events.at(-1)!.data as { committed: boolean }).committed, true);
  const r = session('window-reset'); const record = r.record.bind(r);
  t.mock.method(r, 'record', (type: string, data: unknown) => { if (type === 'checkpoint') throw new BenchmarkError('storage_failed', 'injected disk failure'); record(type, data); });
  await assert.rejects(transition(r, model), code('storage_failed')); assert.equal(r.snapshot.window.number, 1);
});

test('tool pairing and serialized requests reject incomplete or concurrent writes', async () => {
  const s = session(); assert.throws(() => s.append('tool', 'orphan', 'missing'), code('invalid_input'));
  s.append('assistant', '{}', 'call', 'observe');
  await assert.rejects(transition(s, model), code('invalid_input')); assert.equal(s.events.filter(e => e.type === 'transition/start').length, 0);
  assert.throws(() => s.append('user', 'interleaved'), code('invalid_input')); s.append('tool', 'result', 'call');
  assert.throws(() => s.append('assistant', '{}', 'call', 'observe'), code('invalid_input'));
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const running = callModel(s, { async generate() { await wait; return { text: 'response' }; } }, { messages: s.requestMessages(), purpose: 'agent', maxOutputTokens: 20 });
  assert.throws(() => s.append('user', 'concurrent'), code('invalid_input'));
  release(); await running; s.append('user', 'now permitted');
});

test('scope subtracts carried prefix, capacity still counts it; one reminder per window', async () => {
  const total = session('window-reset', { triggerTokens: 200, reminderTokens: 200 });
  const body = session('window-reset', { triggerTokens: 200, scope: 'body-after-prefix', reminderTokens: 200 });
  assert.ok(total.status().scopeTokens > 0); assert.equal(body.status().scopeTokens, 0);
  assert.equal(body.remind(), true); assert.equal(body.remind(), false);
  new RecoveryTools(body).execute('new_context'); assert.equal(body.status().shouldTransition, true);
  assert.equal(await ensureWindow(body, model), true); assert.equal(body.snapshot.reminderSent, false);
  assert.equal(body.snapshot.requestedReset, false); assert.equal(body.status().scopeTokens, 0);
  assert.equal(body.snapshot.window.baselineTokens, estimateInput(body.snapshot.active, body.snapshot.config.tools));
  assert.throws(() => resolveConfig({ tools: [null] } as never), code('invalid_input'));
});

test('journal replay, single writer, pending budget, tail repair and internal corruption', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agent-benchmark-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl'); const s = Session.create({ id: 'persist', initial: 'instructions', strategy: 'window-reset', file });
  assert.throws(() => Session.resume(file), code('storage_failed'));
  s.append('user', 'persisted input'); new RecoveryTools(s).execute('notes.write', { path: 'state', text: '中文🙂' });
  await transition(s, model); const snapshot = s.snapshot; const history = s.history; s.close();
  fs.appendFileSync(file, '{"incomplete":');
  const resumed = Session.resume(file); assert.deepEqual(resumed.snapshot, snapshot); assert.deepEqual(resumed.history, history);
  assert.equal(resumed.events.at(-1)!.type, 'recovery/tail-discarded'); resumed.append('user', 'after repaired tail'); resumed.close();
  const again = Session.resume(file); assert.equal(again.snapshot.active.at(-1)!.text, 'after repaired tail'); again.close();
  const bytes = fs.readFileSync(file, 'utf8').replace('persisted input', 'tampered input'); fs.writeFileSync(file, bytes);
  assert.throws(() => Session.resume(file), code('invalid_input')); assert.equal(fs.existsSync(file + '.lock'), false);
  const pendingFile = join(dir, 'pending.jsonl'); const pending = Session.create({ id: 'pending', initial: '', strategy: 'local-summary', file: pendingFile });
  pending.record('model/request', { id: 'inflight', purpose: 'summary', status: 'pending', reservedTokens: 50, chargedTokens: 50, measurement: 'estimated', inputTokens: null, outputTokens: null }); pending.close();
  const replay = Session.resume(pendingFile); assert.equal(replay.spentTokens, 50); assert.equal(replay.snapshot.calls[0]!.status, 'pending'); replay.close();
});

test('offline paired report checks recovery and refuses to overwrite evidence', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agent-benchmark-report-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = JSON.parse(fs.readFileSync('examples/conformance.json', 'utf8')) as unknown;
  const report = await runConformance(input, dir);
  assert.equal(report.mode, 'conformance'); assert.equal(report.passed, true, JSON.stringify(report.trials.filter(t => !t.passed)));
  assert.equal(report.trials.length, 4); assert.ok(report.trials.every(t => t.actualInputTokens === null && t.measurement === 'estimated'));
  assert.ok(report.trials.filter(t => t.strategy === 'window-reset').every(t => t.summaryCalls === 0));
  assert.ok(fs.readFileSync(join(dir, 'report.md'), 'utf8').includes('unknown'));
  await assert.rejects(runConformance(input, dir), code('storage_failed'));
});

test('valid checksums do not permit malformed checkpoints or ledger rewrites', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agent-benchmark-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl'); const s = Session.create({ id: 'schema', strategy: 'window-reset', initial: '', file });
  const size = fs.statSync(file).size;
  assert.throws(() => s.record('unsupported/event', {}), code('invalid_input')); assert.equal(fs.statSync(file).size, size);
  const next = s.snapshot; next.window.number = 2; next.window.currentId = 'schema:w2'; next.window.previousId = 'schema:w1';
  next.active = s.initialMessages(next.initial, next.window); next.window.baselineTokens = estimateInput(next.active);
  next.calls = [{ id: 'fake-ledger', purpose: 'summary', status: 'pending', reservedTokens: 1, chargedTokens: 1, measurement: 'estimated', inputTokens: null, outputTokens: null }];
  assert.throws(() => s.commit(next), code('invalid_input')); assert.equal(s.snapshot.window.number, 1); assert.equal(fs.statSync(file).size, size); s.close();
  const event = JSON.parse(fs.readFileSync(file, 'utf8')) as { data: { notes: unknown }; hash: string };
  event.data.notes = null; const { hash: _, ...payload } = event; event.hash = hash(payload); fs.writeFileSync(file, JSON.stringify(event) + '\n');
  assert.throws(() => Session.resume(file), code('invalid_input'));
});

test('interrupted lifecycle distinguishes a committed checkpoint from an uncommitted start', async t => {
  const s = session('window-reset'); const original = s.record.bind(s);
  t.mock.method(s, 'record', (type: string, data: unknown) => { if (type === 'transition/end') throw new BenchmarkError('storage_failed', 'lost terminal event'); original(type, data); });
  await assert.rejects(transition(s, model), code('storage_failed'));
  assert.equal(s.snapshot.window.number, 2); assert.equal(s.recoveryStatus.incompleteTransitions.length, 1); assert.equal(s.recoveryStatus.incompleteTransitions[0]!.committed, true);
  const uncommitted = session('window-reset'); uncommitted.record('transition/start', { id: 'unfinished', windowId: 'test:w1', strategy: 'window-reset', trigger: 'manual' });
  assert.deepEqual(uncommitted.recoveryStatus.incompleteTransitions, [{ id: 'unfinished', committed: false }]);
});

test('infra and budget failures stay in all planned trials, with saved failed report', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agent-benchmark-failures-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = JSON.parse(fs.readFileSync('examples/conformance.json', 'utf8')) as { config: { totalTokenBudget: number } };
  input.config.totalTokenBudget = 1;
  const report = await runConformance(input, dir);
  assert.equal(report.passed, false); assert.equal(report.trials.length, 4); assert.ok(report.trials.every(t => t.failure === 'budget_exhausted'));
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).length, 4);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'report.json'), 'utf8')).passed, false);
});
