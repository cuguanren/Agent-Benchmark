import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gradePaw, PAW_TASK, python, workspacePath } from '../src/external.js';

test('original PawBench grader body is unchanged and rejects a missing submission', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pawbench-negative-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const document = fs.readFileSync(join('third_party/pawbench', PAW_TASK, 'task.md'), 'utf8');
  const body = document.split('## Automated Checks')[1]!.match(/```python\n([\s\S]*?)```/)![1];
  assert.equal(fs.readFileSync(join('third_party/pawbench', PAW_TASK, 'grader.py'), 'utf8'), body);
  fs.cpSync(join('third_party/pawbench', PAW_TASK, 'fixtures'), join(root, 'fixtures'), { recursive: true });
  const score = await gradePaw(root); assert.ok(Object.values(score).every(n => n === 0));
});
test('independent test encoder proves original grader accepts a correctly decoded size-limited artifact', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pawbench-positive-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(join('third_party/pawbench', PAW_TASK, 'fixtures'), join(root, 'fixtures'), { recursive: true }); fs.mkdirSync(join(root, 'output'));
  // This test oracle is never registered as an Agent tool or copied into a trial workspace.
  const code = `import runpy,sys\nfrom pathlib import Path\nr=Path(sys.argv[1])\nd=runpy.run_path(str(r/'fixtures/decoder.py'))\ntext=(r/'fixtures/target.txt').read_bytes()\nlookup={value[0]:''.join(map(str,key)) for key,value in d['_T'].items()}\nbits='';i=0\nwhile i<len(text):\n c=text[i];j=i+1\n while j<len(text) and text[j]==c and j-i<17:j+=1\n sym=lookup.get(c,'111111'+format(c,'08b'));n=j-i\n if n>=3 or (n==2 and len(sym)>=4):bits+='1'+format(n-2,'04b')+sym;i=j\n else:bits+='0'+sym;i+=1\nbits+='0'*((-len(bits))%8)\nraw=bytes(int(bits[i:i+8],2) for i in range(0,len(bits),8))\ninter=b''.join(raw[i:i+16][::2]+raw[i:i+16][1::2] for i in range(0,len(raw),16))\nseed=37;n=len(text)\nencoded=bytes([n>>8,0,n&255,seed])+d['_x'](inter,seed)\n(r/'output/encoded.dat').write_bytes(encoded)\n(r/'output/encoder_writeup.md').write_text('Test oracle: inverse prefix/RLE coding, interleave, XOR and header.',encoding='utf8')\n`;
  const result = await python(['-c', code, root], root); assert.equal(result.exitCode, 0, result.stderr);
  const score = await gradePaw(root);
  for (const key of ['output_file_exists', 'exact_match', 'char_match_ratio', 'size_within_60pct', 'size_within_75pct', 'writeup_exists']) assert.equal(score[key], 1, key);
});
test('workspace path and limited Python reject fixture changes, traversal and host capabilities', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pawbench-boundary-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'fixtures')); fs.mkdirSync(join(root, 'output')); fs.writeFileSync(join(root, 'fixtures/ref.txt'), 'unchanged');
  assert.throws(() => workspacePath(root, '../outside')); assert.throws(() => workspacePath(root, 'fixtures/ref.txt', true));
  const scripts = ['import os\nprint(os.environ)', 'from sys import modules\nprint(modules)', 'open("fixtures/ref.txt","w").write("tamper")', 'open("../outside","w").write("tamper")'];
  for (const source of scripts) {
    fs.writeFileSync(join(root, 'script.py'), source); const result = await python([resolve('src/python_workspace.py')], root, JSON.stringify({ root, script: 'script.py' })); assert.notEqual(result.exitCode, 0);
  }
  fs.writeFileSync(join(root, 'script.py'), 'import struct\nopen("output/value.bin","wb").write(struct.pack("<I",42))\nprint("ok")');
  const result = await python([resolve('src/python_workspace.py')], root, JSON.stringify({ root, script: 'script.py' })); assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.readFileSync(join(root, 'fixtures/ref.txt'), 'utf8'), 'unchanged'); assert.equal(fs.readFileSync(join(root, 'output/value.bin')).readUInt32LE(), 42);
});
