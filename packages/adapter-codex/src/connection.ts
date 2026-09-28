import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppServerConnection, errorMessage, record, type Message } from './app-server.ts';
import {
  clientInfo as checkClientInfo,
  coded,
  codexVersion,
  connectionHome,
  supportedVersion,
  withStartLock,
  type CodexClientInfo,
} from './local.ts';
import { VERSION } from '../../engine/src/version.ts';

// SPEC-0035 C: the user's Codex connection without an engine. Each call runs a short-lived
// app-server on the home under the start lock; a browser or device-code sign-in keeps its
// app-server, which serves the sign-in, until it completes, is cancelled or times out.

export interface CodexConnectionConfig {
  home: string;
  command?: string;
  /** The app-server's arguments; defaults to `['app-server']`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientInfo?: CodexClientInfo;
  /** Each call's time, and a sign-in's default wait; 30 s. */
  timeoutMs?: number;
}
export type CodexLogin =
  | { type: 'apiKey'; apiKey: string }
  | { type: 'chatgpt' }
  | { type: 'chatgptDeviceCode' };

export interface CodexConnection {
  /** C01: the binary's version, whether Orchvia supports it, and where Codex keeps its home. */
  probe(): Promise<{
    version: string | null;
    supported: boolean;
    userAgent: string | null;
    codexHome: string | null;
    platform: { family: string | null; os: string | null };
  }>;
  /** C02: Codex's `account/read`. */
  account(): Promise<Message>;
  /** C03: Codex's `account/login/start`; the API key goes to Codex only. */
  login(login: CodexLogin): Promise<Message>;
  /** C04: the sign-in's `account/login/completed`, or CODEX_LOGIN_TIMEOUT. */
  waitForLogin(loginId: string, options?: { timeoutMs?: number }): Promise<Message>;
  cancel(loginId: string): Promise<Message>;
  /** C05. */
  logout(): Promise<Message>;
  rateLimits(): Promise<Message>;
  /** Ends every sign-in still waiting. */
  close(): Promise<void>;
}

const LOGIN_WAIT_MS = 10 * 60_000;

export function codexConnection(config: CodexConnectionConfig): CodexConnection {
  const home = connectionHome(config.home);
  const info = checkClientInfo(config.clientInfo) ?? {
    name: 'agent_orch',
    title: 'Agent Orchestration',
    version: VERSION,
  };
  const callMs = config.timeoutMs ?? 30_000;
  // A waiting sign-in's app-server is read by its own loop only; `replies` carries the answers to
  // requests sent to it meanwhile, such as a cancellation.
  const pending = new Map<
    string,
    {
      connection: AppServerConnection;
      completed: Promise<Message>;
      replies: Map<number, (message: Message) => void>;
    }
  >();

  /** Starts an app-server on the home and initializes it, holding the start lock meanwhile. */
  const open = (
    deadline: () => number,
  ): Promise<{ connection: AppServerConnection; initialized: Message }> =>
    withStartLock(home, callMs, async () => {
      const child: ChildProcessWithoutNullStreams = spawn(
        config.command ?? 'codex',
        config.args ?? ['app-server'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            ...config.env,
            CODEX_HOME: home,
            CODEX_SQLITE_HOME: home,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const spawned = await new Promise<Error | null>((resolve) => {
        child.once('spawn', () => resolve(null));
        child.once('error', (error) => resolve(error));
      });
      if (spawned)
        throw Object.assign(
          new Error(
            (spawned as NodeJS.ErrnoException).code === 'ENOENT'
              ? coded('CODEX_NOT_FOUND', `${config.command ?? 'codex'} cannot be run`)
              : errorMessage(spawned),
          ),
          {
            code:
              (spawned as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'CODEX_NOT_FOUND'
                : 'CODEX_REQUEST_FAILED',
          },
        );
      const connection = new AppServerConnection(
        child,
        { remainingRequestMs: deadline, closeTimeoutMs: 1000 },
        () => {},
      );
      try {
        const initialized = await connection.request('initialize', { clientInfo: info });
        connection.notify('initialized');
        return { connection, initialized };
      } catch (error) {
        await connection.close();
        throw error;
      }
    });

  const call = async (method: string, params: Message = {}): Promise<Message> => {
    const end = performance.now() + callMs;
    const { connection } = await open(() => end - performance.now());
    try {
      return await connection.request(method, params);
    } catch (error) {
      throw Object.assign(new Error(errorMessage(error)), { code: 'CODEX_REQUEST_FAILED' });
    } finally {
      await connection.close();
    }
  };

  return {
    async probe() {
      const end = performance.now() + callMs;
      const { connection, initialized } = await open(() => end - performance.now());
      await connection.close();
      const version = codexVersion(initialized.userAgent);
      return {
        version,
        supported: supportedVersion(version),
        userAgent: typeof initialized.userAgent === 'string' ? initialized.userAgent : null,
        codexHome: typeof initialized.codexHome === 'string' ? initialized.codexHome : null,
        platform: {
          family:
            typeof initialized.platformFamily === 'string' ? initialized.platformFamily : null,
          os: typeof initialized.platformOs === 'string' ? initialized.platformOs : null,
        },
      };
    },
    account: () => call('account/read'),
    logout: () => call('account/logout'),
    rateLimits: () => call('account/rateLimits/read'),
    async login(login) {
      if (login?.type === 'apiKey') {
        if (typeof login.apiKey !== 'string' || !login.apiKey)
          throw Object.assign(new Error('An API key sign-in needs the key'), {
            code: 'VALIDATION_ERROR',
          });
        return call('account/login/start', { type: 'apiKey', apiKey: login.apiKey });
      }
      if (login?.type !== 'chatgpt' && login?.type !== 'chatgptDeviceCode')
        throw Object.assign(new Error('Unknown sign-in type'), { code: 'VALIDATION_ERROR' });
      // The app-server that starts a sign-in serves it, so it stays until the sign-in ends.
      let waitEnd = performance.now() + callMs;
      const { connection } = await open(() => waitEnd - performance.now());
      let started: Message;
      try {
        started = await connection.request('account/login/start', { type: login.type });
      } catch (error) {
        await connection.close();
        throw Object.assign(new Error(errorMessage(error)), { code: 'CODEX_REQUEST_FAILED' });
      }
      const loginId = typeof started.loginId === 'string' ? started.loginId : null;
      if (!loginId) {
        await connection.close();
        throw Object.assign(new Error('Codex returned no loginId'), {
          code: 'CODEX_REQUEST_FAILED',
        });
      }
      waitEnd = performance.now() + LOGIN_WAIT_MS;
      const replies = new Map<number, (message: Message) => void>();
      const completed = (async () => {
        try {
          while (true) {
            const message = await connection.next(() => waitEnd - performance.now());
            if (!message) throw new Error('Codex app-server ended before the sign-in completed');
            if (message.method === undefined && typeof message.id === 'number') {
              replies.get(message.id)?.(message);
              replies.delete(message.id);
              continue;
            }
            const params = record(message.params);
            if (
              message.method === 'account/login/completed' &&
              (params?.loginId ?? loginId) === loginId
            )
              return params ?? {};
          }
        } finally {
          pending.delete(loginId);
          await connection.close();
        }
      })();
      completed.catch(() => {});
      pending.set(loginId, { connection, completed, replies });
      return started;
    },
    async waitForLogin(loginId, options = {}) {
      const entry = pending.get(loginId);
      if (!entry)
        throw Object.assign(new Error(`No sign-in ${loginId} is waiting`), { code: 'NOT_FOUND' });
      const limit = options.timeoutMs ?? LOGIN_WAIT_MS;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          entry.completed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(
                    new Error(coded('CODEX_LOGIN_TIMEOUT', 'the sign-in did not complete')),
                    { code: 'CODEX_LOGIN_TIMEOUT' },
                  ),
                ),
              limit,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(loginId) {
      const entry = pending.get(loginId);
      if (!entry) return call('account/login/cancel', { loginId });
      const answer = await new Promise<Message>((resolve, reject) => {
        try {
          entry.replies.set(entry.connection.send('account/login/cancel', { loginId }), resolve);
        } catch (error) {
          reject(error);
        }
        setTimeout(
          () => reject(new Error('Codex did not answer the cancellation')),
          callMs,
        ).unref();
      }).catch((error) => {
        throw Object.assign(new Error(errorMessage(error)), { code: 'CODEX_REQUEST_FAILED' });
      });
      if (answer.error)
        throw Object.assign(new Error(String(record(answer.error)?.message ?? 'cancel failed')), {
          code: 'CODEX_REQUEST_FAILED',
        });
      // The sign-in ends with Codex's completion; once cancel returns, it is no longer waiting.
      await Promise.race([
        entry.completed.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, callMs).unref()),
      ]);
      return record(answer.result) ?? {};
    },
    async close() {
      await Promise.all([...pending.values()].map(({ connection }) => connection.close()));
      pending.clear();
    },
  };
}
