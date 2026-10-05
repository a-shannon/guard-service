import { FetchGetUrlFunc, GetUrlResponse, makeError } from 'ethers';
import {
  request as httpRequest,
  ClientRequest,
  IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';

/** Node transport for Avalanche requests, including provider reads and submission.
 * FetchRequest owns serialization, redirects and retries. This hook owns one
 * HTTP exchange, and destroys its active socket on cancellation or deadline.
 */
export const avalancheGetUrl: FetchGetUrlFunc = (request, signal) =>
  new Promise<GetUrlResponse>((resolve, reject) => {
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let chunks: Buffer[] = [];
    const controller = new AbortController();
    /** Closes the exchange once and reports a credential-free transport error. */
    const fail = (
      code: 'CANCELLED' | 'TIMEOUT' | 'SERVER_ERROR' | 'UNSUPPORTED_OPERATION',
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Both the pending connection and any received response must be closed.
      controller.abort();
      incoming?.destroy();
      outgoing?.destroy();
      incoming = undefined;
      outgoing = undefined;
      chunks = [];
      // Never retain the secret-bearing URL, request, body or native error.
      reject(makeError('Avalanche HTTP transport failed', code));
    };
    try {
      if (signal?.cancelled) return fail('CANCELLED');
      const url = new URL(request.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        (url.protocol === 'http:' &&
          request.credentials &&
          !request.allowInsecureAuthentication)
      )
        return fail('UNSUPPORTED_OPERATION');
      const timeout = request.timeout;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
        return fail('UNSUPPORTED_OPERATION');
      const deadline = performance.now() + timeout;
      const method = request.method;
      const headers = request.headers;
      const body = request.body ? Buffer.from(request.body) : undefined;
      signal?.addListener(() => fail('CANCELLED'));
      timer = setTimeout(() => fail('TIMEOUT'), timeout);
      outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method,
        headers,
        signal: controller.signal,
      });
      outgoing.on('error', () => fail('SERVER_ERROR'));
      outgoing.once('response', (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        incoming = response;
        response.on('error', () => fail('SERVER_ERROR'));
        response.on('aborted', () => fail('SERVER_ERROR'));
        response.on('close', () => {
          if (!response.complete) fail('SERVER_ERROR');
        });
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (signal?.cancelled) return fail('CANCELLED');
          if (performance.now() >= deadline) return fail('TIMEOUT');
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (settled) return;
          if (signal?.cancelled) return fail('CANCELLED');
          if (performance.now() >= deadline) return fail('TIMEOUT');
          try {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers))
              headers[name] = Array.isArray(value)
                ? value.join(', ')
                : value || '';
            let body: Uint8Array | null = chunks.length
              ? Buffer.concat(chunks)
              : null;
            if (headers['content-encoding'] === 'gzip' && body)
              body = gunzipSync(body);
            if (signal?.cancelled) return fail('CANCELLED');
            if (performance.now() >= deadline) return fail('TIMEOUT');
            settled = true;
            clearTimeout(timer);
            chunks = [];
            outgoing = undefined;
            incoming = undefined;
            resolve({
              statusCode: response.statusCode || 0,
              statusMessage: response.statusMessage || '',
              headers,
              body,
            });
          } catch {
            fail('SERVER_ERROR');
          }
        });
      });
      outgoing.end(body);
    } catch {
      fail('SERVER_ERROR');
    }
  });
