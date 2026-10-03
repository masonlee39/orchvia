// SPEC-0065 cross-language fixture: a stdio host with the fake runtime.
import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';

const [workspace, stateDir] = process.argv.slice(2);
const engine = await createEngine({ workspace, stateDir, adapters: [createFakeAdapter()] });
await startStdioHost(engine).closed;
