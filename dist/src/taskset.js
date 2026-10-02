import { hash } from './types.js';
export function controlledTasks() {
    const families = ['recall', 'multihop', 'correction', 'constraints', 'sequence', 'delayed-query'];
    return families.flatMap(family => Array.from({ length: 6 }, (_, seed) => {
        const id = `${family}-${seed}`;
        const token = (n) => hash({ family, seed, n }).slice(0, 20);
        let facts;
        let question;
        let expected;
        let format = 'text';
        switch (family) {
            case 'multihop':
                facts = `alias-${seed} refers to route-${seed + 10}. route-${seed + 10} has identifier ${token(1)}.`;
                expected = token(1);
                question = `Return only the identifier reached from alias-${seed}.`;
                break;
            case 'correction':
                facts = `At revision 1 the active identifier was ${token(0)}. At revision 2 it was replaced by ${token(1)}; revision 2 supersedes revision 1.`;
                expected = token(1);
                question = 'Return only the latest active identifier.';
                break;
            case 'constraints':
                facts = `The approved identifier is ${token(1)}.`;
                expected = token(1);
                format = 'json';
                question = 'Return the approved identifier using the output format specified in the earlier user instruction.';
                break;
            case 'sequence':
                expected = [token(1), token(2), token(3), token(4), token(5)].join(',');
                facts = `Ordered identifiers: ${expected}. Preserve this order.`;
                question = 'Return only all five ordered identifiers, separated by commas, with no spaces.';
                break;
            case 'delayed-query':
                facts = Array.from({ length: 32 }, (_, i) => `slot-${i}: ${token(i)}`).join('\n');
                expected = token((seed * 7 + 3) % 32);
                question = `Return only the identifier for slot-${(seed * 7 + 3) % 32}.`;
                break;
            default:
                facts = `The approved identifier is ${token(1)}.`;
                expected = token(1);
                question = 'Return only the approved identifier.';
        }
        const noise = Array.from({ length: 80 }, (_, i) => `Unrelated status row ${i}: inventory counters updated; no identifier changes.`).join('\n');
        return { id, family, split: seed < 2 ? 'development' : 'evaluation', material: `${noise}\nOBSERVED FACTS\n${facts}\nEND FACTS\n${noise}`,
            preparation: 'Read the task evidence through observe. Preserve enough information for a question after a context transition. You do not yet know that question. Respond READY when prepared.'
                + (format === 'json' ? ' Important user constraint: all later final answers must be JSON with exactly one field named answer and no prose or code fences.' : ''),
            question, expected, format };
    }));
}
export function verifyAnswer(task, output) {
    if (task.format === 'text')
        return output.trim() === task.expected;
    try {
        const data = JSON.parse(output);
        return data && Object.keys(data).length === 1 && data.answer === task.expected;
    }
    catch {
        return false;
    }
}
