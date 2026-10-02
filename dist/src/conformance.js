import * as fs from 'node:fs';
import { join } from 'node:path';
import { Session } from './session.js';
import { callModel } from './model.js';
import { transition } from './strategies.js';
import { RecoveryTools } from './tools.js';
import { BenchmarkError, hash, resolveConfig } from './types.js';
/** Reads only model-visible messages. This fixture is a protocol probe, not a task solver. */
export class ScriptedModel {
    async generate(request) {
        const visible = request.messages.map(m => {
            try {
                const data = JSON.parse(m.text);
                if (typeof data?.text === 'string')
                    return data.text;
            }
            catch { /* Plain text is already model-visible. */ }
            return m.text;
        }).join('\n');
        const key = /KEY: ([A-Za-z0-9_-]+)/.exec(visible)?.[1];
        const constraint = /CONSTRAINT: ([^\r\n]+)/.exec(visible)?.[1];
        if (request.purpose === 'summary')
            return { text: `Progress: observed task data.\nKEY: ${key ?? 'unknown'}\nCONSTRAINT: ${constraint ?? 'unknown'}\nNext: return the key while respecting the constraint.` };
        return { text: JSON.stringify(key ? { key, constraint, save: `KEY: ${key}\nCONSTRAINT: ${constraint}` } : { recover: true }) };
    }
}
export function validateRunConfig(value) {
    if (!value || typeof value !== 'object')
        throw new BenchmarkError('invalid_input', 'Run configuration must be an object');
    const input = value;
    if (input.schemaVersion !== 1 || input.mode !== 'conformance' || !Array.isArray(input.scenarios) || !input.scenarios.length)
        throw new BenchmarkError('invalid_input', 'Expected v1 conformance scenarios');
    resolveConfig(input.config);
    const ids = new Set();
    for (const s of input.scenarios) {
        if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(s.id) || ids.has(s.id)
            || typeof s.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(s.key)
            || typeof s.constraint !== 'string' || !s.constraint || /[\r\n]/.test(s.constraint)
            || typeof s.saveNote !== 'boolean' || !Number.isSafeInteger(s.noiseBytes) || s.noiseBytes < 0 || s.noiseBytes > 100_000)
            throw new BenchmarkError('invalid_input', 'Invalid scenario');
        ids.add(s.id);
    }
    return structuredClone(input);
}
function exchange(session, tools, name, args) {
    const callId = `tool-${session.events.length}`;
    session.append('assistant', JSON.stringify(args), callId, name);
    const result = tools.execute(name, args);
    session.append('tool', JSON.stringify(result), callId);
    return result;
}
async function runTrial(scenario, strategy, config, out) {
    const trace = `${scenario.id}.${strategy}.jsonl`;
    let session = Session.create({ id: `${scenario.id}-${strategy}`, strategy, initial: 'Complete the task using only observed data. Preserve the user constraint.', config, file: join(out, trace) });
    const checks = [];
    let failure = null;
    const check = (name, passed) => checks.push({ name, passed });
    const model = new ScriptedModel();
    let beforeWindow = '';
    try {
        session.append('user', `CONSTRAINT: ${scenario.constraint}`);
        session.append('assistant', '{}', 'observation', 'observe');
        const observation = session.append('tool', `KEY: ${scenario.key}`, 'observation');
        session.append('assistant', 'x'.repeat(scenario.noiseBytes));
        const answerBefore = JSON.parse((await callModel(session, model, { messages: session.requestMessages(), purpose: 'agent', maxOutputTokens: config.outputReserveTokens })).text);
        const tools = new RecoveryTools(session);
        // A scripted Agent explicitly selects notes.write. The transition never does this.
        if (strategy === 'window-reset' && scenario.saveNote)
            exchange(session, tools, 'notes.write', { path: 'state', text: answerBefore.save });
        beforeWindow = session.snapshot.window.currentId;
        await transition(session, model);
        check('window_advanced', session.snapshot.window.previousId === beforeWindow && session.snapshot.window.number === 2);
        check('durable_observation_preserved', session.history.some(m => m.id === observation.id && m.text === observation.text));
        if (strategy === 'local-summary') {
            check('one_summary_request', session.snapshot.calls.filter(c => c.purpose === 'summary').length === 1);
            check('raw_assistant_tool_removed', session.snapshot.active.every(m => m.role !== 'assistant' && m.role !== 'tool'));
            check('handoff_contains_observed_key', session.snapshot.active.some(m => m.kind === 'summary' && m.text.includes(`KEY: ${scenario.key}`)));
        }
        else {
            check('zero_summary_requests', session.snapshot.calls.every(c => c.purpose !== 'summary'));
            check('old_content_not_injected', !session.snapshot.active.some(m => m.text.includes(`KEY: ${scenario.key}`)));
            check('notes_only_if_agent_saved', Object.keys(session.snapshot.notes).length === (scenario.saveNote ? 1 : 0));
        }
        let answer = JSON.parse((await callModel(session, model, { messages: session.requestMessages(), purpose: 'agent', maxOutputTokens: config.outputReserveTokens })).text);
        if (strategy === 'window-reset') {
            check('agent_requests_recovery', answer.recover === true);
            const beforeRead = session.status().inputTokens;
            if (scenario.saveNote)
                exchange(session, tools, 'notes.read', { path: 'state' });
            else {
                const hits = exchange(session, tools, 'history.search', { query: 'KEY:' });
                if (!hits.items.length)
                    throw new BenchmarkError('invalid_input', 'Observed key is missing from history');
                exchange(session, tools, 'history.read', { id: hits.items[0].id });
                const constraints = exchange(session, tools, 'history.search', { query: 'CONSTRAINT:' });
                exchange(session, tools, 'history.read', { id: constraints.items[0].id });
            }
            check('recovery_consumes_context', session.status().inputTokens > beforeRead);
            answer = JSON.parse((await callModel(session, model, { messages: session.requestMessages(), purpose: 'agent', maxOutputTokens: config.outputReserveTokens })).text);
        }
        check('observed_key_recovered', answer.key === scenario.key);
        check('user_constraint_recovered', answer.constraint === scenario.constraint);
        const snapshot = session.snapshot;
        session.close();
        session = Session.resume(join(out, trace));
        check('restart_preserves_snapshot', hash(session.snapshot) === hash(snapshot));
    }
    catch (error) {
        failure = error instanceof BenchmarkError ? error.code : 'unclassified_failure';
        check('execution_completed', false);
    }
    const state = session.snapshot;
    const actual = state.calls.every(c => c.measurement === 'actual');
    const result = { scenario: scenario.id, strategy, passed: checks.every(c => c.passed), checks, failure,
        windows: state.window.number, calls: state.calls.length, summaryCalls: state.calls.filter(c => c.purpose === 'summary').length,
        toolCalls: session.events.filter(e => e.type === 'tool/invocation').length, chargedTokens: session.spentTokens,
        measurement: actual ? 'actual' : state.calls.some(c => c.measurement === 'actual') ? 'mixed' : 'estimated',
        actualInputTokens: actual ? state.calls.reduce((n, c) => n + c.inputTokens, 0) : null,
        actualOutputTokens: actual ? state.calls.reduce((n, c) => n + c.outputTokens, 0) : null, trace };
    session.close();
    return result;
}
export async function runConformance(input, out) {
    const run = validateRunConfig(input);
    const config = resolveConfig(run.config);
    fs.mkdirSync(out, { recursive: true });
    if (fs.readdirSync(out).length)
        throw new BenchmarkError('storage_failed', 'Output directory must be empty to preserve prior evidence');
    const trials = [];
    for (const scenario of run.scenarios)
        for (const strategy of ['local-summary', 'window-reset'])
            trials.push(await runTrial(scenario, strategy, config, out));
    const report = { schemaVersion: 1, mode: 'conformance', implementation: '0.1.0', fixture: 'scripted-protocol-v1',
        limitation: 'Scripted protocol checks only; no online model quality or cost comparison. Token consumption is estimated when provider usage is unavailable.',
        configHash: hash(config), scenarioHash: hash(run.scenarios), config, trials, passed: trials.every(t => t.passed) };
    fs.writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const markdown = ['# 功能验证报告', '', '模式：conformance；脚本模型：scripted-protocol-v1。', '',
        '仅验证状态与恢复协议，不代表真实模型质量或策略成本优势。实际 usage 未提供，表中 token 为估算，实际 input/output 为 unknown。', '',
        `配置哈希：\`${report.configHash}\``, `场景哈希：\`${report.scenarioHash}\``, '',
        '| 场景 | 策略 | 检查 | 窗口 | 请求 / 摘要 / 工具 | 估算 token | 轨迹 |', '| --- | --- | --- | --- | --- | --- | --- |',
        ...trials.map(t => `| ${t.scenario} | ${t.strategy} | ${t.checks.filter(c => c.passed).length}/${t.checks.length} ${t.passed ? '通过' : '失败'} | ${t.windows} | ${t.calls} / ${t.summaryCalls} / ${t.toolCalls} | ${t.chargedTokens} | [JSONL](${t.trace}) |`), '',
        ...trials.flatMap(t => [`## ${t.scenario} / ${t.strategy}`, '', ...t.checks.map(c => `- ${c.passed ? 'PASS' : 'FAIL'} ${c.name}`), ...(t.failure ? [`- Failure: ${t.failure}`] : []), ''])].join('\n');
    fs.writeFileSync(join(out, 'report.md'), markdown);
    return report;
}
