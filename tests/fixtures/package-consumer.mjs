import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as plugin from 'dsh-agent-benchmark';
import Strategy from 'dsh-agent-benchmark/native';
import { resourcePath, sourceFiles, saveSourceSnapshot } from 'dsh-agent-benchmark/resources';
import { gradePaw, python, PAW_TASK } from 'dsh-agent-benchmark/external';

assert.equal(plugin.name, 'agent-benchmark'); assert.equal(typeof plugin.apply, 'function'); assert.equal(typeof Strategy, 'function');
assert.equal(plugin.Config({}).strategy, 'local-summary');
const snapshot = path.resolve('snapshot'); saveSourceSnapshot(snapshot, true);
assert.ok(fs.existsSync(path.join(snapshot, 'package-lock.json'))); assert.ok(sourceFiles()['native.ts']);
const workspace = path.resolve('external-workspace'); fs.mkdirSync(workspace);
fs.cpSync(resourcePath('third_party/pawbench', PAW_TASK, 'fixtures'), path.join(workspace, 'fixtures'), { recursive: true }); fs.mkdirSync(path.join(workspace, 'output'));
assert.ok(Object.values(await gradePaw(workspace)).every(score => score === 0));
fs.writeFileSync(path.join(workspace, 'script.py'), 'import struct\nopen("output/test.bin","wb").write(struct.pack("<I",42))\n');
const result = await python([resourcePath('src/python_workspace.py')], workspace, JSON.stringify({ root: workspace, script: 'script.py' }));
assert.equal(result.exitCode, 0, result.stderr); assert.equal(fs.readFileSync(path.join(workspace, 'output/test.bin')).readUInt32LE(), 42);
console.log(JSON.stringify({ exports: true, snapshotLock: true, originalGrader: true, python: true }));
