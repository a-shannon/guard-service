import type { JsonRpcProvider } from 'ethers';
import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
} from 'node:http';
import { Server as TcpServer, Socket } from 'node:net';

export const servers: (Server | TcpServer)[] = [];
export const sockets: Socket[] = [];
export const intervals: ReturnType<typeof setInterval>[] = [];
/** Close tracked loopback sockets, listeners, intervals and providers. */
export const closeHttpFixtures = async (providers: JsonRpcProvider[]) => {
  intervals.splice(0).forEach(clearInterval);
  providers.splice(0).forEach((provider) => provider.destroy());
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
};
/** Start a synthetic loopback HTTP peer and track all accepted sockets. */
export const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) => {
  const server = createServer(handler);
  const connections: Socket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    connections.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('Invalid test listener');
  return {
    url: `http://127.0.0.1:${address.port}/secret-path?secret=query`,
    connections,
  };
};
