import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
/** The upstream append API lacks an envelope option for extension events.
 * Mark non-surface benchmark metadata ignorable at the storage boundary;
 * derived history and the atomic checkpoint source remain native events.
 */
export declare class BenchmarkPersistence extends JsonlSessionPersistence {
    appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>;
}
export default BenchmarkPersistence;
