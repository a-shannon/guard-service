import { FetchCancelSignal } from 'ethers';
import { createServer as createTcpServer, Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { avalancheGetUrl } from '../lib/avalancheTransport';
import {
  listen,
  connection,
  closed,
  servers,
  sockets,
  intervals,
  closeTransportFixtures,
} from './avalancheTransportTestUtils';

describe('avalancheGetUrl', () => {
  afterEach(closeTransportFixtures);
  /**
   * @target avalancheGetUrl destroys a timed out %s exchange
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Leave response headers/body/stream incomplete at a bounded loopback HTTP server.
   * @expected
   * - The deadline raises TIMEOUT and destroys the active exchange sockets.
   */
  it.each(['headers', 'body', 'stream'] as const)(
    'destroys a timed out %s exchange',
    async (mode) => {
      const fixture = await listen((_request, response) => {
        if (mode === 'headers') return;
        response.writeHead(200);
        response.write('partial');
        if (mode === 'stream')
          intervals.push(setInterval(() => response.write('.'), 10));
      });
      await expect(connection(fixture.url).send()).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      await closed(fixture.connections);
    },
  );

  /**
   * @target avalancheGetUrl destroys cancellation during %s wait
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Cancel a loopback request while awaiting headers or a partial body.
   * @expected
   * - The request raises CANCELLED and destroys the active exchange sockets.
   */
  it.each(['headers', 'body'] as const)(
    'destroys cancellation during %s wait',
    async (mode) => {
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fixture = await listen((_request, response) => {
        if (mode === 'body') {
          response.writeHead(200);
          response.write('partial');
        }
        entered();
      });
      const request = connection(fixture.url, 2000);
      const pending = request.send();
      const outcome = pending.catch((error: unknown) => error);
      await ready;
      request.cancel();
      expect(await outcome).toMatchObject({ code: 'CANCELLED' });
      await closed(fixture.connections);
    },
  );

  /**
   * @target avalancheGetUrl does not allocate a socket for an already cancelled signal
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Invoke the transport with an already-cancelled signal.
   * @expected
   * - It rejects as CANCELLED without allocating a socket.
   */
  it('does not allocate a socket for an already cancelled signal', async () => {
    const fixture = await listen(() => {
      throw Error('Must not send');
    });
    await expect(
      avalancheGetUrl(connection(fixture.url), {
        cancelled: true,
      } as FetchCancelSignal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.connections).toHaveLength(0);
  });

  /**
   * @target avalancheGetUrl times out and closes a stalled TLS handshake before response headers
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Start a loopback TCP endpoint that never completes a TLS handshake.
   * @expected
   * - The deadline raises TIMEOUT and closes the socket before headers.
   */
  it('times out and closes a stalled TLS handshake before response headers', async () => {
    const connections: Socket[] = [];
    const server = createTcpServer((socket) => {
      sockets.push(socket);
      connections.push(socket);
      socket.on('data', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Invalid listener');
    await expect(
      connection(`https://127.0.0.1:${address.port}`).send(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await closed(connections);
  });

  /**
   * @target avalancheGetUrl preserves FetchRequest body, headers, Basic credentials and gzip response
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Send configured JSON/body/headers/Basic fixture credentials and return a gzip-compressed response.
   * @expected
   * - The exact request metadata and decompressed response survive a later cancel.
   */
  it('preserves FetchRequest body, headers, Basic credentials and gzip response', async () => {
    let captured: unknown;
    const fixture = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured = {
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        };
        response.writeHead(200, {
          'content-encoding': 'gzip',
          'x-reply': 'yes',
        });
        response.end(
          gzipSync(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xa869' })),
        );
      });
    });
    const request = connection(fixture.url, 2000);
    request.setCredentials('user', 'private-password');
    request.allowInsecureAuthentication = true;
    request.body = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
    request.setHeader('x-custom', 'custom');
    const response = await request.send();
    expect(response.bodyJson).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: '0xa869',
    });
    expect(response.headers['x-reply']).toEqual('yes');
    expect(captured).toMatchObject({
      method: 'POST',
      body: Buffer.from(request.body!).toString(),
      headers: {
        authorization:
          'Basic ' + Buffer.from('user:private-password').toString('base64'),
        'content-type': 'application/json',
        'content-length': String(request.body!.length),
        'accept-encoding': 'gzip',
        'x-custom': 'custom',
      },
    });
    request.cancel();
    expect(response.bodyJson.result).toEqual('0xa869');
  });

  /**
   * @target avalancheGetUrl keeps SDK retry policy for 429 and does not replace successful JSON-RPC bodies
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Return HTTP429 once, then a successful JSON-RPC error body under the SDK retry policy.
   * @expected
   * - Exactly two requests occur and the final JSON-RPC body is retained.
   */
  it('keeps SDK retry policy for 429 and does not replace successful JSON-RPC bodies', async () => {
    let requests = 0;
    const fixture = await listen((_request, response) => {
      requests++;
      response.writeHead(requests === 1 ? 429 : 200);
      response.end(
        requests === 1
          ? ''
          : JSON.stringify({
              error: { code: -32000, message: 'RPC rejection' },
            }),
      );
    });
    const request = connection(fixture.url, 2000);
    request.setThrottleParams({ slotInterval: 1 });
    request.body = {};
    expect((await request.send()).bodyJson).toEqual({
      error: { code: -32000, message: 'RPC rejection' },
    });
    expect(requests).toEqual(2);
  });

  /**
   * @target avalancheGetUrl rejects insecure Basic authentication before opening a connection
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Attempt Basic fixture credentials over HTTP without insecure-auth permission.
   * @expected
   * - The request rejects before opening a connection and errors omit credentials/endpoint.
   */
  it('rejects insecure Basic authentication before opening a connection', async () => {
    const fixture = await listen(() => {
      throw Error('Must not send');
    });
    const request = connection(fixture.url);
    request.setCredentials('secret-user', 'secret-password');
    const error = await request.send().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(String(error)).not.toMatch(/secret|127\.0\.0\.1/);
    expect(fixture.connections).toHaveLength(0);
  });

  /**
   * @target avalancheGetUrl sanitizes %s response failures
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Return a truncated body or invalid gzip bytes.
   * @expected
   * - The sanitized SERVER_ERROR excludes fixture secrets; incomplete sockets close.
   */
  it.each(['truncated', 'gzip'] as const)(
    'sanitizes %s response failures',
    async (mode) => {
      const fixture = await listen((_request, response) => {
        if (mode === 'gzip') {
          response.writeHead(200, { 'content-encoding': 'gzip' });
          response.end('secret-invalid-gzip');
        } else {
          response.writeHead(200, { 'content-length': '100' });
          response.write('private-body');
          response.socket?.destroy();
        }
      });
      const error = await connection(fixture.url)
        .send()
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'SERVER_ERROR' });
      expect(String(error)).not.toMatch(/secret|private|127\.0\.0\.1/);
      // A fully received gzip response may already have returned its idle socket
      // to Node's pool. Only an incomplete exchange requires teardown here.
      if (mode === 'truncated') await closed(fixture.connections);
    },
  );

  /**
   * @target avalancheGetUrl rejects unsupported timeout %s without a socket
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Set each unsupported timeout on a request for a loopback server.
   * @expected
   * - UNSUPPORTED_OPERATION occurs without a socket.
   */
  it.each([0, 1.5, 2147483648, Infinity])(
    'rejects unsupported timeout %s without a socket',
    async (timeout) => {
      const fixture = await listen(() => {
        throw Error('Must not send');
      });
      const request = connection(fixture.url);
      request.timeout = timeout;
      await expect(avalancheGetUrl(request)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
      });
      expect(fixture.connections).toHaveLength(0);
    },
  );

  /**
   * @target avalancheGetUrl rejects unsupported protocol and invalid secret-bearing URL without exposing input
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Pass an unsupported protocol and a malformed secret-bearing URL.
   * @expected
   * - Errors reject both inputs without exposing the URL fixtures.
   */
  it('rejects unsupported protocol and invalid secret-bearing URL without exposing input', async () => {
    for (const url of [
      'ftp://secret-user:secret-password@fixture.invalid/secret-path',
      'http://secret-user:secret-password@[invalid',
    ]) {
      const error = await avalancheGetUrl(connection(url)).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/secret|fixture|invalid/);
    }
  });

  /**
   * @target avalancheGetUrl preserves raw bytes, disabled gzip and empty response; late cancellation permits a later request
   * @dependencies
   * - Real ethers FetchRequest and Avalanche owned HTTP transport.
   * - Synthetic loopback HTTP/TCP peers and tracked socket/interval state.
   * @scenario
   * - Send raw binary bytes with gzip disabled, receive an empty204 response, then cancel and clone for another request.
   * @expected
   * - Both exact bodies, absent gzip headers, empty response and subsequent request are preserved.
   */
  it('preserves raw bytes, disabled gzip and empty response; late cancellation permits a later request', async () => {
    const bodies: Buffer[] = [];
    const encodings: (string | undefined)[] = [];
    const fixture = await listen((request, response) => {
      encodings.push(request.headers['accept-encoding']);
      request.on('data', (chunk: Buffer) => bodies.push(chunk));
      request.on('end', () => {
        response.writeHead(204, { 'x-values': ['first', 'second'] });
        response.end();
      });
    });
    const request = connection(fixture.url, 2000);
    request.allowGzip = false;
    // ethers6.16 clone resets false to its true default; apply this setting to
    // the actual request delivered to the hook, without changing SDK semantics.
    request.preflightFunc = async (current) => {
      current.allowGzip = false;
      return current;
    };
    request.body = new Uint8Array([0, 128, 255]);
    const response = await request.send();
    expect(response.statusCode).toEqual(204);
    expect(response.body).toBeNull();
    expect(response.headers['x-values']).toEqual('first, second');
    request.cancel();
    const next = request.clone();
    expect((await next.send()).statusCode).toEqual(204);
    expect(Buffer.concat(bodies)).toEqual(
      Buffer.from([0, 128, 255, 0, 128, 255]),
    );
    expect(encodings).toEqual([undefined, undefined]);
  });
});
