import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledTasks, verifyAnswer } from '../src/taskset.js';
import { pairedSummary, validateOnlineConfig } from '../src/online.js';
import type { OnlineReport, OnlineTrial } from '../src/online.js';
import { hash } from '../src/types.js';
import { readFileSync } from 'node:fs';

test('frozen taskset is deterministic, balanced and disjoint; strict verifier rejects prose', () => {
  const tasks = controlledTasks(); assert.equal(hash(tasks), hash(controlledTasks()));
  assert.equal(tasks.length, 36); assert.equal(new Set(tasks.map(t => t.id)).size, 36);
  assert.equal(tasks.filter(t => t.split === 'evaluation').length, 24); assert.equal(tasks.filter(t => t.split === 'development').length, 12);
  for (const task of tasks) {
    assert.ok(!task.preparation.includes(task.expected)); assert.ok(!task.question.includes(task.expected)); assert.ok(task.material.includes(task.expected.split(',')[0]!));
    assert.equal(verifyAnswer(task, task.format === 'json' ? JSON.stringify({ answer: task.expected }) : task.expected), true);
    assert.equal(verifyAnswer(task, 'The answer is ' + task.expected), false);
  }
  assert.throws(() => validateOnlineConfig({ ...JSON.parse(readFileSync('examples/online.json', 'utf8')), model: 'unverified-alias' }));
});
test('paired analysis includes failed trials and clusters repetitions by original task', () => {
  const trials = [
    { task: 'a', repetition: 0, strategy: 'local-summary', success: true }, { task: 'a', repetition: 0, strategy: 'window-reset', success: false, failure: 'provider_failed' },
    { task: 'a', repetition: 1, strategy: 'local-summary', success: false }, { task: 'a', repetition: 1, strategy: 'window-reset', success: true },
    { task: 'b', repetition: 0, strategy: 'local-summary', success: false }, { task: 'b', repetition: 0, strategy: 'window-reset', success: false },
  ] as OnlineTrial[];
  const stats = pairedSummary({ trials } as OnlineReport);
  assert.equal(stats.pairs, 3); assert.equal(stats.summaryWins, 1); assert.equal(stats.resetWins, 1); assert.equal(stats.ties, 1); assert.equal(stats.difference, 0);
  assert.deepEqual(stats.bootstrap95, [0, 0]);
});
