// A stdio host with writable Claude and Codex members, for an owner in another language, such as
// Python. The JSON configuration of `orchvia host` takes no stop observer, so there a writable
// member waits blocked for the owner to reconcile each dispatch. This host proves each dispatch
// stopped with stop markers instead, and sweeps what a crashed host left before it starts.
// Needs Claude Code and the Codex CLI installed and signed in; it calls models only for tasks.
// node examples/typescript/writable-host.ts WORKSPACE STATE_DIR MARKER_DIR CODEX_HOME
import { createEngine } from '../../packages/engine/src/index.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import {
  createClaudeAdapter,
  endStopMarkersSync,
  sweepStopMarkers,
} from '../../packages/adapter-claude/src/index.ts';
import { createCodexAdapter } from '../../packages/adapter-codex/src/index.ts';

const [workspace, stateDir, markers, codexHome] = process.argv.slice(2);
if (!workspace || !stateDir || !markers || !codexHome)
  throw new Error(
    'Usage: node examples/typescript/writable-host.ts WORKSPACE STATE_DIR MARKER_DIR CODEX_HOME',
  );

// Before the engine starts: end what the commands of a crashed host left. stdout carries the
// protocol, so reports go to stderr. The owner may reconcile a dispatch reported stopped.
const swept = await sweepStopMarkers(markers);
for (const dispatch of swept.dispatches)
  process.stderr.write(
    `stop marker of dispatch ${dispatch.dispatchId}: ${dispatch.stopped ? 'stopped' : dispatch.reason}\n`,
  );

// Both members share one marker directory, outside every workspace and state directory.
const claude = createClaudeAdapter({
  permissionProfile: 'workspace-write',
  stopMarker: { directory: markers },
});
const codex = createCodexAdapter({
  connection: { home: codexHome },
  stopMarker: { directory: markers },
  policy: (input) =>
    input.permissionProfile === 'read-only' ? { mode: 'plan' } : { mode: 'acceptEdits' },
});
process.on('exit', () => endStopMarkersSync(markers, 300));

const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [claude, codex],
  providers: {
    claude: {
      model: process.env.ORCHVIA_CLAUDE_MODEL ?? 'claude-sonnet-5',
      permissionProfile: 'workspace-write',
    },
    codex: {
      model: process.env.ORCHVIA_CODEX_MODEL ?? 'gpt-5.5',
      permissionProfile: 'workspace-write',
    },
  },
});
// The Python owner holds stdin; when it closes, the host closes too.
await startStdioHost(engine).closed;
