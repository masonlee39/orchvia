import { mixedMembers } from './mixed-markers.ts';

// SPEC-0039 M01: a host with a Claude and a Codex member marking under ROOT, each of which leaves a
// background process; it prints both PIDs and exits without cleaning up, as a killed host would.
const [root, base] = process.argv.slice(2);
const members = await mixedMembers(root!, base!);
process.stdout.write(JSON.stringify(await members.pids()) + '\n');
process.exit(0);
