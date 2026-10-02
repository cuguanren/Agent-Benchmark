export interface ControlledTask {
    id: string;
    family: string;
    split: 'development' | 'evaluation';
    material: string;
    preparation: string;
    question: string;
    expected: string;
    format: 'text' | 'json';
}
export declare function controlledTasks(): ControlledTask[];
export declare function verifyAnswer(task: ControlledTask, output: string): boolean;
