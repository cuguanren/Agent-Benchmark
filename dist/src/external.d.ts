export declare const PAW_TASK = "T037_claweval_T100_reverse_decoder";
export declare function workspacePath(root: string, name: string, write?: boolean): string;
export declare function python(args: string[], cwd: string, stdin?: string, timeoutMs?: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export declare function gradePaw(root: string): Promise<Record<string, number>>;
export declare function runExternal(apiKey: string, out: string): Promise<{
    trials: {
        strategy: "local-summary" | "window-reset";
        success: boolean;
        failure: string | null;
        scores: Record<string, number>;
        calls: number;
        summaryCalls: number;
        windows: number | undefined;
        inputTokens: number | null;
        outputTokens: number | null;
        elapsedMs: number;
        workspace: string;
        trace: string | undefined;
    }[];
    success: boolean;
}>;
