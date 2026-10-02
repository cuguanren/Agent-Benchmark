import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';

/** The upstream append API lacks an envelope option for extension events.
 * Mark non-surface benchmark metadata ignorable at the storage boundary;
 * derived history and the atomic checkpoint source remain native events.
 */
export class BenchmarkPersistence extends JsonlSessionPersistence {
  override appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    return super.appendBatch(meta, events.map(e => e.type.startsWith('benchmark/') ? { ...e, ignorable: true as const } : e), isMaterialized);
  }
}
export default BenchmarkPersistence;
