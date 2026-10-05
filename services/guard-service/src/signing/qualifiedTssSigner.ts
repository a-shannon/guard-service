import { AxiosError } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import {
  EcdsaSigner,
  EddsaSigner,
  SignerConfig,
  SignResult,
  TssSigner,
} from '@rosen-bridge/tss';
import { Axios, getAdapter } from '@rosen-clients/rate-limited-axios';

export interface TssSigningIdentity {
  readonly message: string;
  readonly algorithm: 'ecdsa' | 'eddsa';
  readonly chainCode: string;
  readonly derivationPath?: readonly number[];
}

export type TssAuthorizationPhase = 'queue' | 'backend' | 'outbound' | 'result';

export interface TssAuthorizationPolicy {
  withAuthorization<T>(
    identity: TssSigningIdentity,
    phase: TssAuthorizationPhase,
    action: () => Promise<T>,
  ): Promise<T>;
}

export interface QualifiedTssOptions {
  policy: TssAuthorizationPolicy;
  signingTimeoutMs: number;
  httpTimeoutMs: number;
  maxPending: number;
}

interface Permit {
  identity: TssSigningIdentity;
  deadline: number;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  reject: (error: Error) => void;
  closed: boolean;
  enqueueFinished: boolean;
  queueStarted: boolean;
  cleaning: boolean;
  result?: SignResult;
  enqueueDone: Promise<void>;
  finishEnqueue: () => void;
  inFlight: number;
}

/** Creates the fixed rejection used for expired or unavailable dispatch authority. */
const expired = () => new Error('TSS authorization expired or unavailable');
/** Requires a positive safe integer within the configured bound. */
const integer = (value: number, maximum = 2147483647) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('Invalid qualified TSS bound');
};

/** Local permits authorize dispatch, never participation already accepted remotely. */
class DispatchAuthorization {
  private readonly permits = new Map<string, Permit>();
  private readonly attempts = new AsyncLocalStorage<
    ReadonlyMap<string, Permit>
  >();

  /** Retains the current permit scope until an action and its asynchronous work finish. */
  capture<T>(action: () => T): T {
    const scope = this.attempts.getStore() ?? new Map(this.permits);
    for (const permit of scope.values()) permit.inFlight++;
    /** Releases in-flight scope references and attempts cleanup of closed permits. */
    const release = () => {
      for (const permit of scope.values()) {
        permit.inFlight--;
        this.cleanup(permit);
      }
    };
    try {
      const result = this.attempts.run(scope, action);
      if (
        result &&
        typeof (result as unknown as Promise<unknown>).then === 'function'
      )
        return Promise.resolve(result).finally(release) as T;
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Returns the message permit captured by the current asynchronous attempt. */
  private captured(message: string): Permit | undefined {
    return this.attempts.getStore()?.get(message);
  }

  /** Captures detection callbacks in their permit scope and ignores expired callbacks. */
  bindRegistration(callback: (status: boolean, message?: string) => unknown) {
    const scope = this.attempts.getStore() ?? new Map(this.permits);
    return (status: boolean, message?: string): void => {
      if (
        [...scope.values()].some(
          (permit) => permit.closed || performance.now() >= permit.deadline,
        )
      )
        return;
      try {
        void Promise.resolve(
          this.attempts.run(scope, () =>
            this.capture(() => callback(status, message)),
          ),
        ).catch(() => undefined);
      } catch {
        /* The detection callback is not awaited by its caller. */
      }
    };
  }

  /** Captures signer options and validates timeout and pending-permit bounds. */
  constructor(
    private readonly algorithm: TssSigningIdentity['algorithm'],
    private readonly options: QualifiedTssOptions,
    private readonly remove: (message: string) => Promise<void>,
  ) {
    integer(options.signingTimeoutMs);
    integer(options.httpTimeoutMs);
    integer(options.maxPending, 1024);
  }

  /** Rejects a closed, replaced or expired permit. */
  private active(permit: Permit): void {
    if (
      permit.closed ||
      this.permits.get(permit.identity.message) !== permit ||
      performance.now() >= permit.deadline
    )
      throw expired();
  }

  /** Races work against permit cancellation and removes the abort listener afterward. */
  private bounded<T>(permit: Permit, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      /** Rejects work when its captured permit is aborted. */
      const stop = () => reject(expired());
      if (permit.abort.signal.aborted) {
        work.catch(() => undefined);
        reject(expired());
        return;
      }
      permit.abort.signal.addEventListener('abort', stop, { once: true });
      work.then(resolve, reject).finally(() => {
        permit.abort.signal.removeEventListener('abort', stop);
      });
    });
  }

  /** Checks permit liveness and invokes one policy-authorized action for the phase. */
  private authorize<T>(
    permit: Permit,
    phase: TssAuthorizationPhase,
    action: () => T | Promise<T>,
  ): Promise<T> {
    let invoked = false;
    return this.bounded(
      permit,
      Promise.resolve().then(() => {
        this.active(permit);
        return this.options.policy.withAuthorization(
          permit.identity,
          phase,
          async () => {
            this.active(permit);
            if (invoked)
              throw new Error('TSS authorization action already invoked');
            invoked = true;
            return this.bounded(
              permit,
              Promise.resolve().then(() => {
                this.active(permit);
                return action();
              }),
            );
          },
        );
      }),
    );
  }

  /** Removes a closed permit after enqueue and in-flight work finish, retaining failed tombstones. */
  private cleanup(permit: Permit): void {
    if (
      !permit.closed ||
      !permit.enqueueFinished ||
      permit.cleaning ||
      permit.inFlight
    )
      return;
    permit.cleaning = true;
    // Never await this from startSign: upstream may own its signing mutex.
    void this.remove(permit.identity.message)
      .then(() => {
        if (this.permits.get(permit.identity.message) === permit)
          this.permits.delete(permit.identity.message);
      })
      .catch(() => {
        // Retain the closed tombstone; a replacement must not race old cleanup.
      });
  }

  /** Closes and aborts the permit, rejects its result and attempts deferred cleanup. */
  private close(permit: Permit, error: unknown): void {
    if (permit.closed) {
      this.cleanup(permit);
      return;
    }
    permit.closed = true;
    clearTimeout(permit.timer);
    permit.abort.abort();
    permit.reject(error instanceof Error ? error : expired());
    this.cleanup(permit);
  }

  /** Records enqueue completion for the captured permit and retries eligible cleanup. */
  enqueued(message: string): void {
    const permit = this.captured(message);
    if (!permit) return;
    permit.enqueueFinished = true;
    permit.finishEnqueue();
    this.cleanup(permit);
  }

  /** Captures a validated signing identity and bounds queue launch and result authorization. */
  queue(
    message: string,
    chainCode: string,
    derivationPath: number[] | undefined,
    original: (identity: TssSigningIdentity) => Promise<SignResult>,
  ): Promise<SignResult> {
    if (
      typeof message !== 'string' ||
      !/^[0-9a-f]{64}$/.test(message) ||
      typeof chainCode !== 'string' ||
      chainCode.length === 0 ||
      chainCode.trim() !== chainCode ||
      (this.algorithm === 'ecdsa' && !Array.isArray(derivationPath)) ||
      (this.algorithm === 'eddsa' && derivationPath !== undefined) ||
      (derivationPath !== undefined &&
        (derivationPath.length < 1 ||
          derivationPath.length > 255 ||
          !Array.from(derivationPath).every(
            (index) =>
              Number.isSafeInteger(index) && index >= 0 && index <= 2147483647,
          )))
    )
      return Promise.reject(new Error('Invalid TSS signing identity'));
    if (
      this.permits.has(message) ||
      this.permits.size >= this.options.maxPending
    )
      return Promise.reject(
        new Error('TSS digest already authorized or capacity exhausted'),
      );
    const identity = Object.freeze({
      message,
      algorithm: this.algorithm,
      chainCode,
      derivationPath:
        derivationPath === undefined
          ? undefined
          : Object.freeze([...derivationPath]),
    });
    return new Promise<SignResult>((resolve, reject) => {
      let finishEnqueue!: () => void;
      const enqueueDone = new Promise<void>((done) => {
        finishEnqueue = done;
      });
      const permit: Permit = {
        identity,
        deadline: performance.now() + this.options.signingTimeoutMs,
        abort: new AbortController(),
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        reject,
        closed: false,
        enqueueFinished: false,
        queueStarted: false,
        cleaning: false,
        enqueueDone,
        finishEnqueue,
        inFlight: 0,
      };
      permit.timer = setTimeout(
        () => this.close(permit, expired()),
        this.options.signingTimeoutMs,
      );
      this.permits.set(message, permit);
      const queueAuthorization = this.authorize(permit, 'queue', () => {
        permit.queueStarted = true;
        // The queue authorization ends after launch, not after the signing result.
        void this.attempts
          .run(new Map([[message, permit]]), () => original(identity))
          .then(async (result) => {
            await queueAuthorization;
            const authorized = await this.authorize(
              permit,
              'result',
              () => result,
            );
            permit.result = Object.freeze({ ...authorized });
            resolve(authorized);
          })
          .catch((error) => this.close(permit, error));
        return permit.enqueueDone;
      });
      void queueAuthorization.catch((error) => {
        if (!permit.queueStarted) permit.enqueueFinished = true;
        this.close(permit, error);
      });
    });
  }

  /** Runs the captured backend-start action with bounded liveness and cleanup checks. */
  async start(
    message: string,
    original: () => ReturnType<TssSigner['startSign']>,
  ): Promise<void> {
    const permit = this.captured(message);
    if (!permit) return;
    try {
      this.active(permit);
      permit.inFlight++;
      const running = Promise.resolve()
        .then(original)
        .finally(() => {
          permit.inFlight--;
          this.cleanup(permit);
        });
      await this.bounded(permit, running);
    } catch (error) {
      this.close(permit, error instanceof Error ? error : expired());
    }
  }

  /** Dispatches supported signing envelopes only under their captured outbound permit. */
  async outbound(
    message: string,
    peers: string[],
    submit: SignerConfig['submitMsg'],
  ): Promise<void> {
    try {
      const envelope = JSON.parse(message);
      if (!['request', 'approve', 'start', 'cached'].includes(envelope.type))
        return;
      const permit = this.captured(envelope.payload?.msg);
      if (!permit) return;
      if (
        envelope.type === 'cached' &&
        (!permit.result ||
          envelope.payload.signature !== permit.result.signature ||
          envelope.payload.signatureRecovery !==
            permit.result.signatureRecovery)
      )
        return;
      await this.authorize(permit, 'outbound', () =>
        submit(message, [...peers]),
      );
    } catch {
      // Communicator does not await submitMsg; this boundary owns rejection.
    }
  }

  /** Wraps HTTP transport with deadlines and exact signing-identity authorization. */
  installHttp(client: Axios): void {
    const transport = getAdapter(client.defaults.adapter!);
    client.defaults.timeout = this.options.httpTimeoutMs;
    /** Bounds transport and requires a captured matching permit for signing requests. */
    client.defaults.adapter = async (config) => {
      try {
        const body =
          typeof config.data === 'string'
            ? JSON.parse(config.data)
            : config.data;
        config.timeout = this.options.httpTimeoutMs;
        const signal = AbortSignal.timeout(this.options.httpTimeoutMs);
        if (config.url !== 'sign') {
          config.signal = signal;
          return await transport(config);
        }
        const permit = this.captured(body?.message);
        if (
          !permit ||
          body.crypto !== permit.identity.algorithm ||
          body.chainCode !== permit.identity.chainCode ||
          JSON.stringify(body.derivationPath) !==
            JSON.stringify(permit.identity.derivationPath)
        )
          throw expired();
        config.signal = AbortSignal.any([signal, permit.abort.signal]);
        return await this.authorize(permit, 'backend', () => {
          if (config.signal?.aborted) throw expired();
          return transport(config);
        });
      } catch (error) {
        throw AxiosError.from(error, 'ERR_CANCELED', config);
      }
    };
  }
}

/** Unregistered adapter for the pinned ECDSA signer implementation. */
export class QualifiedEcdsaSigner extends EcdsaSigner {
  /** Wraps the ECDSA signer with local queue, transport and callback authorization. */
  constructor(config: SignerConfig, options: QualifiedTssOptions) {
    let dispatch: DispatchAuthorization;
    const detection = Object.create(
      config.detection,
    ) as SignerConfig['detection'];
    /** Registers peer detection callbacks in their captured permit scope. */
    detection.register = (peer, key, callback) =>
      config.detection.register(peer, key, dispatch.bindRegistration(callback));
    super({
      ...config,
      detection,
      /** Routes communicator submissions through the captured outbound authorization. */
      submitMsg: (message, peers) => {
        void dispatch.outbound(message, peers, config.submitMsg);
      },
    });
    dispatch = new DispatchAuthorization('ecdsa', options, (message) =>
      this.removeSign(message),
    );
    dispatch.installHttp(this.axios);
    const enqueue = this.sign;
    /** Marks the captured enqueue complete even when the upstream enqueue rejects. */
    this.sign = async (...args) => {
      try {
        await enqueue(...args);
      } finally {
        dispatch.enqueued(args[0]);
      }
    };
    const sign = this.signPromised;
    /** Queues the captured ECDSA identity and discards an old digest cache entry. */
    this.signPromised = (message, chainCode, path) =>
      dispatch.queue(message, chainCode, path, (identity) => {
        delete this.signCache[message];
        return sign(
          message,
          chainCode,
          identity.derivationPath === undefined
            ? undefined
            : [...identity.derivationPath],
        );
      });
    const start = this.startSign;
    /** Runs backend start under the captured dispatch scope. */
    this.startSign = (message, guards) =>
      dispatch.capture(() =>
        dispatch.start(message, () => start(message, guards)),
      );
    const send = this.sendMessage;
    /** Retains permit scope through the upstream message dispatch. */
    this.sendMessage = (...args) => dispatch.capture(() => send(...args));
    const process = this.processMessage;
    /** Retains permit scope through upstream inbound-message processing. */
    this.processMessage = (...args) => dispatch.capture(() => process(...args));
    const request = this.handleRequestMessage;
    /** Retains permit scope while owning rejection of upstream request processing. */
    this.handleRequestMessage = (...args) =>
      dispatch.capture(() => request(...args)).catch(() => undefined);
    const update = this.update;
    /** Retains permit scope during the upstream signer update. */
    this.update = () => dispatch.capture(update);
    const result = this.handleSignData;
    /** Retains permit scope while handling the upstream signing result. */
    this.handleSignData = (...args) => dispatch.capture(() => result(...args));
  }
}

/** Unregistered adapter for the pinned EdDSA signer implementation. */
export class QualifiedEddsaSigner extends EddsaSigner {
  /** Wraps the EdDSA signer with local queue, transport and callback authorization. */
  constructor(config: SignerConfig, options: QualifiedTssOptions) {
    let dispatch: DispatchAuthorization;
    const detection = Object.create(
      config.detection,
    ) as SignerConfig['detection'];
    /** Registers peer detection callbacks in their captured permit scope. */
    detection.register = (peer, key, callback) =>
      config.detection.register(peer, key, dispatch.bindRegistration(callback));
    super({
      ...config,
      detection,
      /** Routes communicator submissions through the captured outbound authorization. */
      submitMsg: (message, peers) => {
        void dispatch.outbound(message, peers, config.submitMsg);
      },
    });
    dispatch = new DispatchAuthorization('eddsa', options, (message) =>
      this.removeSign(message),
    );
    dispatch.installHttp(this.axios);
    const enqueue = this.sign;
    /** Marks the captured enqueue complete even when the upstream enqueue rejects. */
    this.sign = async (...args) => {
      try {
        await enqueue(...args);
      } finally {
        dispatch.enqueued(args[0]);
      }
    };
    const sign = this.signPromised;
    /** Queues the captured EdDSA identity and discards an old digest cache entry. */
    this.signPromised = (message, chainCode, path) =>
      dispatch.queue(message, chainCode, path, () => {
        delete this.signCache[message];
        return sign(message, chainCode, path);
      });
    const start = this.startSign;
    /** Runs backend start under the captured dispatch scope. */
    this.startSign = (message, guards) =>
      dispatch.capture(() =>
        dispatch.start(message, () => start(message, guards)),
      );
    const send = this.sendMessage;
    /** Retains permit scope through the upstream message dispatch. */
    this.sendMessage = (...args) => dispatch.capture(() => send(...args));
    const process = this.processMessage;
    /** Retains permit scope through upstream inbound-message processing. */
    this.processMessage = (...args) => dispatch.capture(() => process(...args));
    const request = this.handleRequestMessage;
    /** Retains permit scope while owning rejection of upstream request processing. */
    this.handleRequestMessage = (...args) =>
      dispatch.capture(() => request(...args)).catch(() => undefined);
    const update = this.update;
    /** Retains permit scope during the upstream signer update. */
    this.update = () => dispatch.capture(update);
    const result = this.handleSignData;
    /** Retains permit scope while handling the upstream signing result. */
    this.handleSignData = (...args) => dispatch.capture(() => result(...args));
  }
}
