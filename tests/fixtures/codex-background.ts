import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Offline owned app-server that behaves as codex-cli 0.153.4 does with a backgrounded command
// (SPEC-0034 E1, E2): the command is the app-server's child, in a process group of its own, and
// it outlives the turn. Its PID is written to FIXTURE_PIDS.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'thread/start' || message.method === 'thread/resume')
      send({ id: message.id, result: { thread: { id: 'thread-background' } } });
    else if (message.method === 'turn/start') {
      const command = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      writeFileSync(process.env.FIXTURE_PIDS!, JSON.stringify([command.pid]));
      send({ id: message.id, result: { turn: { id: 'turn-background' } } });
      send({
        method: 'item/completed',
        params: {
          threadId: 'thread-background',
          turnId: 'turn-background',
          item: { type: 'agentMessage', text: 'started in the background' },
        },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-background',
          turn: { id: 'turn-background', status: 'completed' },
        },
      });
    }
  })
  .on('close', () => process.exit(0));
