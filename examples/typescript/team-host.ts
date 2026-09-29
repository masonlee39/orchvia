// The stdio host that examples/python/team_mailbox.py starts: an engine with the scripted team
// runtime, owned by the Python process over stdin and stdout.
// node examples/typescript/team-host.ts WORKSPACE STATE_DIR
import { createEngine } from '../../packages/engine/src/index.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import { createTeamAdapter, teamTools } from './team-runtime.ts';

const [workspace, stateDir] = process.argv.slice(2);
if (!workspace || !stateDir)
  throw new Error('Usage: node examples/typescript/team-host.ts WORKSPACE STATE_DIR');
const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [createTeamAdapter()],
  providers: { fake: { model: 'fake-model' } },
  tools: teamTools,
});
await startStdioHost(engine).closed;
