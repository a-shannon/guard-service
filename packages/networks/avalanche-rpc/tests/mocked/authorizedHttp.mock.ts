import { createServer, Server } from 'node:http';
import { Socket } from 'node:net';

let server: Server | undefined;
/** Close the loopback peer after each independent submission case. */
export const closeSubmissionHttp = async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
};

/** Start a synthetic JSON-RPC submission peer and retain requests and socket state. */
export const listen = async (
  responder: (
    body: Record<string, unknown>,
  ) =>
    | { status: number; body: unknown; headers?: Record<string, string> }
    | undefined,
) => {
  const bodies: unknown[] = [],
    paths: string[] = [],
    headers: unknown[] = [],
    sockets: Socket[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      paths.push(req.url!);
      headers.push(req.headers);
      const reply = responder(JSON.parse(body));
      if (reply) {
        res.writeHead(reply.status, {
          'Content-Type': 'application/json',
          ...reply.headers,
        });
        res.end(
          typeof reply.body === 'string'
            ? reply.body
            : JSON.stringify(reply.body),
        );
      }
    });
  });
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  return {
    url: `http://127.0.0.1:${address.port}/rpc/token`,
    bodies,
    paths,
    headers,
    sockets,
  };
};
