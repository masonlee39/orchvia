/**
 * SPEC-0046 S02: runs a test command in several copies at once while every core is kept busy,
 * as on a loaded CI runner, and reports which tests failed in which copy. A test that depends on
 * time and passes only on an idle machine fails here before it fails a pull request.
 *
 * Usage: node scripts/stress.mjs [--copies 3] [--burners <cores>] [--summary FILE] [--logs DIR]
 *        [-- command ...]
 * The command defaults to `npm test`. Each copy runs at `nice -n 10`, below the busy loops. The
 * run exits 1 when any copy fails and 2 when the arguments are invalid.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const options = split === -1 ? argv : argv.slice(0, split);
const command = split === -1 ? ['npm', 'test'] : argv.slice(split + 1);
const option = (name, fallback) => {
  const at = options.indexOf(`--${name}`);
  return at === -1 ? fallback : options[at + 1];
};
const count = (name, fallback, max) => {
  const value = option(name, String(fallback));
  if (!/^\d+$/.test(value) || Number(value) > max) {
    console.error(`--${name} must be a whole number up to ${max}, not ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return Number(value);
};
const copies = count('copies', 3, 6);
if (copies < 1) {
  console.error('--copies must be at least 1');
  process.exit(2);
}
if (!command.length) {
  console.error('No command after --');
  process.exit(2);
}
const burners = count('burners', availableParallelism(), 256);
const summaryFile = option('summary', undefined);
const logs = option('logs', 'dist/stress');
mkdirSync(logs, { recursive: true });

// One busy loop per core, below which the copies run.
const busy = Array.from({ length: burners }, () =>
  spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }),
);
const stopBusy = () => {
  for (const child of busy) child.kill('SIGKILL');
};
process.on('exit', stopBusy);

const nice = process.platform === 'win32' ? [] : ['nice', '-n', '10'];
const started = performance.now();
const results = await Promise.all(
  Array.from({ length: copies }, (_, index) => {
    const [program, ...args] = [...nice, ...command];
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    return new Promise((resolve) =>
      child.on('close', (code, signal) => {
        writeFileSync(join(logs, `copy-${index + 1}.log`), output);
        // node:test marks a failed test with ✖, Python's unittest with FAIL: or ERROR:.
        const failed = new Set();
        for (const line of output.split('\n')) {
          const node = /^\s*✖ (.+?) \(\d[\d.]*m?s\)$/.exec(line);
          const python = /^(?:FAIL|ERROR): (\S+)/.exec(line);
          if (node) failed.add(node[1]);
          else if (python) failed.add(python[1]);
        }
        resolve({ copy: index + 1, ok: code === 0, code, signal, failed: [...failed] });
      }),
    );
  }),
);
stopBusy();

const minutes = ((performance.now() - started) / 60000).toFixed(1);
const lines = [
  `## Under load: ${burners} busy loops, ${copies} copies, ${minutes} min`,
  '',
  `\`${command.join(' ')}\``,
  '',
  '| Copy | Result | Failed tests |',
  '| --- | --- | --- |',
  ...results.map(
    (result) =>
      `| ${result.copy} | ${result.ok ? 'passed' : 'failed'} | ${
        result.failed.map((name) => name.replaceAll('|', '\\|')).join('<br>') ||
        (result.ok ? '' : `exit ${result.code ?? result.signal}`)
      } |`,
  ),
  '',
];
const text = lines.join('\n');
console.log(text);
if (summaryFile) appendFileSync(summaryFile, text + '\n');
process.exit(results.every((result) => result.ok) ? 0 : 1);
