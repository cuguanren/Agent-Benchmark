import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'runs/release'); fs.mkdirSync(out, { recursive: true });
const packageReport = JSON.parse(fs.readFileSync(path.join(out, 'package-report.json')));
const tarball = path.join(out, packageReport.file);
assert.equal(createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), packageReport.sha256);
const cli = path.join(root, 'runs/release-tools/node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.ok(fs.existsSync(cli), 'Install @deepseek-ai/dsh@0.1.0-rc.8 under runs/release-tools first');
const hmr = JSON.parse(fs.readFileSync(path.join(root, 'runs/release-tools/node_modules/@deepseek-ai/cordis-plugin-hmr/package.json')));
assert.equal(hmr.version, '1.0.16', 'dsh rc.8 needs HMR 1.0.16 registerConfig; newer published HMR versions are incompatible');
const home = fs.mkdtempSync(path.join(out, 'profile-home-'));
const outside = path.join(home, 'outside working directory'); fs.mkdirSync(outside);
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', BENCHMARK_PROFILE_REPORT: path.join(home, 'boot-report.json') };
// This deterministic smoke test must never inherit paid-model credentials.
for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|SECRET/i.test(key)) delete env[key];
async function run(args, label) {
  const log = fs.createWriteStream(path.join(home, `${label}.log`)); let output = '';
  const child = spawn(process.execPath, [cli, ...args], { cwd: outside, env, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; log.write(chunk); });
  const timeout = setTimeout(() => child.kill(), 300000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout); log.end(); assert.equal(code, 0, `${label}: ${output.slice(-6000)}`); return output;
}
const profile = 'benchmark-release';
await run(['plugin', '--profile', profile, 'add', tarball], 'install');
const dir = path.join(home, 'profiles', profile);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
assert.ok(manifest.dsh.profile.bundles.includes('dsh-agent-benchmark'));
const config = await run(['--profile', profile, '--dump-config'], 'config');
assert.ok(!config.includes('patch: '), 'Composed bundle must not have skipped patch rows');
assert.match(config, /dsh-agent-benchmark\/persistence/); assert.match(config, /name: dsh-agent-benchmark/);
for (const id of ['session-persistence-jsonl', 'compaction-basic', 'tool-result-pruner']) assert.match(config, new RegExp(`id: ${id}\\n(?:(?!- id:)[\\s\\S])*?disabled: true`));
fs.copyFileSync(path.join(root, 'tests/fixtures/profile-consumer.mjs'), path.join(dir, 'consumer.mjs'));
const overlay = path.join(home, 'smoke.patch.yml');
const boots = [];
for (const strategy of ['window-reset', 'local-summary']) {
env.BENCHMARK_PROFILE_STRATEGY = strategy; env.BENCHMARK_PROFILE_REPORT = path.join(home, `boot-${strategy}.json`);
fs.writeFileSync(overlay, `- id: agent-benchmark
  config:
    strategy: ${strategy}
    capacityTokens: 65536
    triggerTokens: 50000
    outputReserveTokens: 128
    totalTokenBudget: 100000
- id: session-title-llm
  disabled: true
- insert:
    - id: release-fixture
      name: ./consumer.mjs
`);
await run(['--profile', profile, '--patch', overlay], `boot-${strategy}`);
const boot = JSON.parse(fs.readFileSync(env.BENCHMARK_PROFILE_REPORT)); assert.equal(boot.status, 'passed');
boots.push(boot);
}
await run(['plugin', '--profile', profile, 'remove', 'dsh-agent-benchmark'], 'remove');
const removed = await run(['--profile', profile, '--dump-config'], 'removed-config');
assert.ok(!removed.includes('name: dsh-agent-benchmark')); assert.match(removed, /name: ['"]?@deepseek-ai\/dsh-compaction-basic/);
assert.ok(!removed.includes('patch: '));
for (const id of ['session-persistence-jsonl', 'compaction-basic', 'tool-result-pruner']) {
  const row = removed.match(new RegExp(`- id: ${id}\\n(?:(?!- id:)[\\s\\S])*`))?.[0];
  assert.ok(row && !row.includes('disabled: true'), `Base ${id} must be restored after remove`);
}
const report = { status: 'passed', version: packageReport.version, sha256: packageReport.sha256, dsh: '0.1.0-rc.8', hmr: hmr.version, node: process.version, platform: process.platform,
  home, checks: ['CLI plugin add', 'bundle activation', 'base overrides', 'real profile boot', 'automatic attachment', 'both strategies', 'JSONL resume', 'CLI plugin remove'], boots, checkedAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, 'profile-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
