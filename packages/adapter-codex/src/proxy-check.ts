import { connect } from 'node:net';

// SPEC-0040 P03: the proxy check of SPEC-0035 F04 as a program a host copies beside its files;
// the same check as `PROXY_CHECK_SCRIPT`, with the socket as its last argument.

const result: { proxy: boolean; unix?: string; outside?: string } = {
  proxy: !!(process.env.HTTPS_PROXY || process.env.https_proxy),
};
const attempt = (options: { path: string } | { host: string; port: number }) =>
  new Promise<string>((done) => {
    const socket = connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      done('timeout');
    }, 3000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      done('connected');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done(error.code || 'error');
    });
  });
result.unix = await attempt({ path: process.argv.at(-1)! });
// TEST-NET-1: an address nothing answers, reached only by a direct connection.
result.outside = await attempt({ host: [192, 0, 2, 1].join('.'), port: 80 });
process.stdout.write(JSON.stringify(result));
