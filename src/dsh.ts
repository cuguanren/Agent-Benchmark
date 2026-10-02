import { Context, Service } from '@deepseek-ai/cordis';
import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, MessageId } from '@deepseek-ai/dsh-llm';
import type LlmService from '@deepseek-ai/dsh-llm';
import type { Message as DshMessage, TokenUsage } from '@deepseek-ai/dsh-llm';
import { Session } from './session.js';
import { transition } from './strategies.js';
import type { TransitionOptions } from './strategies.js';
import { BenchmarkError, ContextOverflow } from './types.js';
import type { Model, ModelRequest, ModelResult, Usage } from './types.js';

export interface DshConfig { provider: string; model: string; temperature?: number }
/** dsh input/cache counts are disjoint; the benchmark input count includes cache. */
export function normalizeUsage(usage: TokenUsage): Usage {
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (values.some(n => !Number.isSafeInteger(n) || n < 0)) throw new BenchmarkError('provider_failed', 'Invalid dsh usage');
  return { inputTokens: values[0]! + values[2]! + values[3]!, outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}) };
}
export class DshModel implements Model {
  constructor(readonly llm: LlmService, readonly config: DshConfig) {
    if (!config.provider || !config.model) throw new BenchmarkError('invalid_input', 'dsh provider and model are required');
  }
  async generate(request: ModelRequest): Promise<ModelResult> {
    const messages: DshMessage[] = request.messages.map(m => {
      const id = MessageId(m.id);
      if (m.role === 'tool') return { id, role: 'user', source: { kind: 'tool', callId: CallId(m.toolCallId!) },
        content: [{ type: 'tool-result', toolCallId: CallId(m.toolCallId!), content: [{ type: 'text', text: m.text }] }] };
      if (m.role === 'assistant') {
        if (m.toolCallId && !m.toolName) throw new BenchmarkError('invalid_input', 'dsh tool replay requires a tool name');
        return { id, role: 'assistant', source: { kind: 'model', provider: this.config.provider, model: this.config.model },
          content: m.toolCallId ? [{ type: 'tool-call', id: CallId(m.toolCallId), name: m.toolName!, arguments: m.text }] : [{ type: 'text', text: m.text }] };
      }
      return { id, role: m.role, source: m.role === 'system' ? { kind: 'plugin', plugin: 'agent-benchmark' } : { kind: 'user' }, content: [{ type: 'text', text: m.text }] };
    });
    const blocks = new Map<number, string>(); const deltas = new Map<number, string>();
    let usage: Usage | undefined; let finished = false;
    for await (const chunk of this.llm.stream({ ...this.config, messages, tools: request.tools, maxTokens: request.maxOutputTokens,
      signal: request.signal, ...(request.purpose === 'summary' ? { purpose: 'compaction' as const } : {}) })) {
      if (chunk.type === 'text-delta') deltas.set(chunk.index, (deltas.get(chunk.index) ?? '') + chunk.text);
      else if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
      else if (chunk.type === 'usage') usage = normalizeUsage(chunk.usage);
      else if (chunk.type === 'finish') {
        finished = true;
        if (chunk.reason.kind === 'error') {
          if (chunk.reason.failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) throw new ContextOverflow('dsh provider context overflow');
          throw new BenchmarkError('provider_failed', 'dsh provider failed', ['RATE_LIMIT', 'TRANSPORT'].includes(chunk.reason.failure.code));
        }
        if (chunk.reason.kind === 'aborted') throw new BenchmarkError('cancelled', 'dsh request aborted');
        if (chunk.reason.kind !== 'stop') throw new BenchmarkError(request.purpose === 'summary' ? 'summary_failed' : 'provider_failed', 'Text-only bridge requires a complete text response');
      }
    }
    if (!finished) throw new BenchmarkError('provider_failed', 'dsh stream ended without finish');
    const text = [...new Set([...deltas.keys(), ...blocks.keys()])].sort((a, b) => a - b).map(i => blocks.get(i) ?? deltas.get(i)!).join('');
    return { text, ...(usage ? { usage } : {}) };
  }
}

declare module '@deepseek-ai/cordis' { interface Context { contextBenchmark: ContextBenchmarkService } }
/** P0 model-service bridge; this does not change the native dsh Agent loop. */
export class ContextBenchmarkService extends Service {
  static inject = ['llm'];
  readonly model: DshModel;
  private readonly sessions = new Set<Session>();
  constructor(ctx: Context, config: DshConfig) {
    super(ctx, 'contextBenchmark'); this.model = new DshModel(ctx.llm, config);
    // Register on the owning plugin context, rather than a caller-rebound service context.
    const sessions = this.sessions;
    ctx.effect(() => () => { for (const session of sessions) session.close(); sessions.clear(); });
  }
  create(options: Parameters<typeof Session.create>[0]): Session {
    const session = Session.create(options);
    this.sessions.add(session);
    return session;
  }
  transition(session: Session, options?: TransitionOptions): Promise<void> { return transition(session, this.model, options); }
}
export default ContextBenchmarkService;
