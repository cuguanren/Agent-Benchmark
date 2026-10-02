#!/usr/bin/env node
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { runConformance } from './conformance.js';
import { BenchmarkError } from './types.js';
import { readApiKey } from './deepseek.js';
import { runOnline } from './online.js';
import { runExternal } from './external.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (![4, 5].includes(args.length) || !['run', 'online', 'external'].includes(args[0]!) || args[2] !== '--out' || (args[4] !== undefined && args[4] !== '--key-stdin')) throw new BenchmarkError('invalid_input', 'Usage: agent-benchmark <run|online|external> <config.json|pawbench> --out <empty-directory> [--key-stdin]');
  const out = resolve(args[3]!);
  if (args[0] === 'external') {
    if (args[1] !== 'pawbench') throw new BenchmarkError('invalid_input', 'Supported external subset: pawbench');
    const report = await runExternal(await readApiKey(args[4] === '--key-stdin'), out);
    console.log(JSON.stringify(report)); if (!report.success) process.exitCode = 1; return;
  }
  const input = JSON.parse(fs.readFileSync(resolve(args[1]!), 'utf8')) as unknown;
  if (args[0] === 'online') {
    const report = await runOnline(input, await readApiKey(args[4] === '--key-stdin'), out);
    console.log(JSON.stringify({ mode: report.mode, status: report.status, trials: report.trials.length, report: resolve(out, 'report.md') }));
    if (report.trials.some(t => t.failure)) process.exitCode = 1;
  } else {
    const report = await runConformance(input, out);
    console.log(JSON.stringify({ mode: report.mode, passed: report.passed, trials: report.trials.length, report: resolve(out, 'report.md') }));
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error instanceof BenchmarkError ? `${error.code}: ${error.message}` : 'invalid_input: Cannot read or execute configuration'); process.exitCode = 1; });
