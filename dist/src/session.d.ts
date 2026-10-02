import type { Config, JournalEvent, Message, Snapshot, Strategy, Window } from './types.js';
export declare class Session {
    private state;
    private fd;
    private lock;
    private closed;
    private busy;
    private broken;
    private readonly log;
    private readonly archive;
    private readonly windowArchive;
    private constructor();
    static create(options: {
        id: string;
        strategy: Strategy;
        initial: string;
        config?: Partial<Config>;
        file?: string;
    }): Session;
    static resume(file: string): Session;
    private openFile;
    get snapshot(): Snapshot;
    get events(): JournalEvent[];
    get history(): Message[];
    get windows(): Window[];
    get spentTokens(): number;
    get recoveryStatus(): {
        incompleteTransitions: {
            id: string;
            committed: boolean;
        }[];
        pendingModelCallIds: string[];
    };
    /** Append before publishing state. A storage failure disables further writes in this process. */
    record(type: string, data: unknown): void;
    private validate;
    private apply;
    makeMessage(role: Message['role'], text: string, kind?: Message['kind'], windowId?: string, toolCallId?: string): Message;
    initialMessages(initial: string, window: Window): Message[];
    append(role: Message['role'], text: string, toolCallId?: string, toolName?: string): Message;
    requestMessages(): Message[];
    status(): {
        inputTokens: number;
        scopeTokens: number;
        remainingTokens: number;
        shouldTransition: boolean;
    };
    remind(): boolean;
    hint(): string;
    commit(next: Snapshot): void;
    exclusive<T>(operation: () => Promise<T>): Promise<T>;
    assertMutable(): void;
    close(): void;
}
