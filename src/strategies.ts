import { randomUUID } from 'node:crypto';
import { Session } from './session.js';
import { invokeModel } from './model.js';
import { BenchmarkError, ContextOverflow, estimateInput, estimateText, messageUnits, truncateBytes } from './types.js';
import type { Message, Model } from './types.js';

export const SUMMARIZATION_PROMPT = 'Create a concise structured handoff summary for the next model. Include current progress and key decisions; important context, constraints and user preferences; unfinished work and next steps; critical data, examples and references needed to continue.';
export const SUMMARY_PREFIX = 'Another model produced this handoff summary. Build on completed work and avoid repeating it:\n';
export interface TransitionOptions {
  trigger?: 'manual' | 'pressure' | 'new-context'; signal?: AbortSignal;
  preHook?: () => boolean | Promise<boolean>; postHook?: () => void | Promise<void>;
}

function retainUsers(messages: Message[], budget: number, windowId: string): Message[] {
  const retained: Message[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || message.kind !== 'normal') continue;
    const tokens = estimateText(message.text);
    if (tokens <= budget) { retained.push(message); budget -= tokens; }
    else { const text = truncateBytes(message.text, budget * 4); if (text) retained.push({ ...message, id: randomUUID(), windowId, text }); break; }
  }
  return retained.reverse();
}

export async function transition(session: Session, model: Model, options: TransitionOptions = {}): Promise<void> {
  return session.exclusive(async () => {
    const before = session.snapshot;
    session.requestMessages(); // Refuse a transition between a tool call and its result.
    const id = randomUUID(); let committed = false;
    session.record('transition/start', { id, strategy: before.strategy, windowId: before.window.currentId, trigger: options.trigger ?? 'manual' });
    try {
      if (options.signal?.aborted || (options.preHook && !await options.preHook())) throw new BenchmarkError('cancelled', 'Transition cancelled');
      const window = { ...before.window, number: before.window.number + 1, previousId: before.window.currentId,
        currentId: `${before.id}:w${before.window.number + 1}`, baselineTokens: 0 };
      let active = session.initialMessages(before.initial, window);
      if (before.strategy === 'local-summary') {
        let units = messageUnits(before.active); let retries = 0; let text: string;
        for (;;) {
          const messages = [...units.flat(), session.makeMessage('user', SUMMARIZATION_PROMPT)];
          try {
            text = (await invokeModel(session, model, { messages, maxOutputTokens: before.config.summaryOutputTokens, purpose: 'summary',
              ...(options.signal ? { signal: options.signal } : {}) })).text.trim();
            break;
          } catch (error) {
            if (error instanceof ContextOverflow) {
              const index = units.findIndex(unit => unit[0]!.kind !== 'initial');
              if (index < 0) throw new BenchmarkError('context_exhausted', 'Summary request cannot fit even after trimming history');
              units = units.filter((_, i) => i !== index);
            } else if (error instanceof BenchmarkError && error.retryable && retries++ < before.config.summaryRetries) continue;
            else throw error;
          }
        }
        if (!text) throw new BenchmarkError('summary_failed', 'Summary is empty');
        active = [...active, ...retainUsers(before.active, before.config.userRetentionTokens, window.currentId), session.makeMessage('user', SUMMARY_PREFIX + text, 'summary', window.currentId)];
      } else {
        const hint = session.hint();
        if (hint) active.push(session.makeMessage('system', `Available notes (path and size; read explicitly):\n${hint}`, 'initial', window.currentId));
      }
      messageUnits(active);
      const size = estimateInput(active, before.config.tools);
      if (size + before.config.outputReserveTokens > before.config.capacityTokens) throw new BenchmarkError('context_exhausted', 'Replacement context exceeds capacity');
      if (options.signal?.aborted) throw new BenchmarkError('cancelled', 'Transition cancelled before commit');
      window.baselineTokens = size;
      session.commit({ ...session.snapshot, window, active, reminderSent: false, requestedReset: false });
      committed = true;
      await options.postHook?.();
      session.record('transition/end', { id, committed, windowId: window.currentId, outcome: 'success' });
    } catch (error) {
      const code = error instanceof BenchmarkError ? error.code : 'provider_failed';
      if (code !== 'storage_failed') session.record('transition/end', { id, committed, outcome: 'failed', code });
      if (error instanceof BenchmarkError) throw error;
      throw new BenchmarkError('provider_failed', committed ? 'Post-transition hook failed after commit' : 'Transition hook failed');
    }
  });
}

export async function ensureWindow(session: Session, model: Model, options: TransitionOptions = {}): Promise<boolean> {
  if (!session.status().shouldTransition) { session.remind(); return false; }
  await transition(session, model, { ...options, trigger: session.snapshot.requestedReset ? 'new-context' : 'pressure' });
  return true;
}
