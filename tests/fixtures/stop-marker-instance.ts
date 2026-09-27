import { spawnSync } from 'node:child_process';
import { StopMarkers } from '../../packages/engine/src/stop-marker.ts';

// A host that marks one dispatch under ROOT, runs COMMAND through its wrapper in WORKSPACE, prints
// what the command printed and the instance directory, and exits without cleaning up, as a host
// that is killed would (SPEC-0036).
const [root, workspace, command, dispatchId = 'dead-dispatch'] = process.argv.slice(2);
const markers = new StopMarkers({ root });
const marker = markers.prepare(dispatchId, '/bin/sh', workspace!);
const run = spawnSync(marker.wrapper, [command!], { cwd: workspace, encoding: 'utf8' });
process.stdout.write(
  JSON.stringify({
    status: run.status,
    pid: Number(run.stdout.trim()),
    instance: markers.directory,
    marker: marker.path,
  }) + '\n',
);
process.exit(0);
