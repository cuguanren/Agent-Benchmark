import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import CompactionEngine, { CompactionId } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CallRecord, Config, Strategy } from './types.js';
export interface NativeState {
    schemaVersion: 1;
    strategy: Strategy;
    configHash: string;
    window: number;
    firstWindowId: string;
    previousWindowId: string | null;
    currentWindowId: string;
    baselineTokens: number;
    notes: Record<string, string>;
    calls: CallRecord[];
    requested: boolean;
    reminded: boolean;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'benchmark/state': NativeState;
        'benchmark/compaction-failure': {
            compactionId: CompactionId;
            committed: boolean;
            stage: 'persistence';
        };
        'benchmark/request': {
            state: NativeState;
            callId: string;
            request: {
                messages: Message[];
                system: string;
                tools: ToolSchema[];
                maxTokens: number;
            };
        };
    }
}
export declare function blockText(blocks: readonly ContentBlock[]): string;
export declare function requestSize(messages: readonly Message[], system?: string, tools?: readonly ToolSchema[]): number;
/** Keeps multi-call assistant blocks and all matching results indivisible. */
export declare function nativeUnits(messages: readonly Message[]): Message[][];
export declare function readNativeState(session: Session): NativeState | undefined;
export interface RunBudget {
    spent: number;
}
export interface NativeConfig {
    strategy: Strategy;
    config?: Partial<Config>;
    maxCalls?: number;
    globalTokenBudget?: number;
    budget?: RunBudget;
    autoAttach?: boolean;
}
export declare class NativeContextStrategy extends CompactionEngine {
    readonly options: NativeConfig;
    static inject: string[];
    readonly config: Config;
    private readonly budget;
    private readonly attached;
    private readonly attaching;
    private readonly toolDisposers;
    private readonly accounted;
    private readonly overflowRetries;
    constructor(ctx: Context, options: NativeConfig);
    state(session: Session): NativeState;
    private initialState;
    private save;
    attach(agent: Agent): Promise<void>;
    private initialize;
    private detach;
    private header;
    private registerRecovery;
    recovery(session: Session, name: string, args: Record<string, unknown>): any;
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: Parameters<CompactionEngine['compactNow']>[2]): Promise<CompactionResult | null>;
    compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
    private summarize;
    private compact;
}
export default NativeContextStrategy;
