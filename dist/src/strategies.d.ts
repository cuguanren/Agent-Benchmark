import { Session } from './session.js';
import type { Model } from './types.js';
export declare const SUMMARIZATION_PROMPT = "Create a concise structured handoff summary for the next model. Include current progress and key decisions; important context, constraints and user preferences; unfinished work and next steps; critical data, examples and references needed to continue.";
export declare const SUMMARY_PREFIX = "Another model produced this handoff summary. Build on completed work and avoid repeating it:\n";
export interface TransitionOptions {
    trigger?: 'manual' | 'pressure' | 'new-context';
    signal?: AbortSignal;
    preHook?: () => boolean | Promise<boolean>;
    postHook?: () => void | Promise<void>;
}
export declare function transition(session: Session, model: Model, options?: TransitionOptions): Promise<void>;
export declare function ensureWindow(session: Session, model: Model, options?: TransitionOptions): Promise<boolean>;
