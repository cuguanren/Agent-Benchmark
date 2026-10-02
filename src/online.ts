import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createNativeRuntime } from './native-runtime.js';
import { blockText, readNativeState } from './native.js';
import type { NativeState } from './native.js';
import { officialAdapter, ONLINE_MODEL } from './deepseek.js';
import { controlledTasks, verifyAnswer } from './taskset.js';
import type { ControlledTask } from './taskset.js';
import { BenchmarkError, hash, resolveConfig } from './types.js';
import type { Config, Strategy } from './types.js';
import { implementationHash, saveSourceSnapshot } from './resources.js';

export interface OnlineConfig {
  schemaVersion: 1; mode: 'online'; model: typeof ONLINE_MODEL; taskset: 'controlled-v1';
  split: 'development' | 'evaluation'; repetitions: number; maxCalls: number;
  globalTokenBudget: number; turnTimeoutMs: number; config: Partial<Config>;
}
export interface OnlineTrial {
  id: string; task: string; family: string; repetition: number; strategy: Strategy;
  success: boolean; failure: string | null; answer: string; windows: number; calls: number; summaryCalls: number;
  toolCalls: number; actualInputTokens: number | null; actualOutputTokens: number | null;
  chargedTokens: number; unknownUsageCalls: number; elapsedMs: number; trace: string;
}
export interface OnlineReport {
  schemaVersion: 1; mode: 'online'; status: 'running' | 'completed'; model: string; thinking: 'disabled'; temperature: 0;
  implementationHash: string; configHash: string; tasksetHash: string; plannedTrials: number;
  config: OnlineConfig; trials: OnlineTrial[]; inference: string;
}
export function validateOnlineConfig(value: unknown): OnlineConfig {
  const input = value as OnlineConfig;
  if (!input || input.schemaVersion !== 1 || input.mode !== 'online' || input.model !== ONLINE_MODEL || input.taskset !== 'controlled-v1'
    || !['development', 'evaluation'].includes(input.split) || !Number.isSafeInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 5
    || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 64
    || !Number.isSafeInteger(input.globalTokenBudget) || input.globalTokenBudget < 1 || input.globalTokenBudget > 2_000_000
    || !Number.isSafeInteger(input.turnTimeoutMs) || input.turnTimeoutMs < 1000 || input.turnTimeoutMs > 600_000) throw new BenchmarkError('invalid_input', 'Invalid frozen online configuration');
  resolveConfig(input.config); return structuredClone(input);
}
async function turn(agent: Agent, text: string, timeoutMs: number): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  const timer = setTimeout(() => agent.cancel({ kind: 'hook', reason: 'benchmark turn timeout' }), timeoutMs);
  try { await agent.whenIdle(); } finally { clearTimeout(timer); }
  const end = agent.session.events.filter(e => e.type === 'turn/end').at(-1);
  if (!end || end.data.reason.kind !== 'completed') {
    const reason = end?.data.reason;
    throw new BenchmarkError(reason?.kind === 'aborted' ? 'cancelled' : reason?.kind === 'max-tokens' ? 'output_limit' : reason?.kind === 'error' && reason.error.code === 'BENCHMARK_BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'provider_failed', reason?.kind === 'error' ? reason.error.code : 'Native turn did not complete');
  }
}
export async function runOnline(value: unknown, apiKey: string, out: string): Promise<OnlineReport> {
  const input = validateOnlineConfig(value); const config = resolveConfig(input.config);
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length) throw new BenchmarkError('storage_failed', 'Online output directory must be empty');
  const tasks = controlledTasks().filter(t => t.split === input.split);
  const report: OnlineReport = { schemaVersion: 1, mode: 'online', status: 'running', model: ONLINE_MODEL, thinking: 'disabled', temperature: 0,
    implementationHash: implementationHash(), configHash: hash(input), tasksetHash: hash(tasks), plannedTrials: tasks.length * input.repetitions * 2,
    config: input, trials: [], inference: 'Matched-cut paired controlled tasks; repeated samples clustered by task. Artificial window capacity uses bytes/4 estimation; token usage is provider-reported. Small closed task families do not establish general strategy superiority.' };
  fs.writeFileSync(join(out, 'tasks.json'), JSON.stringify({ schemaVersion: 1, taskset: input.taskset, hash: report.tasksetHash, tasks }, null, 2));
  saveSourceSnapshot(join(out, 'source'));
  const status = (state: string) => fs.writeFileSync(join(out, 'run-status.json'), JSON.stringify({ status: state, pid: process.pid, planned: report.plannedTrials, completed: report.trials.length, updatedAt: new Date().toISOString() }, null, 2));
  const save = () => { fs.writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(join(out, 'report.md'), renderOnlineReport(report)); };
  save(); status('running');
  const budget = { spent: 0 }; const adapter = officialAdapter(apiKey);
  const runtimes = new Map<Strategy, Awaited<ReturnType<typeof createNativeRuntime>>>();
  try {
    for (const strategy of ['local-summary', 'window-reset'] as const) {
      const runtime = await createNativeRuntime({ strategy, adapter, root: join(out, 'native', strategy), config,
        maxCalls: input.maxCalls, globalTokenBudget: input.globalTokenBudget, budget });
      runtime.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: 0 }));
      runtimes.set(strategy, runtime);
    }
    for (let repetition = 0; repetition < input.repetitions; repetition++) for (const [index, task] of tasks.entries()) {
      const order: Strategy[] = (index + repetition) % 2 ? ['window-reset', 'local-summary'] : ['local-summary', 'window-reset'];
      for (const strategy of order) {
        const runtime = runtimes.get(strategy)!; const id = `${task.id}-r${repetition}-${strategy}`; const start = Date.now();
        let answer = ''; let failure: string | null = null; let state: NativeState | undefined; let toolCalls = 0; let trace = '';
        const handle = await runtime.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'deepseek', model: ONLINE_MODEL, maxTokens: config.outputReserveTokens } });
        try {
          handle.agent.ctx.tools.register(defineTool({ name: 'observe', description: 'Read the task evidence, including unrelated background rows. No reference answer or grader is exposed.', parameters: {},
            output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => task.material }));
          await runtime.strategy.attach(handle.agent);
          await turn(handle.agent, task.preparation, input.turnTimeoutMs);
          await runtime.strategy.compactNow(handle.agent, AbortSignal.timeout(config.timeoutMs));
          await turn(handle.agent, task.question, input.turnTimeoutMs);
          const last = [...handle.agent.session.deriveMessages()].reverse().find(m => m.role === 'assistant' && !m.content.some(b => b.type === 'tool-call'));
          answer = last ? blockText(last.content) : '';
        } catch (error) { failure = error instanceof BenchmarkError ? error.code : error instanceof LlmError ? error.code : 'infrastructure_failed'; }
        finally {
          state = readNativeState(handle.agent.session); toolCalls = handle.agent.session.events.filter(e => e.type === 'tool/call').length;
          try { await runtime.ctx.sessions.flush(handle.agent.session); trace = runtime.ctx.sessionPersistence.locate(handle.agent.session.header)?.path ?? ''; }
          catch { failure = 'storage_failed'; }
          await handle.dispose();
        }
        const calls = state?.calls ?? []; const unknown = calls.filter(c => c.measurement !== 'actual').length;
        const result: OnlineTrial = { id, task: task.id, family: task.family, repetition, strategy, success: !failure && verifyAnswer(task, answer), failure,
          answer, windows: state?.window ?? 0, calls: calls.length, summaryCalls: calls.filter(c => c.purpose === 'summary').length, toolCalls,
          actualInputTokens: unknown ? null : calls.reduce((n, c) => n + c.inputTokens!, 0), actualOutputTokens: unknown ? null : calls.reduce((n, c) => n + c.outputTokens!, 0),
          chargedTokens: calls.reduce((n, c) => n + c.chargedTokens, 0), unknownUsageCalls: unknown, elapsedMs: Date.now() - start, trace };
        report.trials.push(result); save(); status('running');
        console.log(JSON.stringify({ event: 'trial', completed: report.trials.length, planned: report.plannedTrials, id, success: result.success, failure, calls: result.calls, tokens: result.chargedTokens }));
      }
    }
    report.status = 'completed'; save(); status('completed'); return report;
  } catch (error) { status('stopped'); throw error; }
  finally { for (const runtime of runtimes.values()) await runtime.dispose(); }
}
export function pairedSummary(report: OnlineReport): { pairs: number; summaryWins: number; resetWins: number; ties: number; difference: number; bootstrap95: [number, number] } {
  const pairs = new Map<string, Partial<Record<Strategy, OnlineTrial>>>();
  for (const t of report.trials) { const key = `${t.task}:${t.repetition}`; const pair = pairs.get(key) ?? {}; pair[t.strategy] = t; pairs.set(key, pair); }
  let summaryWins = 0; let resetWins = 0; let ties = 0; const taskDiffs = new Map<string, number[]>();
  for (const pair of pairs.values()) if (pair['local-summary'] && pair['window-reset']) {
    const a = pair['local-summary']; const b = pair['window-reset']; const difference = Number(a.success) - Number(b.success);
    if (difference > 0) summaryWins++; else if (difference < 0) resetWins++; else ties++;
    const group = taskDiffs.get(a.task) ?? []; group.push(difference); taskDiffs.set(a.task, group);
  }
  const means = [...taskDiffs.values()].map(values => values.reduce((a, b) => a + b, 0) / values.length);
  const difference = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 0;
  let seed = 48271; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const bootstrap = Array.from({ length: 2000 }, () => means.length ? Array.from({ length: means.length }, () => means[Math.floor(random() * means.length)]!).reduce((a, b) => a + b, 0) / means.length : 0).sort((a, b) => a - b);
  return { pairs: summaryWins + resetWins + ties, summaryWins, resetWins, ties, difference, bootstrap95: [bootstrap[49]!, bootstrap[1949]!] };
}
export function renderOnlineReport(report: OnlineReport): string {
  const stats = pairedSummary(report);
  const lines = ['# DeepSeek 官方在线配对实验', '', `状态：${report.status}；模型：${report.model}（官方 V4.1-Flash 名称）；thinking disabled；temperature 0。`, '',
    '原生 dsh Agent 工具循环；统一两阶段任务及切换机会。窗口 token 为估算控制值，表中消耗来自 API usage；含辅助摘要及缓存输入，不重复计缓存。', '',
    `已记录 ${report.trials.length}/${report.plannedTrials} 个 trial；${stats.pairs} 对（含运行失败）。Summary 独胜 ${stats.summaryWins} 对，Reset 独胜 ${stats.resetWins} 对，平局 ${stats.ties} 对。`,
    `按任务聚类的平均成功率差（Summary − Reset）：${(stats.difference * 100).toFixed(1)} 个百分点；bootstrap 95% 区间 [${(stats.bootstrap95[0] * 100).toFixed(1)}, ${(stats.bootstrap95[1] * 100).toFixed(1)}]。`, '',
    '受控小任务集及同一模型的结果，不能推广为所有 Agent 任务的策略优劣。开发集与评测集按 seed 分离；重复样本按任务聚类，不当成独立任务。', '',
    `配置哈希：\`${report.configHash}\`；任务集哈希：\`${report.tasksetHash}\`；实现哈希：\`${report.implementationHash}\`。`, '',
    '| 策略 | 正确 / 样本 | 运行失败 | 请求 / 摘要 / 工具 | 实际 input / output | 已计 token |', '| --- | --- | --- | --- | --- | --- |'];
  for (const strategy of ['local-summary', 'window-reset'] as const) {
    const trials = report.trials.filter(t => t.strategy === strategy); const sum = (key: 'calls' | 'summaryCalls' | 'toolCalls' | 'chargedTokens') => trials.reduce((n, t) => n + t[key], 0);
    const input = trials.some(t => t.actualInputTokens === null) ? 'unknown' : trials.reduce((n, t) => n + t.actualInputTokens!, 0);
    const output = trials.some(t => t.actualOutputTokens === null) ? 'unknown' : trials.reduce((n, t) => n + t.actualOutputTokens!, 0);
    lines.push(`| ${strategy} | ${trials.filter(t => t.success).length}/${trials.length} | ${trials.filter(t => t.failure).length} | ${sum('calls')} / ${sum('summaryCalls')} / ${sum('toolCalls')} | ${input} / ${output} | ${sum('chargedTokens')} |`);
  }
  const actualInput = report.trials.reduce((n, t) => n + (t.actualInputTokens ?? 0), 0); const actualOutput = report.trials.reduce((n, t) => n + (t.actualOutputTokens ?? 0), 0);
  lines.push('', `按官方高峰价且全部输入视为未命中的保守费用估计：≤ ${((actualInput * 2 + actualOutput * 8) / 1_000_000).toFixed(4)} 元（仅覆盖 usage 已知的 trial；并非账户扣款账单）。`, '',
    '| Task / 重复 | 策略 | 正确 | 失败原因 | 窗口 | 请求 / 摘要 / 工具 | Token |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.trials.map(t => `| ${t.task} / ${t.repetition} | ${t.strategy} | ${t.success} | ${t.failure ?? '-'} | ${t.windows} | ${t.calls} / ${t.summaryCalls} / ${t.toolCalls} | ${t.chargedTokens} |`), '');
  return lines.join('\n');
}
