import { ONLINE_MODEL } from './deepseek.js';
import type { Config, Strategy } from './types.js';
export interface OnlineConfig {
    schemaVersion: 1;
    mode: 'online';
    model: typeof ONLINE_MODEL;
    taskset: 'controlled-v1';
    split: 'development' | 'evaluation';
    repetitions: number;
    maxCalls: number;
    globalTokenBudget: number;
    turnTimeoutMs: number;
    config: Partial<Config>;
}
export interface OnlineTrial {
    id: string;
    task: string;
    family: string;
    repetition: number;
    strategy: Strategy;
    success: boolean;
    failure: string | null;
    answer: string;
    windows: number;
    calls: number;
    summaryCalls: number;
    toolCalls: number;
    actualInputTokens: number | null;
    actualOutputTokens: number | null;
    chargedTokens: number;
    unknownUsageCalls: number;
    elapsedMs: number;
    trace: string;
}
export interface OnlineReport {
    schemaVersion: 1;
    mode: 'online';
    status: 'running' | 'completed';
    model: string;
    thinking: 'disabled';
    temperature: 0;
    implementationHash: string;
    configHash: string;
    tasksetHash: string;
    plannedTrials: number;
    config: OnlineConfig;
    trials: OnlineTrial[];
    inference: string;
}
export declare function validateOnlineConfig(value: unknown): OnlineConfig;
export declare function runOnline(value: unknown, apiKey: string, out: string): Promise<OnlineReport>;
export declare function pairedSummary(report: OnlineReport): {
    pairs: number;
    summaryWins: number;
    resetWins: number;
    ties: number;
    difference: number;
    bootstrap95: [number, number];
};
export declare function renderOnlineReport(report: OnlineReport): string;
