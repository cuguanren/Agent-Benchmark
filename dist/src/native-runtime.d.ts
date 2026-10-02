import { Context } from '@deepseek-ai/cordis';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import NativeContextStrategy from './native.js';
import type { NativeConfig } from './native.js';
export declare function createNativeRuntime(options: NativeConfig & {
    adapter: LlmAdapter;
    root?: string;
    persona?: string;
}): Promise<{
    ctx: Context;
    strategy: NativeContextStrategy;
    dispose: () => Promise<void>;
}>;
