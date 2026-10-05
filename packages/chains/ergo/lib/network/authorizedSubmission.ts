import { performance } from 'node:perf_hooks';

import { createAxiosInstanceWithHeaders } from '@rosen-clients/axios';
import axios, {
  AxiosAdapter,
  InternalAxiosRequestConfig,
  getAdapter,
} from '@rosen-clients/rate-limited-axios';

export class AuthorizedSubmissionError extends axios.AxiosError {
  /** Creates a submission error with its authorization code and cause. */
  constructor(
    readonly reason: 'invalid' | 'denied' | 'expired' | 'reused',
    config?: InternalAxiosRequestConfig,
    cause?: unknown,
  ) {
    super(
      `Ergo submission authorization ${reason}`,
      'ERR_ERGO_SUBMISSION_AUTHORIZATION',
      config,
    );
    this.name = 'AuthorizedSubmissionError';
    this.cause = cause instanceof Error ? cause : undefined;
  }
}

export interface AuthorizedErgoSubmission {
  readonly baseUrl: string;
  readonly target: 'node' | 'explorer';
  /** Node: canonical signed transaction hex. Explorer: EIP-12 JSON object. */
  readonly body: string | object;
  readonly timeoutMs: number;
  /** Invoke start synchronously under fresh authority; do not retain it. */
  readonly authorizeSubmit: (start: () => void) => Promise<void>;
}

/**
 * Authorize one adapter start after the shared rate-limit queue. The response
 * is awaited outside authorization. This cannot revoke an accepted broadcast.
 * The optional adapter is a trusted transport dependency, not request data.
 */
export const submitAuthorizedErgoTransaction = async (
  request: AuthorizedErgoSubmission,
  transport?: AxiosAdapter,
): Promise<void> => {
  const { baseUrl, target, body, timeoutMs, authorizeSubmit } = request;
  if (
    typeof baseUrl !== 'string' ||
    typeof authorizeSubmit !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647 ||
    (target !== 'node' && target !== 'explorer')
  )
    throw new AuthorizedSubmissionError('invalid');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new AuthorizedSubmissionError('invalid', undefined, error);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hash)
    throw new AuthorizedSubmissionError('invalid');
  if (
    target === 'node'
      ? typeof body !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(body)
      : !body || typeof body !== 'object' || Array.isArray(body)
  )
    throw new AuthorizedSubmissionError('invalid');
  // Capture JSON now, including every nested Explorer field, before any await.
  let wireBody: string | undefined;
  try {
    wireBody = JSON.stringify(body);
  } catch (error) {
    throw new AuthorizedSubmissionError('invalid', undefined, error);
  }
  if (typeof wireBody !== 'string')
    throw new AuthorizedSubmissionError('invalid');
  const headers = new axios.AxiosHeaders();
  for (const [name, value] of Object.entries({
    ...axios.defaults.headers.common,
    ...axios.defaults.headers.post,
  }))
    if (value !== undefined) headers.set(name, value);
  headers.setContentType('application/json');
  if (
    ['Host', 'Content-Length', 'Transfer-Encoding'].some((name) =>
      headers.has(name),
    )
  )
    throw new AuthorizedSubmissionError('invalid');
  /** Normalizes header names and ordering for request identity comparison. */
  const headerIdentity = (value: typeof headers) =>
    JSON.stringify(
      Object.entries(value.toJSON())
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  const expectedHeaders = headerIdentity(headers);
  const route =
    target === 'node' ? '/transactions/bytes' : '/api/v0/transactions/send';
  // Axios preserves a base URL path prefix even when route begins with '/'.
  const fullUrl = axios.getUri({ baseURL: baseUrl, url: route });
  const baseAdapter = transport ?? getAdapter(axios.defaults.adapter);
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let closed = false;
  let adapterEntered = false;
  let started = false;
  let activeConfig: InternalAxiosRequestConfig | undefined;
  let rejectDeadline!: (error: AuthorizedSubmissionError) => void;
  const expired = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    closed = true;
    controller.abort();
    rejectDeadline(new AuthorizedSubmissionError('expired', activeConfig));
  }, timeoutMs);
  /** Rejects requests after this authorization window closes or expires. */
  const assertOpen = (config: InternalAxiosRequestConfig) => {
    if (closed || controller.signal.aborted || performance.now() >= deadline)
      throw new AuthorizedSubmissionError('expired', config);
  };
  /** Checks the captured request identity before entering its transport. */
  const assertRequest = (config: InternalAxiosRequestConfig) => {
    assertOpen(config);
    if (
      config.baseURL !== baseUrl ||
      config.url !== route ||
      config.method !== 'post' ||
      axios.getUri(config) !== fullUrl ||
      config.data !== wireBody ||
      config.headers.get('Content-Type') !== 'application/json' ||
      headerIdentity(config.headers) !== expectedHeaders ||
      config.signal !== controller.signal ||
      config.timeout !== timeoutMs ||
      config.maxRedirects !== 0 ||
      config.adapter !== adapter ||
      config.params !== undefined ||
      config.transport !== undefined ||
      config.socketPath !== undefined ||
      config.beforeRedirect !== undefined ||
      config.proxy !== undefined ||
      config.auth !== undefined ||
      config.httpAgent !== undefined ||
      config.httpsAgent !== undefined ||
      config.lookup !== undefined ||
      config.family !== undefined ||
      config.httpVersion !== undefined
    )
      throw new AuthorizedSubmissionError('invalid', config);
  };
  /** Runs one guarded adapter invocation inside the captured authorization. */
  const adapter: AxiosAdapter = async (config) => {
    activeConfig = config;
    if (adapterEntered) throw new AuthorizedSubmissionError('reused', config);
    adapterEntered = true;
    assertRequest(config);
    let response: ReturnType<AxiosAdapter> | undefined;
    let authorizing = true;
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          authorizeSubmit(() => {
            assertRequest(config);
            if (!authorizing || started)
              throw new AuthorizedSubmissionError('reused', config);
            started = true;
            response = baseAdapter(config);
            // An authorizer may reject after starting. Own late transport rejection.
            void response.catch(() => undefined);
          }),
        ),
        expired,
      ]);
    } catch (error) {
      if (error instanceof AuthorizedSubmissionError) throw error;
      throw new AuthorizedSubmissionError('denied', config, error);
    } finally {
      authorizing = false;
    }
    if (!started || !response)
      throw new AuthorizedSubmissionError('denied', config);
    return await response;
  };
  try {
    const client = createAxiosInstanceWithHeaders(baseUrl, {});
    await Promise.race([
      client({
        url: route,
        method: 'POST',
        headers,
        data: wireBody,
        transformRequest: [(data) => data],
        adapter,
        signal: controller.signal,
        timeout: timeoutMs,
        maxRedirects: 0,
      }),
      expired,
    ]);
  } finally {
    closed = true;
    controller.abort();
    clearTimeout(timer);
  }
};
