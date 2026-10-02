import { Session } from './session.js';
/** Session-local virtual storage. Nothing here reads arbitrary OS files. */
export declare class RecoveryTools {
    readonly session: Session;
    constructor(session: Session);
    execute(name: string, args?: Record<string, unknown>): unknown;
}
