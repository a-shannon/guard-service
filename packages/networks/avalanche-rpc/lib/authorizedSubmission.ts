import { FetchRequest, Transaction } from 'ethers';
import { performance } from 'node:perf_hooks';

export class AuthorizedAvalancheSubmissionError extends Error {
  /** Classifies a submission failure without retaining request credentials. */
  constructor(
    readonly reason:
      | 'invalid'
      | 'denied'
      | 'expired'
      | 'reused'
      | 'response'
      | 'transport',
  ) {
    super(`Avalanche submission ${reason}`);
    this.name = 'AuthorizedAvalancheSubmissionError';
  }
}

/** Secret-bearing identity is compared locally only; never log its value. */
const identity = (request: FetchRequest): string =>
  JSON.stringify({
    url: request.url,
    method: request.method,
    body: request.body ? Buffer.from(request.body).toString('hex') : null,
    headers: Object.entries(request.headers).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    credentials: request.credentials,
    timeout: request.timeout,
    allowGzip: request.allowGzip,
    allowInsecureAuthentication: request.allowInsecureAuthentication,
  });

/** Rejects changes to a captured request identity or its transport hooks. */
export const assertSameConnection = (
  captured: FetchRequest,
  current: FetchRequest,
): void => {
  if (
    identity(captured) !== identity(current) ||
    captured.getUrlFunc !== current.getUrlFunc ||
    captured.preflightFunc !== current.preflightFunc ||
    captured.processFunc !== current.processFunc ||
    captured.retryFunc !== current.retryFunc
  )
    throw new AuthorizedAvalancheSubmissionError('invalid');
};

/** Dedicated, unbatched JSON-RPC request; authorization covers getUrl start only. */
export const submitAuthorizedAvalanche = async (
  connection: FetchRequest,
  serialized: string,
  expectedChainId: bigint,
  authorizeSubmit: (start: () => void) => Promise<void>,
  beforeSend: () => Promise<void>,
  assertFresh: () => void,
): Promise<void> => {
  const request = connection.clone();
  const originalGetUrl = connection.getUrlFunc;
  const timeout = request.timeout;
  let transaction: Transaction;
  try {
    transaction = Transaction.from(serialized);
  } catch {
    throw new AuthorizedAvalancheSubmissionError('invalid');
  }
  if (
    !transaction.isSigned() ||
    transaction.chainId !== expectedChainId ||
    (expectedChainId !== 43113n && expectedChainId !== 43114n) ||
    typeof authorizeSubmit !== 'function' ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 2147483647 ||
    !/^https?:\/\//i.test(request.url)
  )
    throw new AuthorizedAvalancheSubmissionError('invalid');
  const expectedHash = transaction.hash;
  request.method = 'POST';
  request.body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_sendRawTransaction',
    params: [serialized],
  };
  request.setHeader('content-type', 'application/json');
  request.processFunc = null;
  /** Prevents a second dispatch of this authorized transaction request. */
  const noRetry = async () => false;
  request.retryFunc = noRetry;
  request.setThrottleParams({ maxAttempts: 1 });
  const expected = identity(request),
    preflight = request.preflightFunc;
  const deadline = performance.now() + timeout;
  let closed = false,
    sending = false,
    entered = false,
    started = false;
  let rejectDeadline!: (error: Error) => void;
  const expired = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    closed = true;
    if (sending) request.cancel();
    rejectDeadline(new AuthorizedAvalancheSubmissionError('expired'));
  }, timeout);
  /** Enforces the deadline and the caller's current local authority. */
  const check = () => {
    if (closed || performance.now() >= deadline)
      throw new AuthorizedAvalancheSubmissionError('expired');
    assertFresh();
  };
  /** Starts one unchanged transport request inside the authorization callback. */
  const getUrl: typeof originalGetUrl = async (current, signal) => {
    /** Rejects cancellation or mutation before the underlying dispatch starts. */
    const checkRequest = () => {
      check();
      if (
        signal?.cancelled ||
        identity(current) !== expected ||
        current.getUrlFunc !== getUrl ||
        current.preflightFunc !== preflight ||
        current.processFunc !== null ||
        current.retryFunc !== noRetry
      )
        throw new AuthorizedAvalancheSubmissionError('invalid');
    };
    if (entered) throw new AuthorizedAvalancheSubmissionError('reused');
    entered = true;
    checkRequest();
    let response: ReturnType<typeof originalGetUrl> | undefined;
    let authorizing = true;
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          authorizeSubmit(() => {
            checkRequest();
            if (!authorizing || started)
              throw new AuthorizedAvalancheSubmissionError('reused');
            started = true;
            response = originalGetUrl(current, signal);
            void response.catch(() => undefined);
          }),
        ),
        expired,
      ]);
    } catch (error) {
      if (error instanceof AuthorizedAvalancheSubmissionError) throw error;
      throw new AuthorizedAvalancheSubmissionError('denied');
    } finally {
      authorizing = false;
    }
    if (!started || !response)
      throw new AuthorizedAvalancheSubmissionError('denied');
    return await response;
  };
  request.getUrlFunc = getUrl;
  try {
    await Promise.race([Promise.resolve().then(beforeSend), expired]);
    check();
    sending = true;
    const response = await Promise.race([request.send(), expired]);
    check();
    if (response.statusCode !== 200)
      throw new AuthorizedAvalancheSubmissionError('response');
    let body: unknown;
    try {
      body = response.bodyJson;
    } catch {
      throw new AuthorizedAvalancheSubmissionError('response');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new AuthorizedAvalancheSubmissionError('response');
    const rpc = body as Record<string, unknown>;
    if (
      rpc.jsonrpc !== '2.0' ||
      rpc.id !== 1 ||
      Object.hasOwn(rpc, 'error') ||
      rpc.result !== expectedHash
    )
      throw new AuthorizedAvalancheSubmissionError('response');
  } catch (error) {
    if (error instanceof AuthorizedAvalancheSubmissionError) throw error;
    throw new AuthorizedAvalancheSubmissionError('transport');
  } finally {
    closed = true;
    clearTimeout(timer);
    if (sending) request.cancel();
  }
};
