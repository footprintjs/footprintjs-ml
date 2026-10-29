import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detached, isRecord, jsonObject } from '../contracts.js';
import type { JsonObject, JsonValue } from '../contracts.js';

export interface AdapterConformanceOptions {
  readonly pluginPath: string;
  readonly config: JsonObject;
  readonly plan: JsonObject;
  readonly out: string;
  readonly python?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Optional explicit runner for deployment layouts or protocol testing. */
  readonly runnerPath?: string;
}
export interface AdapterConformanceCase {
  readonly name: string;
  readonly passed: boolean | null;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly required: boolean;
  readonly category: 'structural' | 'numerical';
  readonly details: JsonObject;
}
export interface AdapterConformanceReport {
  readonly schema: 'footprint-ml-adapter-conformance/v1';
  readonly passed: boolean;
  readonly structuralPassed: boolean;
  readonly numericalPassed: boolean;
  readonly requiredPassed: boolean;
  readonly status: 'passed' | 'partial' | 'failed';
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly cases: readonly AdapterConformanceCase[];
  readonly backend: JsonObject;
  readonly plan: JsonObject;
  readonly observations: JsonObject;
  readonly artifacts: JsonObject;
  readonly coverage: JsonObject;
  readonly limitations: readonly string[];
}
export type ConformanceErrorCode = 'invalid-options' | 'spawn-failed' | 'timeout' |
  'output-limit' | 'invalid-report' | 'unexpected-exit';

export class ConformanceError extends Error {
  readonly code: ConformanceErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(code: ConformanceErrorCode, message: string,
    context: { stderr?: string; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'ConformanceError'; this.code = code;
    this.stderr = context.stderr ?? ''; this.exitCode = context.exitCode ?? null;
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new ConformanceError('invalid-options', `${label} must be a nonempty string without NUL bytes`);
  return value;
}
function integer(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new ConformanceError('invalid-options', `${label} must be an integer in [1, ${maximum}]`);
  return value;
}
function invalid(message: string): never { throw new Error(message); }

/** Validate semantic counts, so a contradictory report cannot appear to pass. */
function readReport(input: unknown): AdapterConformanceReport {
  const report = jsonObject(input, 'conformance report');
  if (report.schema !== 'footprint-ml-adapter-conformance/v1') invalid('Unsupported conformance report schema');
  for (const key of ['passed', 'structuralPassed', 'numericalPassed', 'requiredPassed'])
    if (typeof report[key] !== 'boolean') invalid(`Report ${key} must be boolean`);
  if (!Array.isArray(report.cases) || !report.cases.length) invalid('Report must contain executed or explicitly skipped cases');
  const cases = report.cases.map((value, index) => {
    if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.required !== 'boolean' ||
      (value.category !== 'structural' && value.category !== 'numerical') || !isRecord(value.details))
      invalid(`Malformed conformance case ${index}`);
    if (!((value.status === 'passed' && value.passed === true) ||
          (value.status === 'failed' && value.passed === false) ||
          (value.status === 'skipped' && value.passed === null))) invalid(`Contradictory conformance case ${index}`);
    return value as unknown as AdapterConformanceCase;
  });
  if (!isRecord(report.counts)) invalid('Report counts must be an object');
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const item of cases) counts[item.status]++;
  for (const key of ['passed', 'failed', 'skipped'] as const)
    if (report.counts[key] !== counts[key]) invalid(`Report ${key} count disagrees with its cases`);
  const expectedStatus = counts.failed ? 'failed' : counts.skipped ? 'partial' : 'passed';
  if (report.status !== expectedStatus || report.passed !== cases.every(item => item.passed === true) ||
      report.requiredPassed !== cases.filter(item => item.required).every(item => item.passed === true))
    invalid('Report status disagrees with its cases');
  for (const [category, field] of [['structural', 'structuralPassed'], ['numerical', 'numericalPassed']] as const) {
    const selected = cases.filter(item => item.category === category);
    if (report[field] !== (selected.length > 0 && selected.every(item => item.passed === true)))
      invalid(`Report ${field} disagrees with its cases`);
  }
  for (const key of ['backend', 'plan', 'observations', 'artifacts', 'coverage'])
    if (!isRecord(report[key])) invalid(`Report ${key} must be an object`);
  if (!Array.isArray(report.limitations) || report.limitations.some(value => typeof value !== 'string'))
    invalid('Report limitations must be strings');
  return detached(report) as unknown as AdapterConformanceReport;
}

/** Spawn only when called. Valid failed/partial reports remain reviewable results. */
export async function runAdapterConformance(options: AdapterConformanceOptions): Promise<AdapterConformanceReport> {
  let pluginPath: string, out: string, python: string, runnerPath: string, config: JsonObject, plan: JsonObject;
  let timeoutMs: number, maxOutputBytes: number;
  try {
    pluginPath = resolve(text(options.pluginPath, 'pluginPath'));
    out = resolve(text(options.out, 'out'));
    python = text(options.python ?? 'python3', 'python');
    runnerPath = options.runnerPath === undefined
      ? fileURLToPath(new URL('../../python/conformance.py', import.meta.url))
      : resolve(text(options.runnerPath, 'runnerPath'));
    config = detached(jsonObject(options.config, 'config'));
    plan = detached(jsonObject(options.plan, 'plan'));
    timeoutMs = integer(options.timeoutMs ?? 120_000, 'timeoutMs', 2_147_483_647);
    maxOutputBytes = integer(options.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes', 64 * 1024 * 1024);
    await access(runnerPath, constants.R_OK);
  } catch (error) {
    if (error instanceof ConformanceError) throw error;
    throw new ConformanceError('invalid-options', error instanceof Error ? error.message : String(error));
  }
  const args = [runnerPath, '--plugin', pluginPath, '--config', JSON.stringify(config),
    '--plan', JSON.stringify(plan), '--out', out];
  return new Promise<AdapterConformanceReport>((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(python, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      reject(new ConformanceError('spawn-failed', error instanceof Error ? error.message : String(error))); return;
    }
    let settled = false, stdoutBytes = 0;
    const chunks: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    const fail = (error: ConformanceError, terminate = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (terminate) child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(new ConformanceError('timeout', `Conformance exceeded ${timeoutMs} ms`,
      { stderr: stderr.toString('utf8') }), true), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      const data = Buffer.from(chunk); stdoutBytes += data.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(new ConformanceError('output-limit', `Conformance stdout exceeded ${maxOutputBytes} bytes`,
          { stderr: stderr.toString('utf8') }), true); return;
      }
      chunks.push(data);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (!settled) stderr = Buffer.concat([stderr, chunk]).subarray(-Math.min(maxOutputBytes, 65_536));
    });
    child.once('error', error => fail(new ConformanceError('spawn-failed', error.message, { stderr: stderr.toString('utf8') })));
    child.once('close', (code, signal) => {
      if (settled) return;
      const context = { exitCode: code, stderr: stderr.toString('utf8') };
      if (signal !== null || (code !== 0 && code !== 1)) {
        fail(new ConformanceError('unexpected-exit', `Conformance exited with ${signal ?? code}`, context)); return;
      }
      let report: AdapterConformanceReport;
      try { report = readReport(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) {
        fail(new ConformanceError('invalid-report', error instanceof Error ? error.message : String(error), context)); return;
      }
      if (code === 1 && report.passed) {
        fail(new ConformanceError('unexpected-exit', 'Conformance returned a passing report but exited with failure', context)); return;
      }
      settled = true; clearTimeout(timer); resolveResult(report);
    });
  });
}
