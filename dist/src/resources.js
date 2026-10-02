import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './types.js';
/** Resolve resources against the installed package, never the caller's cwd. */
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export function resourcePath(...parts) { return join(packageRoot, ...parts); }
export function sourceFiles(includePython = false) {
    const root = resourcePath('src');
    return Object.fromEntries(fs.readdirSync(root).filter(name => name.endsWith('.ts') || (includePython && name.endsWith('.py'))).sort()
        .map(name => [name, fs.readFileSync(join(root, name), 'utf8')]));
}
export function implementationHash() { return hash(Object.entries(sourceFiles())); }
export function saveSourceSnapshot(out, includePython = false) {
    fs.mkdirSync(out, { recursive: true });
    for (const [name, content] of Object.entries(sourceFiles(includePython)))
        fs.writeFileSync(join(out, name), content);
    for (const name of ['package.json', 'package-lock.json']) {
        const file = resourcePath(name);
        if (fs.existsSync(file))
            fs.copyFileSync(file, join(out, name));
    }
    // npm omits package-lock; the packed provenance carries the exact build-time dependency lock.
    const buildLock = resourcePath('provenance/package-lock.json');
    if (!fs.existsSync(join(out, 'package-lock.json')) && fs.existsSync(buildLock))
        fs.copyFileSync(buildLock, join(out, 'package-lock.json'));
    fs.writeFileSync(join(out, 'runtime.json'), JSON.stringify({ node: process.version, platform: process.platform, timestamp: new Date().toISOString() }));
}
