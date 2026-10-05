import { FetchRequest } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { avalancheGetUrl } from '../lib/avalancheTransport';
import {
  connection,
  deferred,
  delay,
  signed,
  ok,
  call,
  listen,
  closeSubmissionFixtures,
} from './authorizedSubmissionTestUtils';

describe('submitAuthorizedAvalanche', () => {
  afterEach(closeSubmissionFixtures);
  /**
   * @target submitAuthorizedAvalanche starts captured getUrl inside authority and awaits response after lease release
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Hold authority only around dispatch start, wait for a blocked mock response after releasing it, then resolve that response.
   * @expected
   * - The exact JSON-RPC body starts inside authority and response waiting continues after release.
   */
  it('starts captured getUrl inside authority and awaits response after lease release', async () => {
    const request = connection(),
      response = deferred<void>(),
      entered = deferred<void>();
    let held = false;
    request.getUrlFunc = async (current) => {
      expect(held).toEqual(true);
      expect(JSON.parse(Buffer.from(current.body!).toString())).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [signed().serialized],
      });
      entered.resolve();
      await response.promise;
      return ok();
    };
    const pending = call(request, async (start) => {
      held = true;
      try {
        start();
      } finally {
        held = false;
      }
    });
    await entered.promise;
    await delay(0);
    expect(held).toEqual(false);
    response.resolve();
    await pending;
  });

  /**
   * @target submitAuthorizedAvalanche rejects isolated SDK preflight %s mutation
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Mutate exactly one SDK preflight field from the table before requesting dispatch.
   * @expected
   * - The request rejects as invalid and the captured transport is never called.
   */
  it.each([
    'url',
    'body',
    'method',
    'headers',
    'credentials',
    'timeout',
    'gzip',
    'insecure',
    'getUrl',
    'retry',
    'process',
  ])('rejects isolated SDK preflight %s mutation', async (field) => {
    const request = connection(),
      transport = request.getUrlFunc;
    request.preflightFunc = async (current) => {
      if (field === 'url') current.url = 'https://other.invalid';
      if (field === 'body') current.body = 'wrong';
      if (field === 'method') current.method = 'GET';
      if (field === 'headers') current.setHeader('x-changed', '1');
      if (field === 'credentials') current.setCredentials('user', 'pass');
      if (field === 'timeout') current.timeout = 1;
      if (field === 'gzip') current.allowGzip = false;
      if (field === 'insecure') current.allowInsecureAuthentication = true;
      if (field === 'getUrl') current.getUrlFunc = async () => ok();
      if (field === 'retry') current.retryFunc = async () => true;
      if (field === 'process') current.processFunc = async (_req, res) => res;
      return current;
    };
    await expect(call(request)).rejects.toMatchObject({ reason: 'invalid' });
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target submitAuthorizedAvalanche rechecks the SDK current body after delayed authority before transport starts
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Capture the SDK current request in preflight, delay authority, then mutate its body before start.
   * @expected
   * - Current-body drift rejects before transport.
   */
  it('rechecks the SDK current body after delayed authority before transport starts', async () => {
    const request = connection(),
      transport = request.getUrlFunc;
    let current: FetchRequest;
    request.preflightFunc = async (value) => {
      current = value;
      return value;
    };
    await expect(
      call(request, async (start) => {
        await delay(0);
        current.body = 'changed';
        start();
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target submitAuthorizedAvalanche bounds never-resolving beforeSend and fences its eventual completion
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Leave beforeSend unresolved until the deadline, then release it after expiry.
   * @expected
   * - The expired operation cannot dispatch after eventual completion.
   */
  it('bounds never-resolving beforeSend and fences its eventual completion', async () => {
    const request = connection();
    request.timeout = 20;
    const gate = deferred<void>(),
      transport = request.getUrlFunc;
    await expect(
      call(
        request,
        async (start) => start(),
        () => gate.promise,
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    gate.resolve();
    await delay(5);
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target submitAuthorizedAvalanche bounds delayed authority and rejects its retained callback after expiry
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Retain the start callback while delaying authority past deadline, then invoke it after expiry.
   * @expected
   * - The operation expires and late callback reuse cannot dispatch.
   */
  it('bounds delayed authority and rejects its retained callback after expiry', async () => {
    const request = connection();
    request.timeout = 20;
    const gate = deferred<void>(),
      transport = request.getUrlFunc;
    let late: (() => void) | undefined;
    await expect(
      call(request, async (start) => {
        late = start;
        await gate.promise;
      }),
    ).rejects.toMatchObject({ reason: 'expired' });
    expect(() => late!()).toThrow('expired');
    gate.resolve();
    await delay(5);
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * @target submitAuthorizedAvalanche rejects missing/double dispatch and retained callback reuse
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Omit start, call start twice, then retain a successful start callback for later reuse.
   * @expected
   * - Missing dispatch is denied, double dispatch/reuse reject, and only two valid transport starts occur.
   */
  it('rejects missing/double dispatch and retained callback reuse', async () => {
    const request = connection(),
      transport = request.getUrlFunc;
    await expect(call(request, async () => undefined)).rejects.toMatchObject({
      reason: 'denied',
    });
    await expect(
      call(request, async (start) => {
        start();
        start();
      }),
    ).rejects.toMatchObject({ reason: 'reused' });
    let late: (() => void) | undefined;
    await call(request, async (start) => {
      late = start;
      start();
    });
    expect(() => late!()).toThrow('expired');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  /**
   * @target submitAuthorizedAvalanche does not let a fresh identical request renew an expired old authorization
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Expire an old retained authority callback, run a fresh identical request, then invoke the old callback.
   * @expected
   * - The old callback stays expired and only the fresh request dispatches.
   */
  it('does not let a fresh identical request renew an expired old authorization', async () => {
    const request = connection();
    request.timeout = 20;
    let old: (() => void) | undefined;
    await expect(
      call(request, async (start) => {
        old = start;
        await new Promise(() => undefined);
      }),
    ).rejects.toMatchObject({ reason: 'expired' });
    request.timeout = 1000;
    await call(request);
    expect(() => old!()).toThrow('expired');
    expect(request.getUrlFunc).toHaveBeenCalledOnce();
  });

  /**
   * @target submitAuthorizedAvalanche rejects isolated real HTTP RPC %s fault
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Return an isolated malformed JSON-RPC identity/result/version/error/array/JSON response.
   * @expected
   * - Response validation rejects after exactly one request.
   */
  it.each(['id', 'result', 'jsonrpc', 'error', 'array', 'json'])(
    'rejects isolated real HTTP RPC %s fault',
    async (field) => {
      const reply: Record<string, unknown> = {
        jsonrpc: '2.0',
        id: 1,
        result: signed().hash,
      };
      if (field === 'id') reply.id = 2;
      if (field === 'result') reply.result = '0x' + 'ff'.repeat(32);
      if (field === 'jsonrpc') reply.jsonrpc = '1.0';
      if (field === 'error') reply.error = { code: -1, message: 'rejected' };
      const fixture = await listen(() => ({
        status: 200,
        body:
          field === 'array' ? [reply] : field === 'json' ? 'invalid' : reply,
      }));
      const request = new FetchRequest(fixture.url);
      request.timeout = 1000;
      await expect(call(request)).rejects.toMatchObject({ reason: 'response' });
      expect(fixture.bodies).toHaveLength(1);
    },
  );

  /**
   * @target submitAuthorizedAvalanche rejects HTTP %s without redirect or retry
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Return each redirect/rate-limit HTTP status with redirect/retry headers.
   * @expected
   * - The response rejects without redirect or retry and retains the original path.
   */
  it.each([301, 302, 307, 429])(
    'rejects HTTP %s without redirect or retry',
    async (status) => {
      const fixture = await listen(() => ({
        status,
        body: {},
        headers: { location: '/changed', 'retry-after': '0' },
      }));
      const request = new FetchRequest(fixture.url);
      request.timeout = 1000;
      await expect(call(request)).rejects.toMatchObject({ reason: 'response' });
      expect(fixture.bodies).toHaveLength(1);
      expect(fixture.paths).toEqual(['/rpc/token']);
    },
  );

  /**
   * @target submitAuthorizedAvalanche expires and destroys the real submission socket through owned transport
   * @dependencies
   * - Real ethers FetchRequest, qualified submission helper and owned transport hook.
   * - Synthetic protected transaction and mocked successful JSON-RPC transport.
   * - Synthetic loopback HTTP peer for response, retry and expiry cases.
   * @scenario
   * - Leave a real loopback submission response open past its owned deadline.
   * @expected
   * - The operation expires, cancellation runs, one request is recorded and its socket is destroyed.
   */
  it('expires and destroys the real submission socket through owned transport', async () => {
    const fixture = await listen(() => undefined),
      request = new FetchRequest(fixture.url);
    request.timeout = 80;
    request.getUrlFunc = avalancheGetUrl;
    const cancel = vi.spyOn(FetchRequest.prototype, 'cancel');
    await expect(call(request)).rejects.toMatchObject({ reason: 'expired' });
    await delay(10);
    expect(cancel).toHaveBeenCalled();
    expect(fixture.bodies).toHaveLength(1);
    await vi.waitFor(() =>
      expect(fixture.sockets.every((socket) => socket.destroyed)).toEqual(true),
    );
  });
});
