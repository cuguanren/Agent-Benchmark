import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'runs/release'); fs.mkdirSync(out, { recursive: true });
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith('npm-cli.js'), 'Run with npm run verify:git');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|SECRET/i.test(key)) delete env[key];
const run = (binary, args, cwd) => {
  const result = spawnSync(binary, args, { cwd, env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stderr || result.stdout || String(result.error)).slice(-6000)); return result.stdout.trim();
};
const commit = process.env.BENCHMARK_GIT_REF ?? run('git', ['rev-parse', 'HEAD'], root);
assert.match(commit, /^[0-9a-f]{40}$/);
const spec = `git+https://github.com/cuguanren/Agent-Benchmark.git#${commit}`;
const temporary = fs.mkdtempSync(path.join(out, 'git-install-'));
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund', spec], temporary);
  const pkg = path.join(temporary, 'node_modules/dsh-agent-benchmark');
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))); assert.equal(manifest.name, 'dsh-agent-benchmark');
  const provenance = JSON.parse(fs.readFileSync(path.join(pkg, 'provenance/build.json'))); assert.equal(provenance.version, manifest.version);
  const outside = path.join(temporary, 'outside working directory'); fs.mkdirSync(outside);
  run(process.execPath, [path.join(pkg, 'dist/src/cli.js'), 'run', path.join(pkg, 'examples/conformance.json'), '--out', path.join(outside, 'demo')], outside);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outside, 'demo/report.json'))).passed, true);
  fs.copyFileSync(path.join(root, 'tests/fixtures/package-consumer.mjs'), path.join(temporary, 'consumer.mjs'));
  const consumer = JSON.parse(run(process.execPath, [path.join(temporary, 'consumer.mjs')], outside));
  const lock = JSON.parse(fs.readFileSync(path.join(temporary, 'package-lock.json')));
  assert.ok(lock.packages['node_modules/dsh-agent-benchmark'].resolved.endsWith(`#${commit}`));
  const report = { status: 'passed', spec, commit, version: manifest.version, node: process.version, platform: process.platform,
    checks: ['remote commit-pinned Git install', 'prepare provenance', 'CLI outside checkout', 'public exports', 'original grader', 'Python resource'], consumer, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'git-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  const resolved = fs.realpathSync(temporary); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(out).toLowerCase()); fs.rmSync(resolved, { recursive: true, force: true });
}
