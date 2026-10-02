import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BenchmarkError, estimateInput, hash, messageUnits, resolveConfig, truncateBytes } from './types.js';
import type { CallRecord, Config, JournalEvent, Message, Snapshot, Strategy, Window } from './types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BenchmarkError('invalid_input', 'Event data must be an object');
  return value as Record<string, unknown>;
}
function integer(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validateMessage(value: unknown): asserts value is Message {
  const m = object(value);
  if (typeof m.id !== 'string' || !m.id || typeof m.windowId !== 'string' || !m.windowId || typeof m.text !== 'string'
    || !['system', 'user', 'assistant', 'tool'].includes(m.role as string) || !['initial', 'normal', 'summary', 'reminder'].includes(m.kind as string)
    || (m.toolCallId !== undefined && (typeof m.toolCallId !== 'string' || !m.toolCallId || !['assistant', 'tool'].includes(m.role as string)))
    || (m.role === 'tool' && m.toolCallId === undefined)
    || (m.toolName !== undefined && (typeof m.toolName !== 'string' || !m.toolName || m.role !== 'assistant' || !m.toolCallId))) {
    throw new BenchmarkError('invalid_input', 'Invalid message event');
  }
}
function validateCall(value: unknown): asserts value is CallRecord {
  const c = object(value);
  if (typeof c.id !== 'string' || !c.id || !['agent', 'summary'].includes(c.purpose as string)
    || !['pending', 'success', 'failed'].includes(c.status as string) || !integer(c.reservedTokens) || !integer(c.chargedTokens)
    || !['actual', 'estimated'].includes(c.measurement as string)
    || (c.failureCode !== undefined && (c.status !== 'failed' || !['context_overflow', 'context_exhausted', 'summary_failed', 'budget_exhausted', 'output_limit', 'cancelled', 'storage_failed', 'invalid_input', 'provider_failed'].includes(c.failureCode as string)))
    || (c.measurement === 'actual' ? !integer(c.inputTokens) || !integer(c.outputTokens) || c.chargedTokens !== (c.inputTokens as number) + (c.outputTokens as number)
      : c.inputTokens !== null || c.outputTokens !== null)
    || (c.status === 'pending' && (c.chargedTokens !== c.reservedTokens || c.measurement !== 'estimated'))) {
    throw new BenchmarkError('invalid_input', 'Invalid model accounting event');
  }
}

export class Session {
  private state!: Snapshot;
  private fd: number | undefined;
  private lock: string | undefined;
  private closed = false;
  private busy = false;
  private broken = false;
  private readonly log: JournalEvent[] = [];
  private readonly archive = new Map<string, Message>();
  private readonly windowArchive = new Map<string, Window>();
  private constructor() {}

  static create(options: { id: string; strategy: Strategy; initial: string; config?: Partial<Config>; file?: string }): Session {
    if (typeof options.id !== 'string' || !options.id || typeof options.initial !== 'string' || !['local-summary', 'window-reset'].includes(options.strategy)) {
      throw new BenchmarkError('invalid_input', 'Invalid session identity, initial context or strategy');
    }
    const session = new Session();
    const config = resolveConfig(options.config);
    const window: Window = { number: 1, firstId: `${options.id}:w1`, currentId: `${options.id}:w1`, previousId: null, baselineTokens: 0 };
    const active = session.initialMessages(options.initial, window);
    window.baselineTokens = estimateInput(active, config.tools);
    if (window.baselineTokens + config.outputReserveTokens > config.capacityTokens) throw new BenchmarkError('context_exhausted', 'Initial context exceeds capacity');
    const state: Snapshot = { id: options.id, strategy: options.strategy, initial: options.initial, config, window, active,
      notes: {}, calls: [], reminderSent: false, requestedReset: false };
    try {
      if (options.file) session.openFile(options.file, true);
      session.record('session/start', state);
      return session;
    } catch (error) { session.close(); throw error; }
  }

  static resume(file: string): Session {
    const session = new Session();
    try {
      session.openFile(file, false);
      const bytes = fs.readFileSync(file); const text = bytes.toString('utf8');
      const end = text.lastIndexOf('\n') + 1;
      if (!end) throw new BenchmarkError('invalid_input', 'No complete session record');
      for (const line of text.slice(0, end).split('\n').slice(0, -1)) {
        let event: JournalEvent;
        try { event = JSON.parse(line) as JournalEvent; } catch { throw new BenchmarkError('invalid_input', 'Corrupt internal journal record'); }
        const { hash: digest, ...payload } = event;
        if (event.schemaVersion !== 1 || event.seq !== session.log.length + 1
          || event.previousHash !== (session.log.at(-1)?.hash ?? '') || digest !== hash(payload)) {
          throw new BenchmarkError('invalid_input', 'Journal integrity check failed');
        }
        session.apply(event); session.log.push(event);
      }
      if (!session.state) throw new BenchmarkError('invalid_input', 'Missing session start');
      const validBytes = Buffer.byteLength(text.slice(0, end));
      if (validBytes < bytes.length) {
        // Windows append handles cannot truncate; truncate through a separate writable handle.
        fs.truncateSync(file, validBytes); fs.fsyncSync(session.fd!);
        session.record('recovery/tail-discarded', { bytes: bytes.length - validBytes });
      }
      return session;
    } catch (error) { session.close(); throw error; }
  }

  private openFile(file: string, create: boolean): void {
    if (!create && !fs.existsSync(file)) throw new BenchmarkError('invalid_input', 'Journal does not exist');
    fs.mkdirSync(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let lockFd: number;
    try { lockFd = fs.openSync(lock, 'wx'); } catch { throw new BenchmarkError('storage_failed', 'Session journal is already locked'); }
    this.lock = lock;
    try { fs.writeFileSync(lockFd, String(process.pid)); } finally { fs.closeSync(lockFd); }
    try { this.fd = fs.openSync(file, create ? 'ax+' : 'a+');
      if (create && fs.fstatSync(this.fd).size > 0) throw new BenchmarkError('storage_failed', 'Journal exists; use resume or a new path');
      if (!create && !fs.fstatSync(this.fd).size) throw new BenchmarkError('invalid_input', 'Empty journal');
    } catch (error) { this.close(); throw error; }
  }

  get snapshot(): Snapshot { return structuredClone(this.state); }
  get events(): JournalEvent[] { return structuredClone(this.log); }
  get history(): Message[] { return structuredClone([...this.archive.values()]); }
  get windows(): Window[] { return structuredClone([...this.windowArchive.values()]); }
  get spentTokens(): number { return this.state.calls.reduce((n, call) => n + call.chargedTokens, 0); }
  get recoveryStatus(): { incompleteTransitions: { id: string; committed: boolean }[]; pendingModelCallIds: string[] } {
    const starts = new Map<string, { id: string; windowId: string }>();
    for (const e of this.log) {
      if (e.type === 'transition/start') { const data = e.data as { id: string; windowId: string }; starts.set(data.id, data); }
      if (e.type === 'transition/end') starts.delete((e.data as { id: string }).id);
    }
    return { incompleteTransitions: [...starts.values()].map(s => ({ id: s.id,
      committed: this.log.some(e => e.type === 'checkpoint' && (e.data as Snapshot).window.previousId === s.windowId) })),
    pendingModelCallIds: this.state.calls.filter(c => c.status === 'pending').map(c => c.id) };
  }

  /** Append before publishing state. A storage failure disables further writes in this process. */
  record(type: string, data: unknown): void {
    if (this.closed || this.broken) throw new BenchmarkError('storage_failed', 'Session writer is closed or failed');
    const payload = { schemaVersion: 1 as const, seq: this.log.length + 1, type, data: structuredClone(data), previousHash: this.log.at(-1)?.hash ?? '' };
    const event: JournalEvent = { ...payload, hash: hash(payload) };
    this.validate(event);
    if (this.fd !== undefined) {
      try { fs.appendFileSync(this.fd, JSON.stringify(event) + '\n'); fs.fsyncSync(this.fd); }
      catch { this.broken = true; throw new BenchmarkError('storage_failed', 'Could not persist session event'); }
    }
    this.apply(event); this.log.push(event);
  }

  private validate(event: JournalEvent): void {
    if (!this.state && event.type !== 'session/start') throw new BenchmarkError('invalid_input', 'First event must initialize session');
    const data = object(event.data);
    switch (event.type) {
      case 'session/start': case 'checkpoint': {
        if (event.type === 'session/start' && this.state) throw new BenchmarkError('invalid_input', 'Duplicate session start');
        const next = data as unknown as Snapshot;
        resolveConfig(next.config);
        if (!Array.isArray(next.active) || !Array.isArray(next.calls)) throw new BenchmarkError('invalid_input', 'Missing checkpoint arrays');
        next.active.forEach(validateMessage); next.calls.forEach(validateCall); messageUnits(next.active);
        const w = object(next.window);
        object(next.notes);
        if (typeof next.id !== 'string' || !next.id || !['local-summary', 'window-reset'].includes(next.strategy) || typeof next.initial !== 'string'
          || !integer(w.number) || (w.number as number) < 1 || !integer(w.baselineTokens)
          || w.currentId !== `${next.id}:w${w.number}` || w.firstId !== `${next.id}:w1`
          || w.previousId !== ((w.number as number) === 1 ? null : `${next.id}:w${(w.number as number) - 1}`)
          || typeof next.reminderSent !== 'boolean' || typeof next.requestedReset !== 'boolean'
          || Object.entries(next.notes).some(([key, value]) => typeof value !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
          || new Set(next.active.map(m => m.id)).size !== next.active.length || new Set(next.calls.map(c => c.id)).size !== next.calls.length
          || (this.state && (next.id !== this.state.id || next.strategy !== this.state.strategy || hash(next.config) !== hash(this.state.config)))) throw new BenchmarkError('invalid_input', 'Invalid checkpoint');
        if (event.type === 'checkpoint' && (next.window.number !== this.state.window.number + 1 || next.initial !== this.state.initial
          || hash(next.calls) !== hash(this.state.calls) || hash(next.notes) !== hash(this.state.notes)
          || next.active.some(m => this.archive.has(m.id) && hash(this.archive.get(m.id)) !== hash(m)))) throw new BenchmarkError('invalid_input', 'Checkpoint cannot rewrite history, notes or accounting');
        if (next.window.baselineTokens !== estimateInput(next.active, next.config.tools)
          || next.window.baselineTokens + next.config.outputReserveTokens > next.config.capacityTokens) throw new BenchmarkError('invalid_input', 'Invalid checkpoint capacity');
        break;
      }
      case 'message': {
        validateMessage(data);
        const m = data; const last = this.state.active.at(-1); const pending = last?.role === 'assistant' && last.toolCallId !== undefined;
        if (this.archive.has(m.id) || m.windowId !== this.state.window.currentId
          || (pending ? m.role !== 'tool' || m.toolCallId !== last.toolCallId : m.role === 'tool')
          || (m.role === 'assistant' && m.toolCallId && [...this.archive.values()].some(x => x.role === 'assistant' && x.toolCallId === m.toolCallId))) throw new BenchmarkError('invalid_input', 'Invalid message ordering or identity');
        break;
      }
      case 'note/write':
        if (typeof data.path !== 'string' || !data.path || ['__proto__', 'constructor', 'prototype'].includes(data.path) || typeof data.text !== 'string') throw new BenchmarkError('invalid_input', 'Invalid note event');
        break;
      case 'model/request': case 'model/response': {
        validateCall(data); const prior = this.state.calls.find(c => c.id === data.id);
        if (event.type === 'model/request' ? prior !== undefined || data.status !== 'pending' : !prior || prior.status !== 'pending' || data.status === 'pending'
          || data.purpose !== prior.purpose || data.reservedTokens !== prior.reservedTokens) throw new BenchmarkError('invalid_input', 'Invalid model event ordering');
        break;
      }
      case 'transition/start':
        if (typeof data.id !== 'string' || data.windowId !== this.state.window.currentId || data.strategy !== this.state.strategy) throw new BenchmarkError('invalid_input', 'Invalid transition start');
        break;
      case 'transition/end':
        if (typeof data.id !== 'string' || typeof data.committed !== 'boolean') throw new BenchmarkError('invalid_input', 'Invalid transition end');
        break;
      case 'model/input':
        if (!Array.isArray(data.messages) || !integer(data.maxOutputTokens) || typeof data.callId !== 'string' || !this.state.calls.some(c => c.id === data.callId)) throw new BenchmarkError('invalid_input', 'Invalid model input');
        data.messages.forEach(validateMessage); messageUnits(data.messages as Message[]); break;
      case 'model/output':
        if (typeof data.callId !== 'string' || typeof data.text !== 'string') throw new BenchmarkError('invalid_input', 'Invalid model output'); break;
      case 'tool/invocation':
        if (typeof data.name !== 'string') throw new BenchmarkError('invalid_input', 'Invalid tool event'); break;
      case 'reminder/sent': case 'window/requested': case 'recovery/tail-discarded': break;
      default: throw new BenchmarkError('invalid_input', `Unknown event: ${event.type}`);
    }
  }

  private apply(event: JournalEvent): void {
    this.validate(event);
    switch (event.type) {
      case 'session/start':
      case 'checkpoint': {
        const next = structuredClone(event.data) as Snapshot;
        this.state = next;
        for (const message of next.active) this.archive.set(message.id, message);
        this.windowArchive.set(next.window.currentId, next.window);
        break;
      }
      case 'message': {
        const message = event.data as Message;
        this.state.active.push(message); this.archive.set(message.id, message); break;
      }
      case 'note/write': { const { path, text } = event.data as { path: string; text: string }; this.state.notes[path] = text; break; }
      case 'model/request': this.state.calls.push(event.data as CallRecord); break;
      case 'model/response': {
        const call = event.data as CallRecord; const index = this.state.calls.findIndex(c => c.id === call.id);
        if (index < 0) throw new BenchmarkError('invalid_input', 'Response without request');
        this.state.calls[index] = call; break;
      }
      case 'reminder/sent': this.state.reminderSent = true; break;
      case 'window/requested': this.state.requestedReset = true; break;
      case 'transition/start': case 'transition/end': case 'model/input': case 'model/output':
      case 'tool/invocation': case 'recovery/tail-discarded': break;
      default: throw new BenchmarkError('invalid_input', `Unknown event: ${event.type}`);
    }
  }

  makeMessage(role: Message['role'], text: string, kind: Message['kind'] = 'normal', windowId = this.state.window.currentId, toolCallId?: string): Message {
    return { id: randomUUID(), windowId, role, text, kind, ...(toolCallId === undefined ? {} : { toolCallId }) };
  }
  initialMessages(initial: string, window: Window): Message[] {
    return [this.makeMessage('system', initial, 'initial', window.currentId),
      this.makeMessage('system', `First window: ${window.firstId}\nPrevious window: ${window.previousId ?? 'none'}\nCurrent window: ${window.currentId}`, 'initial', window.currentId)];
  }
  append(role: Message['role'], text: string, toolCallId?: string, toolName?: string): Message {
    this.assertMutable();
    if (typeof text !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(role)) throw new BenchmarkError('invalid_input', 'Invalid message');
    const last = this.state.active.at(-1);
    const pending = last?.role === 'assistant' && last.toolCallId !== undefined;
    if (pending ? role !== 'tool' || toolCallId !== last.toolCallId : role === 'tool') throw new BenchmarkError('invalid_input', 'Tool result must immediately match its call');
    if (toolCallId && role !== 'assistant' && role !== 'tool') throw new BenchmarkError('invalid_input', 'Invalid call identity');
    if (role === 'assistant' && toolCallId && this.history.some(m => m.role === 'assistant' && m.toolCallId === toolCallId)) throw new BenchmarkError('invalid_input', 'Duplicate tool call identity');
    const message = this.makeMessage(role, text, 'normal', this.state.window.currentId, toolCallId);
    if (toolName !== undefined) {
      if (!toolName || role !== 'assistant' || !toolCallId) throw new BenchmarkError('invalid_input', 'Tool name requires an assistant call');
      message.toolName = toolName;
    }
    this.record('message', message); return structuredClone(message);
  }
  requestMessages(): Message[] { messageUnits(this.state.active); return structuredClone(this.state.active); }
  status(): { inputTokens: number; scopeTokens: number; remainingTokens: number; shouldTransition: boolean } {
    const inputTokens = estimateInput(this.state.active, this.state.config.tools);
    const scopeTokens = this.state.config.scope === 'total' ? inputTokens : Math.max(0, inputTokens - this.state.window.baselineTokens);
    const remainingTokens = Math.max(0, Math.min(this.state.config.triggerTokens - scopeTokens,
      this.state.config.capacityTokens - this.state.config.outputReserveTokens - inputTokens));
    return { inputTokens, scopeTokens, remainingTokens, shouldTransition: this.state.requestedReset || remainingTokens === 0 };
  }
  remind(): boolean {
    this.assertMutable();
    if (this.state.strategy !== 'window-reset' || this.state.reminderSent || this.status().remainingTokens > this.state.config.reminderTokens) return false;
    this.record('message', this.makeMessage('system', 'Context budget is low. Save task state in notes and record history IDs before requesting a new window.', 'reminder'));
    this.record('reminder/sent', {}); return true;
  }
  hint(): string {
    const directory = Object.entries(this.state.notes).sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => `${path}\t${Buffer.byteLength(text)} bytes`).join('\n');
    return truncateBytes(directory, this.state.config.hintBytes);
  }
  commit(next: Snapshot): void { this.record('checkpoint', next); }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertMutable(); this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  assertMutable(): void {
    if (this.closed || this.broken) throw new BenchmarkError('storage_failed', 'Session is not writable');
    if (this.busy) throw new BenchmarkError('invalid_input', 'Session transition is in progress');
  }
  close(): void {
    this.closed = true;
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    if (this.lock) { fs.unlinkSync(this.lock); this.lock = undefined; }
  }
}
