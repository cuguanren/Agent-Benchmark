import { Session } from './session.js';
import type { Message, Model, ModelResult } from './types.js';
/** Request reservations survive crashes; absent usage remains explicitly unknown. */
export interface CallOptions {
    messages: Message[];
    maxOutputTokens: number;
    purpose: 'agent' | 'summary';
    signal?: AbortSignal;
}
export declare function callModel(session: Session, model: Model, options: CallOptions): Promise<ModelResult>;
/** Internal entry point for an already serialized transition. */
export declare function invokeModel(session: Session, model: Model, options: CallOptions): Promise<ModelResult>;
