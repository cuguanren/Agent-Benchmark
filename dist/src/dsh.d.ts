import { Context, Service } from '@deepseek-ai/cordis';
import type LlmService from '@deepseek-ai/dsh-llm';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import { Session } from './session.js';
import type { TransitionOptions } from './strategies.js';
import type { Model, ModelRequest, ModelResult, Usage } from './types.js';
export interface DshConfig {
    provider: string;
    model: string;
    temperature?: number;
}
/** dsh input/cache counts are disjoint; the benchmark input count includes cache. */
export declare function normalizeUsage(usage: TokenUsage): Usage;
export declare class DshModel implements Model {
    readonly llm: LlmService;
    readonly config: DshConfig;
    constructor(llm: LlmService, config: DshConfig);
    generate(request: ModelRequest): Promise<ModelResult>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        contextBenchmark: ContextBenchmarkService;
    }
}
/** P0 model-service bridge; this does not change the native dsh Agent loop. */
export declare class ContextBenchmarkService extends Service {
    static inject: string[];
    readonly model: DshModel;
    private readonly sessions;
    constructor(ctx: Context, config: DshConfig);
    create(options: Parameters<typeof Session.create>[0]): Session;
    transition(session: Session, options?: TransitionOptions): Promise<void>;
}
export default ContextBenchmarkService;
