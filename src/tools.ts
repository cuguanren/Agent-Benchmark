import { Session } from './session.js';
import { BenchmarkError, truncateBytes } from './types.js';

function str(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new BenchmarkError('invalid_input', `Expected string: ${key}`);
  return args[key];
}
function count(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new BenchmarkError('invalid_input', `Invalid range: ${key}`);
  return value as number;
}
function path(args: Record<string, unknown>): string {
  const value = str(args, 'path');
  if (!value || value.length > 200 || value.startsWith('/') || value.includes('\\')
    || value.split('/').some(p => !p || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(p))) throw new BenchmarkError('invalid_input', 'Invalid virtual note path');
  return value;
}
function read(text: string, args: Record<string, unknown>): { text: string; offset: number; nextOffset: number; truncated: boolean } {
  // Offsets are Unicode code points, limits are UTF-8 bytes.
  const chars = [...text]; const offset = count(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const value = truncateBytes(chars.slice(offset).join(''), count(args, 'maxBytes', 4000, 16_000));
  const nextOffset = offset + [...value].length;
  return { text: value, offset, nextOffset, truncated: nextOffset < chars.length };
}

/** Session-local virtual storage. Nothing here reads arbitrary OS files. */
export class RecoveryTools {
  constructor(readonly session: Session) {}
  execute(name: string, args: Record<string, unknown> = {}): unknown {
    this.session.assertMutable();
    if (this.session.snapshot.strategy !== 'window-reset') throw new BenchmarkError('invalid_input', 'Recovery tools are unavailable for local-summary');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BenchmarkError('invalid_input', 'Tool arguments must be an object');
    let result: unknown;
    const notes = this.session.snapshot.notes;
    switch (name) {
      case 'notes.write': {
        const key = path(args); const text = str(args, 'text');
        if (Buffer.byteLength(text) > 1_000_000) throw new BenchmarkError('invalid_input', 'Note exceeds storage limit');
        this.session.record('note/write', { path: key, text }); result = { path: key, bytes: Buffer.byteLength(text) }; break;
      }
      case 'notes.read': {
        const key = path(args);
        if (!Object.hasOwn(notes, key)) throw new BenchmarkError('invalid_input', 'Unknown note path');
        result = { path: key, ...read(notes[key]!, args) }; break;
      }
      case 'notes.list': {
        const entries = Object.entries(notes).sort(([a], [b]) => a.localeCompare(b));
        const offset = count(args, 'offset', 0, Number.MAX_SAFE_INTEGER); const limit = count(args, 'limit', 20, 100);
        result = { items: entries.slice(offset, offset + limit).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) })), truncated: offset + limit < entries.length }; break;
      }
      case 'notes.search': {
        const query = str(args, 'query'); const limit = count(args, 'limit', 20, 100);
        const hits = Object.entries(notes).filter(([key, text]) => key.includes(query) || text.includes(query));
        result = { items: hits.slice(0, limit).map(([path]) => ({ path })), truncated: hits.length > limit }; break;
      }
      case 'history.windows': {
        const windows = this.session.windows; const offset = count(args, 'offset', 0, Number.MAX_SAFE_INTEGER); const limit = count(args, 'limit', 20, 100);
        result = { items: windows.slice(offset, offset + limit), truncated: offset + limit < windows.length }; break;
      }
      case 'history.items': {
        const windowId = str(args, 'windowId');
        if (!this.session.windows.some(w => w.currentId === windowId)) throw new BenchmarkError('invalid_input', 'Unknown window');
        const items = this.session.history.filter(m => m.windowId === windowId);
        const offset = count(args, 'offset', 0, Number.MAX_SAFE_INTEGER); const limit = count(args, 'limit', 20, 100);
        result = { items: items.slice(offset, offset + limit).map(m => ({ id: m.id, role: m.role, bytes: Buffer.byteLength(m.text) })), truncated: offset + limit < items.length }; break;
      }
      case 'history.search': {
        const query = str(args, 'query'); const limit = count(args, 'limit', 20, 100);
        const hits = this.session.history.filter(m => m.text.includes(query));
        result = { items: hits.slice(0, limit).map(m => ({ id: m.id, windowId: m.windowId, role: m.role })), truncated: hits.length > limit }; break;
      }
      case 'history.read': {
        const id = str(args, 'id'); const item = this.session.history.find(m => m.id === id);
        if (!item) throw new BenchmarkError('invalid_input', 'Unknown history item');
        result = { id, windowId: item.windowId, ...read(item.text, args) }; break;
      }
      case 'new_context': this.session.record('window/requested', {}); result = { requested: true }; break;
      default: throw new BenchmarkError('invalid_input', `Unknown recovery tool: ${name}`);
    }
    this.session.record('tool/invocation', { name, args, result });
    return result;
  }
}
