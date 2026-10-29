#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsonObject } from '../contracts.js';
import { ConformanceError, runAdapterConformance } from './index.js';

const USAGE = 'footprint-ml-conformance --plugin FILE --config-file FILE --plan-file FILE --out DIR [--python EXECUTABLE] [--timeout-ms N]';

/** Separate CLI entry; importing this file does not invoke a Python process. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      process.stdout.write(USAGE + '\n'); return 0;
    }
    const allowed = new Set(['--plugin', '--config-file', '--plan-file', '--out', '--python', '--timeout-ms']);
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index], value = argv[index + 1];
      if (!allowed.has(flag) || flags.has(flag) || value === undefined || value.startsWith('--'))
        throw new ConformanceError('invalid-options', `Invalid, duplicate, or missing option: ${flag}. Usage: ${USAGE}`);
      flags.set(flag, value);
    }
    const required = (name: string) => {
      const value = flags.get(name);
      if (value === undefined || !value.trim()) throw new ConformanceError('invalid-options', `Missing ${name}. Usage: ${USAGE}`);
      return value;
    };
    const config = jsonObject(JSON.parse(await readFile(required('--config-file'), 'utf8')), 'config');
    const plan = jsonObject(JSON.parse(await readFile(required('--plan-file'), 'utf8')), 'plan');
    const report = await runAdapterConformance({ pluginPath: required('--plugin'), out: required('--out'), config, plan,
      ...(flags.has('--python') ? { python: flags.get('--python')! } : {}),
      ...(flags.has('--timeout-ms') ? { timeoutMs: Number(flags.get('--timeout-ms')) } : {}) });
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.requiredPassed && report.counts.failed === 0 ? 0 : 1;
  } catch (error) {
    const detail = error instanceof ConformanceError ? { code: error.code, message: error.message, stderr: error.stderr }
      : { code: 'invalid-options', message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(JSON.stringify({ ok: false, error: detail }) + '\n'); return 2;
  }
}

let invokedDirectly = false;
try { invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
catch { /* An importing process need not have an existing script path. */ }
if (invokedDirectly) process.exitCode = await main();
