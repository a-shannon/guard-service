import { createServer, Server } from 'node:http';

import { createAxiosInstanceWithHeaders } from '@rosen-clients/axios';
import axios, {
  Axios,
  AxiosAdapter,
  InternalAxiosRequestConfig,
  RateLimitedAxiosConfig,
} from '@rosen-clients/rate-limited-axios';

import {
  AuthorizedErgoSubmission,
  AuthorizedSubmissionError,
  submitAuthorizedErgoTransaction,
} from '../../lib/network/authorizedSubmission';
import { delay, deferred, request } from '../testUtils/authorizedSubmission';
import { success } from './mocked/axios.mock';

const pattern = '^https://fixture.invalid/';
let server: Server | undefined;
describe('submitAuthorizedErgoTransaction', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    RateLimitedAxiosConfig.removeRule(pattern);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });
  /**
   * @target submitAuthorizedErgoTransaction 'matches generated %s JSON wire format and Axios path-prefix semantics'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `body`. -
   * Prepare `captured`. - Prepare `urls`. - Prepare `adapter`. - Prepare
   * `route`. - Apply `await submitAuthorizedErgoTransaction(request({
   * target, body }), adapter)`.
   * @expected
   * - `expect(captured).toEqual([JSON.stringify(body),
   * JSON.stringify(body)])`. - `expect(urls).toEqual([
   * `https://fixture.invalid/prefix${route}`,
   * `https://fixture.invalid/prefix${route}`, ])`.
   */
  it.each(['node', 'explorer'] as const)(
    'matches generated %s JSON wire format and Axios path-prefix semantics',
    async (target) => {
      const body =
        target === 'node'
          ? 'abcd'
          : {
              id: 'test',
              inputs: [{ boxId: 'box', spendingProof: { proofBytes: 'ab' } }],
              outputs: [{ value: '9007199254740993', assets: [] }],
            };
      const captured: string[] = [];
      const urls: string[] = [];
      const adapter: AxiosAdapter = async (config) => {
        captured.push(config.data);
        urls.push(axios.getUri(config));
        return success(config);
      };
      const route =
        target === 'node' ? '/transactions/bytes' : '/api/v0/transactions/send';
      await createAxiosInstanceWithHeaders(
        'https://fixture.invalid/prefix',
        {},
      )({
        url: route,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: body,
        adapter,
      });
      await submitAuthorizedErgoTransaction(request({ target, body }), adapter);
      expect(captured).toEqual([JSON.stringify(body), JSON.stringify(body)]);
      expect(urls).toEqual([
        `https://fixture.invalid/prefix${route}`,
        `https://fixture.invalid/prefix${route}`,
      ]);
    },
  );
  /**
   * @target submitAuthorizedErgoTransaction 'captures nested Explorer input and authorizer before the shared queue'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Apply
   * `RateLimitedAxiosConfig.addRule(pattern, 1, 0, 1)`. - Prepare `release`.
   * - Prepare `body`, `start`. - Prepare `authorized`. - Prepare `options`.
   * - Prepare `task`. - Apply `await delay(10)`. - Apply
   * `body.outputs[0].value = '2'`. - Apply `Object.assign(options, {
   * baseUrl: 'https://other.invalid', authorizeSubmit: () => { throw
   * Error('changed'); }, })`. - Apply `release()`. - Apply `await task`.
   * @expected
   * - `expect(start).not.toHaveBeenCalled()`. -
   * `expect(authorized).toEqual(1)`. -
   * `expect(start.mock.calls[0][0].data).toEqual('{"outputs":[{"value":"1"}]}')`.
   */
  it('captures nested Explorer input and authorizer before the shared queue', async () => {
    RateLimitedAxiosConfig.addRule(pattern, 1, 0, 1);
    const release =
      await RateLimitedAxiosConfig.getRules()[0].semaphore.acquire();
    const body = { outputs: [{ value: '1' }] },
      start = vi.fn(success);
    let authorized = 0;
    const options = request({
      target: 'explorer',
      body,
      authorizeSubmit: async (dispatch) => {
        authorized++;
        dispatch();
      },
    });
    const task = submitAuthorizedErgoTransaction(options, start);
    await delay(10);
    body.outputs[0].value = '2';
    Object.assign(options, {
      baseUrl: 'https://other.invalid',
      authorizeSubmit: () => {
        throw Error('changed');
      },
    });
    expect(start).not.toHaveBeenCalled();
    release();
    await task;
    expect(authorized).toEqual(1);
    expect(start.mock.calls[0][0].data).toEqual('{"outputs":[{"value":"1"}]}');
  });
  /**
   * @target submitAuthorizedErgoTransaction 'denies a request held in the real shared queue and releases its slot'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Apply
   * `RateLimitedAxiosConfig.addRule(pattern, 1, 0, 10)`. - Prepare
   * `release`. - Prepare `allowed`. - Prepare `start`. - Prepare `task`. -
   * Prepare `rejected`. - Apply `await delay(10)`. - Apply `allowed =
   * false`. - Apply `release()`. - Apply `await
   * submitAuthorizedErgoTransaction(request(), start)`.
   * @expected
   * - `expect(start).not.toHaveBeenCalled()`. - `expect(await
   * rejected).toBeInstanceOf(AuthorizedSubmissionError)`. -
   * `expect(start).toHaveBeenCalledTimes(1)`.
   */
  it('denies a request held in the real shared queue and releases its slot', async () => {
    RateLimitedAxiosConfig.addRule(pattern, 1, 0, 10);
    const release =
      await RateLimitedAxiosConfig.getRules()[0].semaphore.acquire();
    let allowed = true;
    const start = vi.fn(success);
    const task = submitAuthorizedErgoTransaction(
      request({
        authorizeSubmit: async (dispatch) => {
          if (!allowed) throw Error('held');
          dispatch();
        },
      }),
      start,
    );
    const rejected = task.then(
      () => undefined,
      (error) => error,
    );
    await delay(10);
    allowed = false;
    expect(start).not.toHaveBeenCalled();
    release();
    expect(await rejected).toBeInstanceOf(AuthorizedSubmissionError);
    await submitAuthorizedErgoTransaction(request(), start);
    expect(start).toHaveBeenCalledTimes(1);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'expires while queued; a fresh identical request never renews the old request'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Apply
   * `RateLimitedAxiosConfig.addRule(pattern, 1, 0, 10)`. - Prepare
   * `release`. - Prepare `start`. - Prepare `authorize`. - Prepare `fresh`.
   * - Apply `release()`. - Apply `await fresh`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ timeoutMs: 20,
   * authorizeSubmit: authorize }), start, ), ).rejects.toMatchObject({
   * reason: 'expired' })`. - `expect(authorize).not.toHaveBeenCalled()`. -
   * `expect(start).toHaveBeenCalledTimes(1)`.
   */
  it('expires while queued; a fresh identical request never renews the old request', async () => {
    RateLimitedAxiosConfig.addRule(pattern, 1, 0, 10);
    const release =
      await RateLimitedAxiosConfig.getRules()[0].semaphore.acquire();
    const start = vi.fn(success);
    const authorize = vi.fn(async (dispatch: () => void) => dispatch());
    await expect(
      submitAuthorizedErgoTransaction(
        request({ timeoutMs: 20, authorizeSubmit: authorize }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    const fresh = submitAuthorizedErgoTransaction(request(), start);
    release();
    await fresh;
    expect(authorize).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'expires during delayed authorization and permanently revokes its late callback'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `gate`,
   * `entered`. - Prepare `late`. - Prepare `start`. - Apply `await
   * entered.promise`. - Apply `gate.resolve()`. - Apply `await delay(5)`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ timeoutMs: 20,
   * authorizeSubmit: async (dispatch) => { late = dispatch;
   * entered.resolve(); await gate.promise; }, }), start, ),
   * ).rejects.toMatchObject({ reason: 'expired' })`. - `expect(() =>
   * late!()).toThrow(AuthorizedSubmissionError)`. -
   * `expect(start).not.toHaveBeenCalled()`.
   */
  it('expires during delayed authorization and permanently revokes its late callback', async () => {
    const gate = deferred<void>(),
      entered = deferred<void>();
    let late: (() => void) | undefined;
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(
        request({
          timeoutMs: 20,
          authorizeSubmit: async (dispatch) => {
            late = dispatch;
            entered.resolve();
            await gate.promise;
          },
        }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    await entered.promise;
    expect(() => late!()).toThrow(AuthorizedSubmissionError);
    gate.resolve();
    await delay(5);
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target submitAuthorizedErgoTransaction 'awaits the transport response after the authority action has released'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `held`. -
   * Prepare `sent`, `response`. - Prepare `pending`. - Apply `await
   * sent.promise`. - Apply `await delay(0)`. - Apply `response.resolve()`. -
   * Apply `await pending`.
   * @expected
   * - `expect(held).toEqual(true)`. - `expect(held).toEqual(false)`.
   */
  it('awaits the transport response after the authority action has released', async () => {
    let held = false;
    const sent = deferred<void>(),
      response = deferred<void>();
    const pending = submitAuthorizedErgoTransaction(
      request({
        authorizeSubmit: async (dispatch) => {
          held = true;
          try {
            dispatch();
          } finally {
            held = false;
          }
        },
      }),
      async (config) => {
        expect(held).toEqual(true);
        sent.resolve();
        await response.promise;
        return success(config);
      },
    );
    await sent.promise;
    await delay(0);
    expect(held).toEqual(false);
    response.resolve();
    await pending;
  });
  /**
   * @target submitAuthorizedErgoTransaction 'rejects missing and repeated dispatch without a second transport invocation'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ authorizeSubmit:
   * async () => undefined }), start, ), ).rejects.toMatchObject({ reason:
   * 'denied' })`. - `expect( submitAuthorizedErgoTransaction( request({
   * authorizeSubmit: async (dispatch) => { dispatch(); dispatch(); }, }),
   * start, ), ).rejects.toMatchObject({ reason: 'reused' })`. -
   * `expect(start).toHaveBeenCalledTimes(1)`.
   */
  it('rejects missing and repeated dispatch without a second transport invocation', async () => {
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(
        request({ authorizeSubmit: async () => undefined }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'denied' });
    await expect(
      submitAuthorizedErgoTransaction(
        request({
          authorizeSubmit: async (dispatch) => {
            dispatch();
            dispatch();
          },
        }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'reused' });
    expect(start).toHaveBeenCalledTimes(1);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'contains late transport failure when authorization throws after start'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `response`. -
   * Apply `response.reject(Error('late transport'))`. - Apply `await
   * delay(5)`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ authorizeSubmit:
   * async (dispatch) => { dispatch(); throw Error('later denial'); }, }), ()
   * => response.promise, ), ).rejects.toMatchObject({ reason: 'denied' })`.
   */
  it('contains late transport failure when authorization throws after start', async () => {
    const response = deferred<never>();
    await expect(
      submitAuthorizedErgoTransaction(
        request({
          authorizeSubmit: async (dispatch) => {
            dispatch();
            throw Error('later denial');
          },
        }),
        () => response.promise,
      ),
    ).rejects.toMatchObject({ reason: 'denied' });
    response.reject(Error('late transport'));
    await delay(5);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'rejects isolated %s mutation after queue acquire'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `instrumented`.
   * - Prepare `original`. - Prepare `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction(request(), start),
   * ).rejects.toMatchObject({ reason: 'invalid', config: expect.any(Object)
   * })`. - `expect(start).not.toHaveBeenCalled()`.
   */
  it.each([
    'url',
    'baseURL',
    'method',
    'data',
    'headers',
    'timeout',
    'signal',
    'redirects',
    'params',
    'transport',
    'socket',
    'redirectHook',
    'proxy',
    'auth',
    'httpAgent',
    'httpsAgent',
    'lookup',
    'family',
    'httpVersion',
    'host',
    'length',
    'authorization',
  ])('rejects isolated %s mutation after queue acquire', async (field) => {
    // Instrument the installed JS queue only in this negative test; production uses public APIs.
    const instrumented = Axios as unknown as {
      interceptorForRequest: (
        config: InternalAxiosRequestConfig,
      ) => Promise<InternalAxiosRequestConfig>;
    };
    const original = instrumented.interceptorForRequest;
    vi.spyOn(instrumented, 'interceptorForRequest').mockImplementation(
      async (config) => {
        const result = await original(config);
        if (field === 'url') result.url = '/other';
        if (field === 'baseURL') result.baseURL = 'https://other.invalid';
        if (field === 'method') result.method = 'get';
        if (field === 'data') result.data = '"beef"';
        if (field === 'headers') result.headers.setContentType('text/plain');
        if (field === 'timeout') result.timeout = 0;
        if (field === 'signal') result.signal = new AbortController().signal;
        if (field === 'redirects') result.maxRedirects = 1;
        if (field === 'params') result.params = { extra: 1 };
        if (field === 'transport') result.transport = {};
        if (field === 'socket') result.socketPath = 'other';
        if (field === 'redirectHook') result.beforeRedirect = () => undefined;
        if (field === 'proxy') result.proxy = false;
        if (field === 'auth')
          result.auth = { username: 'fixture', password: 'fixture' };
        if (field === 'httpAgent') result.httpAgent = {};
        if (field === 'httpsAgent') result.httpsAgent = {};
        if (field === 'lookup') result.lookup = () => undefined;
        if (field === 'family') result.family = 6;
        if (field === 'httpVersion') result.httpVersion = 2;
        if (field === 'host') result.headers.set('Host', 'other.invalid');
        if (field === 'length') result.headers.set('Content-Length', '0');
        if (field === 'authorization')
          result.headers.set('Authorization', 'fixture');
        return result;
      },
    );
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(request(), start),
    ).rejects.toMatchObject({ reason: 'invalid', config: expect.any(Object) });
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target submitAuthorizedErgoTransaction 'rejects invalid timeout %s before queue or transport'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `authorize`,
   * `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ timeoutMs: timeout
   * as number, authorizeSubmit: authorize }), start, ),
   * ).rejects.toMatchObject({ reason: 'invalid' })`. -
   * `expect(authorize).not.toHaveBeenCalled()`. -
   * `expect(start).not.toHaveBeenCalled()`.
   */
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '20', undefined])(
    'rejects invalid timeout %s before queue or transport',
    async (timeout) => {
      const authorize = vi.fn(),
        start = vi.fn(success);
      await expect(
        submitAuthorizedErgoTransaction(
          request({ timeoutMs: timeout as number, authorizeSubmit: authorize }),
          start,
        ),
      ).rejects.toMatchObject({ reason: 'invalid' });
      expect(authorize).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  /**
   * @target submitAuthorizedErgoTransaction 'rejects invalid input %j'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request(changes as
   * Partial<AuthorizedErgoSubmission>), start, ), ).rejects.toMatchObject({
   * reason: 'invalid' })`. - `expect(start).not.toHaveBeenCalled()`.
   */
  it.each([
    { baseUrl: 'file:///tmp/test' },
    { baseUrl: 'invalid' },
    { target: 'bad' },
    { body: 'ABCDEF' },
    { body: 'abc' },
    { target: 'explorer', body: [] },
    { target: 'explorer', body: null },
  ])('rejects invalid input %j', async (changes) => {
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(
        request(changes as Partial<AuthorizedErgoSubmission>),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target submitAuthorizedErgoTransaction 'rejects an unserializable Explorer body before network reads'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `body`. - Apply
   * `body.circular = body`. - Prepare `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ target:
   * 'explorer', body }), start, ), ).rejects.toMatchObject({ reason:
   * 'invalid' })`. - `expect(start).not.toHaveBeenCalled()`.
   */
  it('rejects an unserializable Explorer body before network reads', async () => {
    const body: Record<string, unknown> = {};
    body.circular = body;
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(
        request({ target: 'explorer', body }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target submitAuthorizedErgoTransaction 'revokes an authorizer-retained callback after successful completion'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `late`. -
   * Prepare `start`.
   * @expected
   * - `expect(() => late!()).toThrow(AuthorizedSubmissionError)`. -
   * `expect(start).toHaveBeenCalledTimes(1)`.
   */
  it('revokes an authorizer-retained callback after successful completion', async () => {
    let late: (() => void) | undefined;
    const start = vi.fn(success);
    await submitAuthorizedErgoTransaction(
      request({
        authorizeSubmit: async (dispatch) => {
          late = dispatch;
          dispatch();
        },
      }),
      start,
    );
    expect(() => late!()).toThrow(AuthorizedSubmissionError);
    expect(start).toHaveBeenCalledTimes(1);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'rechecks the captured request after delayed authorization, immediately at dispatch'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `instrumented`.
   * - Prepare `original`. - Prepare `queued`. - Prepare `start`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ authorizeSubmit:
   * async (dispatch) => { await delay(0); queued.data = '"beef"';
   * dispatch(); }, }), start, ), ).rejects.toMatchObject({ reason: 'invalid'
   * })`. - `expect(start).not.toHaveBeenCalled()`.
   */
  it('rechecks the captured request after delayed authorization, immediately at dispatch', async () => {
    const instrumented = Axios as unknown as {
      interceptorForRequest: (
        config: InternalAxiosRequestConfig,
      ) => Promise<InternalAxiosRequestConfig>;
    };
    const original = instrumented.interceptorForRequest;
    let queued: InternalAxiosRequestConfig;
    vi.spyOn(instrumented, 'interceptorForRequest').mockImplementation(
      async (config) => {
        queued = await original(config);
        return queued;
      },
    );
    const start = vi.fn(success);
    await expect(
      submitAuthorizedErgoTransaction(
        request({
          authorizeSubmit: async (dispatch) => {
            await delay(0);
            queued.data = '"beef"';
            dispatch();
          },
        }),
        start,
      ),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(start).not.toHaveBeenCalled();
  });
  /**
   * @target submitAuthorizedErgoTransaction 'bounds a real stalled loopback HTTP POST using the captured abort signal'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `requests`. -
   * Prepare `received`. - Apply `server = createServer(() => { requests++;
   * received.resolve(); })`. - Apply `await new Promise<void>((resolve) =>
   * server!.listen(0, '127.0.0.1', resolve))`. - Prepare `address`. -
   * Prepare `pending`. - Prepare `result`. - Apply `await received.promise`.
   * @expected
   * - `expect(await result).toMatchObject({ reason: 'expired' })`. -
   * `expect(requests).toEqual(1)`.
   */
  it('bounds a real stalled loopback HTTP POST using the captured abort signal', async () => {
    let requests = 0;
    const received = deferred<void>();
    server = createServer(() => {
      requests++;
      received.resolve();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const pending = submitAuthorizedErgoTransaction(
      request({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100 }),
    );
    const result = pending.then(
      () => undefined,
      (error) => error,
    );
    await received.promise;
    expect(await result).toMatchObject({ reason: 'expired' });
    expect(requests).toEqual(1);
  });
  /**
   * @target submitAuthorizedErgoTransaction 'does not follow a real HTTP redirect into another POST target'
   * @dependencies
   * - RateLimitedAxios shared queue/interceptor, Axios adapter, explicit
   * authorizer, captured input and isolated loopback HTTP server.
   * @scenario
   * - Prepare the request, authorizer and transport fixture. Apply the
   * case-specific queue, timing, callback, request mutation or HTTP response
   * condition. Submit through the authorization boundary and inspect exact
   * wire data, refusal and downstream-call counts. - Prepare `paths`. -
   * Apply `server = createServer((req, res) => { paths.push(req.url!);
   * res.writeHead(307, { Location: '/other' }); res.end(); })`. - Apply
   * `await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1',
   * resolve))`. - Prepare `address`.
   * @expected
   * - `expect( submitAuthorizedErgoTransaction( request({ baseUrl:
   * `http://127.0.0.1:${address.port}` }), ), ).rejects.toMatchObject({
   * response: { status: 307 } })`. -
   * `expect(paths).toEqual(['/transactions/bytes'])`.
   */
  it('does not follow a real HTTP redirect into another POST target', async () => {
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(307, { Location: '/other' });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    await expect(
      submitAuthorizedErgoTransaction(
        request({ baseUrl: `http://127.0.0.1:${address.port}` }),
      ),
    ).rejects.toMatchObject({ response: { status: 307 } });
    expect(paths).toEqual(['/transactions/bytes']);
  });
});
