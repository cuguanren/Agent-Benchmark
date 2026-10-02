import type { Config, Model, ModelRequest, Strategy } from './types.js';
export interface Scenario {
    id: string;
    key: string;
    constraint: string;
    saveNote: boolean;
    noiseBytes: number;
}
export interface RunConfig {
    schemaVersion: 1;
    mode: 'conformance';
    config: Partial<Config>;
    scenarios: Scenario[];
}
export interface Check {
    name: string;
    passed: boolean;
}
export interface Trial {
    scenario: string;
    strategy: Strategy;
    passed: boolean;
    checks: Check[];
    failure: string | null;
    windows: number;
    calls: number;
    summaryCalls: number;
    toolCalls: number;
    chargedTokens: number;
    measurement: 'estimated' | 'actual' | 'mixed';
    actualInputTokens: number | null;
    actualOutputTokens: number | null;
    trace: string;
}
export interface Report {
    schemaVersion: 1;
    mode: 'conformance';
    implementation: '0.1.0';
    fixture: 'scripted-protocol-v1';
    limitation: string;
    configHash: string;
    scenarioHash: string;
    config: Config;
    trials: Trial[];
    passed: boolean;
}
/** Reads only model-visible messages. This fixture is a protocol probe, not a task solver. */
export declare class ScriptedModel implements Model {
    generate(request: ModelRequest): Promise<{
        text: string;
    }>;
}
export declare function validateRunConfig(value: unknown): RunConfig;
export declare function runConformance(input: unknown, out: string): Promise<Report>;
