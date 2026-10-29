import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const flag = process.argv.indexOf('--tsc');
let compiler = flag >= 0 ? process.argv[flag + 1] : process.env.FOOTPRINT_ML_TSC;
if (!compiler) {
  try { compiler = require.resolve('typescript/bin/tsc'); }
  catch { throw new Error('Install the development TypeScript dependency, or pass --tsc /path/to/typescript/bin/tsc.'); }
}
const result = spawnSync(process.execPath, [resolve(compiler), '-p', fileURLToPath(new URL('./tsconfig.json', import.meta.url))],
  { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
