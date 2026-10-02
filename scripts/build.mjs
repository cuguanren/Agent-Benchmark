import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const out = join(root, 'provenance'); fs.mkdirSync(out, { recursive: true });
const lock = join(root, 'package-lock.json');
if (fs.existsSync(lock)) fs.copyFileSync(lock, join(out, 'package-lock.json'));
const files = fs.readdirSync(join(root, 'src')).filter(f => /\.(ts|py)$/.test(f)).sort();
const digest = value => createHash('sha256').update(value).digest('hex');
fs.writeFileSync(join(out, 'build.json'), JSON.stringify({ schemaVersion: 1, version: JSON.parse(fs.readFileSync(join(root, 'package.json'))).version,
  node: process.version, files: Object.fromEntries(files.map(f => [f, digest(fs.readFileSync(join(root, 'src', f)))])),
  dependencyLockHash: fs.existsSync(lock) ? digest(fs.readFileSync(lock)) : null }, null, 2) + '\n');
