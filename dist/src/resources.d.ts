/** Resolve resources against the installed package, never the caller's cwd. */
export declare const packageRoot: string;
export declare function resourcePath(...parts: string[]): string;
export declare function sourceFiles(includePython?: boolean): Record<string, string>;
export declare function implementationHash(): string;
export declare function saveSourceSnapshot(out: string, includePython?: boolean): void;
