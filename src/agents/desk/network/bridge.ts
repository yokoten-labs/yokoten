// The bridge inside a Linux desk (#637). The desk has its own empty network, so nothing
// inside can reach the internet. The proxy runs outside and listens on a Unix socket that
// the desk can see. This bridge listens on 127.0.0.1 inside the desk and passes each
// connection to that socket, so an agent can use a normal `HTTPS_PROXY=http://127.0.0.1:<port>`.
// Then it starts the agent, and exits with the agent's exit code.
//
// bwrap starts it as the desk's first program: `yokoten desk --bridge <socket> <port> -- <command...>`.

import { spawn } from 'node:child_process';
import { connect, createServer, type Server } from 'node:net';
import { failure } from '../../../rules/text/screen.ts';

/** The parts of the bridge's command line, or the reason it can't run. */
export function readBridgeArgs(args: readonly string[]): { socket: string; port: number; command: string[] } | string {
  const [socket, portText, separator, ...command] = args;
  const port = Number(portText);
  if (!socket || !Number.isInteger(port) || port < 1 || port > 65535 || separator !== '--' || !command.length) {
    return 'usage: bridge.ts <socket> <port> -- <command...>';
  }
  return { socket, port, command };
}

/** A failure on the desk's stderr, in the layout: what is wrong, then one Next line. */
const complain = (stderr: { write: (text: string) => unknown }, what: string, next: string): void => {
  stderr.write(`${failure('desk', what, next).join('\n')}\n`);
};

/** Listen on 127.0.0.1:`port`, and pass each connection to the Unix socket at `socket`. */
export function startBridge(socket: string, port: number): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect(socket);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Start the bridge, then the command, and give the command's exit code. A signal the desk
 * gets goes on to the command. `yokoten desk --bridge` calls it, as the desk's first program.
 */
export async function runBridge(args: readonly string[], stderr: { write: (text: string) => unknown }): Promise<number> {
  const parsed = readBridgeArgs(args);
  if (typeof parsed === 'string') {
    complain(stderr, parsed, 'yokoten desk --help');
    return 1;
  }
  const server = await startBridge(parsed.socket, parsed.port);
  // The bridge must not keep the desk open once the command ends.
  server.unref();
  const [file, ...rest] = parsed.command;
  const child = spawn(file, rest, { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, forward(signal));
  return new Promise((resolve) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      complain(stderr, `can't start ${file}: ${error.code ?? error.message}`, 'yokoten doctor');
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}
