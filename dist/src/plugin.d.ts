import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Config as WindowConfig, Strategy } from './types.js';
export declare const name = "agent-benchmark";
export declare const inject: string[];
export interface Config extends Omit<WindowConfig, 'tools'> {
    strategy: Strategy;
    maxCalls: number;
    globalTokenBudget: number;
}
export declare const Config: Schema<{
    strategy?: "local-summary" | "window-reset" | null;
    capacityTokens?: number | null;
    triggerTokens?: number | null;
    outputReserveTokens?: number | null;
    scope?: "total" | "body-after-prefix" | null;
    userRetentionTokens?: number | null;
    summaryOutputTokens?: number | null;
    totalTokenBudget?: number | null;
    summaryRetries?: number | null;
    timeoutMs?: number | null;
    reminderTokens?: number | null;
    hintBytes?: number | null;
    maxCalls?: number | null;
    globalTokenBudget?: number | null;
} & import("@deepseek-ai/cosmokit").Dict, Config, "plain">;
export declare function apply(ctx: Context, options: Config): Promise<void>;
