import { startLock } from '../../packages/adapter-codex/src/local.ts';

// Takes the start lock of HOME within MS milliseconds, in a process of its own: a lock that cannot
// be taken must end this process's wait, and a test must be able to end the process when it does
// not (SPEC-0060 L01).
const [home, timeoutMs] = process.argv.slice(2);
const started = performance.now();
let outcome: string;
try {
  const release = await startLock(home!, Number(timeoutMs));
  release();
  outcome = 'acquired';
} catch (error) {
  outcome = error instanceof Error ? error.message : String(error);
}
process.stdout.write(
  JSON.stringify({ outcome, ms: Math.round(performance.now() - started) }) + '\n',
);
