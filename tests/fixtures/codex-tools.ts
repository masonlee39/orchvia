import { exerciseTools } from './orchestration-actions.ts';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { TOOL_NAMES } from '../../packages/engine/src/tools.ts';

// The agent_orch entry, started as Codex starts an MCP server: its command and arguments, with
// its `env` added to the app-server's environment (SPEC-0039 B01).
// FIXTURE_ENV_OUT: where to write the names of the app-server's environment variables.
if (process.env.FIXTURE_ENV_OUT)
  writeFileSync(process.env.FIXTURE_ENV_OUT, JSON.stringify(Object.keys(process.env)));
const config = process.argv.find((arg) => arg.startsWith('mcp_servers=')) ?? '';
const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const command = JSON.parse(config.match(new RegExp(`command=(${quoted})`))?.[1] ?? 'null');
const args = JSON.parse(
  `[${config.match(new RegExp(`args=\\[((?:${quoted},?)*)\\]`))?.[1] ?? ''}]`,
);
const entryEnv = Object.fromEntries(
  [
    ...(config.match(/[,{]env=\{([^}]*)\}/)?.[1] ?? '').matchAll(
      new RegExp(`([A-Za-z_][A-Za-z0-9_]*)=(${quoted})`, 'g'),
    ),
  ].map((match) => [match[1], JSON.parse(match[2]!)]),
);
if (!command || !args.length || config.includes(process.env.AGENT_ORCH_BRIDGE_TOKEN!))
  throw new Error('Invalid private bridge wiring');
const bridge = spawn(command, args, {
  env: { ...process.env, ...entryEnv },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const responses = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
const call = async (method: string, params = {}) => {
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  return JSON.parse((await responses.next()).value!);
};
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
process.on('exit', () => bridge.kill());
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    if (req.method === 'initialize') send({ id: req.id, result: {} });
    else if (req.method === 'thread/start')
      send({ id: req.id, result: { thread: { id: 'thread' } } });
    else if (req.method === 'turn/start') {
      send({ id: req.id, result: { turn: { id: 'turn' } } });
      await call('initialize', { protocolVersion: '2024-11-05' });
      let result: unknown;
      if (process.argv.includes('--engine-tools'))
        result = await exerciseTools(async (name, request) => {
          const response = await call('tools/call', { name, arguments: { request } });
          if (response.result.isError) throw new Error(response.result.content[0].text);
          return JSON.parse(response.result.content[0].text);
        });
      else {
        result = [];
        for (const name of TOOL_NAMES)
          (result as unknown[]).push(
            await call('tools/call', { name, arguments: { request: { id: name } } }),
          );
      }
      send({
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: { type: 'agentMessage', text: JSON.stringify(result) },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
      });
    } else send({ id: req.id, result: {} });
  }
} finally {
  bridge.stdin.end();
  bridge.kill();
}
