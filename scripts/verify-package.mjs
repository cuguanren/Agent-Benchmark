import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'runs/release'); fs.mkdirSync(out, { recursive: true });
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith('npm-cli.js'), 'Run this verifier with npm run verify:package');
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (/API_KEY|ACCESS_TOKEN|SECRET/i.test(key)) delete environment[key];
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stderr || result.stdout || String(result.error)).slice(-5000)); return result.stdout;
};
const pack = JSON.parse(run([npmCli, 'pack', '--json', '--pack-destination', out]))[0];
const files = pack.files.map(f => f.path);
for (const file of ['LICENSE', 'cordis.patch.yml', 'dist/src/index.js', 'dist/src/index.d.ts', 'dist/src/native.js', 'src/python_workspace.py', 'provenance/package-lock.json', 'third_party/pawbench/NOTICE']) assert.ok(files.includes(file), `Missing ${file}`);
assert.ok(!files.some(f => /^(tests|dist\/tests|runs|node_modules)\//.test(f) || f === 'lock-screen-test.md' || /\.env/.test(f)));
const temporary = fs.mkdtempSync(path.join(out, 'package-install-'));
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([npmCli, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(out, pack.filename)], temporary);
  const pkg = path.join(temporary, 'node_modules/dsh-agent-benchmark'); const outside = path.join(temporary, 'outside working directory'); fs.mkdirSync(outside);
  assert.ok(fs.existsSync(path.join(temporary, 'node_modules/.bin', process.platform === 'win32' ? 'agent-benchmark.cmd' : 'agent-benchmark')));
  run([path.join(pkg, 'dist/src/cli.js'), 'run', path.join(pkg, 'examples/conformance.json'), '--out', path.join(outside, 'demo')], outside);
  const report = JSON.parse(fs.readFileSync(path.join(outside, 'demo/report.json'))); assert.equal(report.passed, true); assert.equal(report.trials.length, 4);
  const consumer = fs.readFileSync(path.join(root, 'tests/fixtures/package-consumer.mjs'), 'utf8'); fs.writeFileSync(path.join(temporary, 'consumer.mjs'), consumer);
  const consumerReport = JSON.parse(run([path.join(temporary, 'consumer.mjs')], outside));
  const clean = path.join(temporary, 'source checkout'); fs.mkdirSync(clean);
  for (const name of ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) fs.cpSync(path.join(root, name), path.join(clean, name), { recursive: true });
  fs.mkdirSync(path.join(clean, 'scripts')); fs.copyFileSync(path.join(root, 'scripts/build.mjs'), path.join(clean, 'scripts/build.mjs'));
  assert.ok(!fs.existsSync(path.join(clean, 'dist')));
  run([npmCli, 'ci', '--no-audit', '--no-fund'], clean);
  assert.ok(fs.existsSync(path.join(clean, 'dist/src/index.js'))); assert.ok(fs.existsSync(path.join(clean, 'dist/src/index.d.ts')));
  assert.ok(fs.existsSync(path.join(clean, 'provenance/package-lock.json')));
  const digest = createHash('sha256').update(fs.readFileSync(path.join(out, pack.filename))).digest('hex');
  fs.writeFileSync(path.join(out, 'package-report.json'), JSON.stringify({ status: 'passed', version: pack.version, file: pack.filename, sha256: digest,
    packageFiles: files.length, unpackedSize: pack.unpackedSize, checks: ['whitelist', 'MIT', 'public exports', 'cold tarball install', 'CLI outside project', 'source provenance', 'clean source prepare build', 'original external grader', 'limited Python resource'], consumer: consumerReport, checkedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ status: 'passed', package: path.join(out, pack.filename), sha256: digest, files: files.length }));
} finally {
  const resolved = fs.realpathSync(temporary); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(out).toLowerCase());
  fs.rmSync(resolved, { recursive: true, force: true });
}
