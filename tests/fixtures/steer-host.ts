// SPEC-0048 cross-language fixture: a stdio host whose fake runtime works for 5 seconds and accepts
// every steer.
import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import type { RuntimeAdapter } from '../../packages/engine/src/types.ts';

const [workspace, stateDir] = process.argv.slice(2);
const fake = createFakeAdapter({ delayMs: 5000 });
const adapter: RuntimeAdapter = {
  ...fake,
  capabilities: () => ({ ...fake.capabilities(), steer: true }),
  steer: async () => ({ status: 'accepted' }),
};
const engine = await createEngine({ workspace, stateDir, adapters: [adapter] });
await startStdioHost(engine).closed;
