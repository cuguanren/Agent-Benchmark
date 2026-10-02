import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hash } from '../dist/src/types.js';
import { gradePaw } from '../dist/src/external.js';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const events = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(readLine => JSON.parse(readLine));
const latestState = rows => [...rows].reverse().map(e => e.type === 'benchmark/state' ? e.data : e.type === 'benchmark/request' ? e.data.state : e.type === 'user/message' ? e.data.source.benchmarkState : undefined).find(Boolean);
const checks = [];
for (const dir of ['runs/online-development', 'runs/online-evaluation']) {
  const report = read(path.join(dir, 'report.json')); const tasks = read(path.join(dir, 'tasks.json'));
  assert.equal(report.status, 'completed'); assert.equal(report.trials.length, report.plannedTrials);
  assert.equal(read(path.join(dir, 'run-status.json')).status, 'completed');
  assert.equal(hash(report.config), report.configHash); assert.equal(hash(tasks.tasks), report.tasksetHash);
  const source = path.join(dir, 'source');
  assert.equal(hash(fs.readdirSync(source).filter(p => p.endsWith('.ts')).sort().map(p => [p, fs.readFileSync(path.join(source, p), 'utf8')])), report.implementationHash);
  assert.equal(new Set(report.trials.map(t => t.id)).size, report.plannedTrials);
  for (const trial of report.trials) {
    const rows = events(trial.trace); const state = latestState(rows); const calls = state.calls;
    assert.equal(state.window, trial.windows); assert.equal(trial.windows, 2);
    assert.equal(calls.length, trial.calls); assert.ok(calls.every(c => c.measurement === 'actual' && c.status === 'success'));
    assert.equal(calls.reduce((n, c) => n + c.inputTokens, 0), trial.actualInputTokens);
    assert.equal(calls.reduce((n, c) => n + c.outputTokens, 0), trial.actualOutputTokens);
    assert.equal(calls.reduce((n, c) => n + c.chargedTokens, 0), trial.chargedTokens);
    assert.equal(rows.filter(e => e.type === 'tool/call').length, trial.toolCalls);
    assert.equal(calls.filter(c => c.purpose === 'summary').length, trial.strategy === 'local-summary' ? 1 : 0);
    assert.equal(trial.failure, null); assert.equal(trial.unknownUsageCalls, 0);
  }
  checks.push({ run: dir, trials: report.trials.length, requests: report.trials.reduce((n, t) => n + t.calls, 0), tokens: report.trials.reduce((n, t) => n + t.chargedTokens, 0), complete: true });
}
const dir = 'runs/pawbench-official'; const report = read(path.join(dir, 'report.json'));
assert.equal(report.trials.length, 2);
const source = path.join(dir, 'source');
assert.equal(hash(Object.fromEntries(fs.readdirSync(source).filter(p => /\.(ts|py)$/.test(p)).sort().map(p => [p, fs.readFileSync(path.join(source, p), 'utf8')]))), report.implementationHash);
assert.equal(hash(fs.readFileSync('third_party/pawbench/T037_claweval_T100_reverse_decoder/grader.py', 'utf8')), report.graderHash);
for (const trial of report.trials) {
  const rows = events(trial.trace); const state = latestState(rows);
  assert.deepEqual(await gradePaw(trial.workspace), trial.scores);
  assert.equal(state.window, trial.windows); assert.equal(state.calls.length, trial.calls);
  assert.ok(state.calls.every(c => c.measurement === 'actual'));
  assert.equal(state.calls.reduce((n, c) => n + c.inputTokens, 0), trial.inputTokens);
  assert.equal(state.calls.reduce((n, c) => n + c.outputTokens, 0), trial.outputTokens);
  const end = rows.filter(e => e.type === 'turn/end').at(-1);
  assert.equal(end.data.reason.error.code, 'BENCHMARK_BUDGET_EXHAUSTED');
  for (const fixture of ['decoder.py', 'target.txt']) assert.equal(hash(fs.readFileSync(path.join(trial.workspace, 'fixtures', fixture)).toString('base64')), hash(fs.readFileSync(path.join('third_party/pawbench/T037_claweval_T100_reverse_decoder/fixtures', fixture)).toString('base64')));
  checks.push({ run: dir, strategy: trial.strategy, graderVerified: true, success: trial.success, failure: 'budget_exhausted', requests: trial.calls, tokens: trial.inputTokens + trial.outputTokens, windows: trial.windows });
}
const audit = { checkedAt: new Date().toISOString(), checks };
fs.writeFileSync('runs/completion-audit.json', JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit, null, 2));
