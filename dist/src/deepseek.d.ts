import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek';
export declare const ONLINE_MODEL = "deepseek-flash";
export declare function officialAdapter(apiKey: string): DeepSeekAdapter;
/** Raw TTY input suppresses credential echo; the value remains only in memory. */
export declare function readApiKey(fromStdin: boolean): Promise<string>;
