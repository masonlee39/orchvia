import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as local from '../../packages/adapter-codex/src/local.ts';
import { startLock } from '../../packages/adapter-codex/src/local.ts';

// SPEC-0060 L: taking the Codex start lock ends within its time whatever lies at the lock's path.

const posix = process.platform !== 'win32';
const fixture = fileURLToPath(new URL('../fixtures/codex-start-lock.ts', import.meta.url));

/** A Codex home of this test alone, and the lock path 0.1.31 gave it. */
function home(t: any) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orch-lock-home-')));
  const lock = join(
    tmpdir(),
    `orchvia-codex-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.lock`,
  );
  t.after(() => {
    try {
      // Whatever a test left at the path: a file of any mode, a link, a FIFO or a directory.
      if (lstatSync(lock).isFile()) chmodSync(lock, 0o600);
    } catch {
      /* nothing there */
    }
    rmSync(lock, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, lock };
}
/** Takes the lock in a process of its own, which is ended when it has not answered in 30 seconds. */
const inChild = (directory: string, timeoutMs: number) =>
  new Promise<{ outcome: string; ms: number }>((resolve, reject) =>
    execFile(
      process.execPath,
      [fixture, directory, String(timeoutMs)],
      { timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new Error(`taking the lock did not end: ${error.message}`));
        else resolve(JSON.parse(stdout.trim().split('\n').at(-1)!));
      },
    ),
  );

test('AC-0060-L03 the lock is the file 0.1.31 used, holding its owner’s PID', async (t) => {
  const { directory, lock } = home(t);
  const release = await startLock(directory, 2000);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(lstatSync(lock).mode & 0o777, 0o600);
  // A second start in this process waits for the first.
  let second = false;
  const waiting = startLock(directory, 5000).then((releaseSecond) => {
    second = true;
    return releaseSecond;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second, false);
  release();
  (await waiting)();
  assert.equal(existsSync(lock), false, 'released');
  // A lock whose process is gone is taken over.
  writeFileSync(lock, '2147483646');
  (await startLock(directory, 2000))();
});

test(
  'AC-0060-L01 a lock file that cannot be read ends the wait at its time',
  { skip: !posix || process.getuid?.() === 0 },
  async (t) => {
    const { directory, lock } = home(t);
    writeFileSync(lock, 'unreadable');
    chmodSync(lock, 0o000);
    const result = await inChild(directory, 400);
    assert.match(result.outcome, /^CODEX_START_LOCK_TIMEOUT: /);
    assert.ok(result.outcome.includes(lock), `the failure names the lock: ${result.outcome}`);
    assert.ok(result.ms >= 350, `it waited its time: ${result.ms} ms`);
  },
);

test(
  'AC-0060-L01 another process’s lock ends the wait at its time, naming the file',
  { skip: !posix },
  async (t) => {
    const { directory, lock } = home(t);
    // Process 1 always runs, and is not this one.
    writeFileSync(lock, '1');
    await assert.rejects(startLock(directory, 300), (error: Error) => {
      assert.match(error.message, /^CODEX_START_LOCK_TIMEOUT: /);
      assert.ok(error.message.includes(lock), error.message);
      return true;
    });
    assert.equal(readFileSync(lock, 'utf8'), '1', 'a live owner’s lock is left alone');
  },
);

test(
  'AC-0060-L02 a FIFO at the lock’s path is refused at once and never read',
  { skip: !posix },
  async (t) => {
    const { directory, lock } = home(t);
    execFileSync('mkfifo', [lock]);
    // Reading a FIFO waits for a writer that never comes.
    const result = await inChild(directory, 5000);
    assert.match(result.outcome, /^CODEX_START_LOCK_UNUSABLE: /);
    assert.ok(result.outcome.includes(lock), result.outcome);
    assert.ok(result.ms < 4000, `refused at once, not at its time: ${result.ms} ms`);
    assert.ok(lstatSync(lock).isFIFO(), 'left as it was');
  },
);

test(
  'AC-0060-L02 a symbolic link and a directory at the lock’s path are refused and left alone',
  { skip: !posix },
  async (t) => {
    const linked = home(t);
    const target = join(linked.directory, 'elsewhere');
    // The PID of no process: 0.1.31 read it through the link and removed the link.
    writeFileSync(target, '2147483646');
    symlinkSync(target, linked.lock);
    await assert.rejects(startLock(linked.directory, 5000), /^Error: CODEX_START_LOCK_UNUSABLE: /);
    assert.ok(lstatSync(linked.lock).isSymbolicLink(), 'the link is left');
    assert.equal(readFileSync(target, 'utf8'), '2147483646');

    const occupied = home(t);
    mkdirSync(occupied.lock);
    await assert.rejects(
      startLock(occupied.directory, 5000),
      (error: Error) =>
        /^CODEX_START_LOCK_UNUSABLE: /.test(error.message) && error.message.includes(occupied.lock),
    );
    assert.ok(lstatSync(occupied.lock).isDirectory());
  },
);

test('AC-0060-L02 only a regular file of this user can be the lock', () => {
  const unusable = (local as any).unusableLock as (
    stat: { isFile(): boolean; uid: number },
    uid: number | undefined,
  ) => string | null;
  assert.equal(typeof unusable, 'function');
  const file = (uid: number) => ({ isFile: () => true, uid });
  assert.equal(unusable(file(501), 501), null);
  assert.match(unusable(file(502), 501)!, /another user/);
  assert.match(unusable({ isFile: () => false, uid: 501 }, 501)!, /regular file/);
  // Where the platform has no user IDs, a regular file is enough.
  assert.equal(unusable(file(0), undefined), null);
});
