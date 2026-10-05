import axios, { AxiosAdapter } from 'axios';

import { RateLimitedAxiosConfig } from '@rosen-clients/rate-limited-axios';

import {
  QualifiedEcdsaSigner,
  QualifiedTssOptions,
  TssAuthorizationPhase,
  TssAuthorizationPolicy,
  TssSigningIdentity,
} from '../../src/signing/qualifiedTssSigner';
import {
  createSignerConfig,
  createTransport,
} from './mocked/qualifiedTssSigner.mock';
import { emit, makeSigner, queueSigner } from './qualifiedTssSignerTestUtils';
import {
  signerMessage as message,
  nextSignerMessage as nextMessage,
  signerGuard as guard,
} from './signingTestData';
import { tick, wait } from './signingTestUtils';

const originalAdapter = axios.defaults.adapter;
let transport: ReturnType<typeof vi.fn>;
let submit: ReturnType<typeof vi.fn>;
let held: boolean;
let phases: TssAuthorizationPhase[];
let identities: TssSigningIdentity[];
let policy: TssAuthorizationPolicy;
const pending: Promise<unknown>[] = [];

beforeEach(() => {
  held = false;
  phases = [];
  identities = [];
  submit = vi.fn().mockResolvedValue(undefined);
  transport = createTransport();
  axios.defaults.adapter = transport as AxiosAdapter;
  policy = {
    withAuthorization: async (identity, phase, action) => {
      identities.push(identity);
      phases.push(phase);
      if (held) throw new Error('source held');
      return action();
    },
  };
});

afterEach(async () => {
  await Promise.all(pending.splice(0));
  axios.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

const config = () => createSignerConfig(submit);
const make = (
  algorithm: 'ecdsa' | 'eddsa' = 'ecdsa',
  overrides: Partial<QualifiedTssOptions> = {},
) => makeSigner(policy, submit, algorithm, overrides);
const queue = (
  signer: ReturnType<typeof make>,
  algorithm = 'ecdsa',
  msg = message,
) => queueSigner(pending, signer, algorithm, msg);

describe.each([
  ['QualifiedEcdsaSigner', 'ecdsa'],
  ['QualifiedEddsaSigner', 'eddsa'],
] as const)('%s', (_className, algorithm) => {
  describe('signPromised', () => {
    /**
     * @target QualifiedEcdsaSigner.signPromised / QualifiedEddsaSigner.signPromised `${algorithm}: admits only locally authorized queue identities and bounds queue-only waiting`
     * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
     * @scenario Queue the exact identity for the selected algorithm, wait for admission, verify queue phase and frozen identity, await the queue-only timeout, then verify the digest is no longer active.
     * @expected ${algorithm}: admits only locally authorized queue identities and bounds queue-only waiting.
     */
    it(`${algorithm}: admits only locally authorized queue identities and bounds queue-only waiting`, async () => {
      const signer = make(algorithm);
      const { outcome } = queue(signer, algorithm);
      await tick();
      expect(await signer.isInSign(message)).toEqual(true);
      expect(phases).toEqual(['queue']);
      expect(identities[0].algorithm).toEqual(algorithm);
      expect(Object.isFrozen(identities[0])).toEqual(true);
      expect(await outcome).toHaveProperty('error');
      await tick();
      expect(await signer.isInSign(message)).toEqual(false);
    });

    /**
     * @target QualifiedEcdsaSigner.signPromised / QualifiedEddsaSigner.signPromised `${algorithm}: freshly authorizes signature result delivery`
     * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
     * @scenario Queue the selected algorithm, wait for admission, introduce a hold, invoke the upstream success callback, and verify failed result delivery and fresh result authorization.
     * @expected ${algorithm}: freshly authorizes signature result delivery.
     */
    it(`${algorithm}: freshly authorizes signature result delivery`, async () => {
      const signer = make(algorithm);
      const { outcome } = queue(signer, algorithm);
      await tick();
      held = true;
      signer['signs'][0].callback(true, undefined, 'fixture-signature', '0');
      expect(await outcome).toHaveProperty('error');
      expect(phases).toContain('result');
    });

    if (algorithm === 'ecdsa') {
      /**
       * @target QualifiedEcdsaSigner.signPromised 'does not reuse a pre-existing digest-only upstream cache for another key'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Seed an upstream digest-only cache with an old-key signature, queue the current identity, wait for admission, and verify active signing, cache removal and queue authorization.
       * @expected does not reuse a pre-existing digest-only upstream cache for another key.
       */
      it('does not reuse a pre-existing digest-only upstream cache for another key', async () => {
        const signer = make();
        signer['signCache'][message] = {
          signature: 'old-key-signature',
          signatureRecovery: '0',
        };
        queue(signer);
        await tick();
        expect(await signer.isInSign(message)).toEqual(true);
        expect(signer['signCache'][message]).toBeUndefined();
        expect(phases).toEqual(['queue']);
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'copies the derivation path before asynchronous queue authorization'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Pause queue authorization on a barrier, submit a mutable derivation path, retain its pending result, mutate the caller path, release the barrier, wait for admission, and verify the queued path retains the original entries.
       * @expected copies the derivation path before asynchronous queue authorization.
       */
      it('copies the derivation path before asynchronous queue authorization', async () => {
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        policy.withAuthorization = async (_identity, phase, action) => {
          if (phase === 'queue') await barrier;
          return action();
        };
        const signer = make();
        const path = [44, 60];
        const result = signer
          .signPromised(message, 'fixture-chain', path)
          .catch(() => undefined);
        pending.push(result);
        path[0] = 999;
        release();
        await tick();
        expect(signer['signs'][0].derivationPath).toEqual([44, 60]);
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'prevents late queue authorization after expiry and allows a clean subsequent attempt'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Pause queue authorization on a barrier, queue with a 30 ms deadline, await expiry, release the barrier and verify no late active entry, then queue a clean retry, verify admission and await its bounded failure.
       * @expected prevents late queue authorization after expiry and allows a clean subsequent attempt.
       */
      it('prevents late queue authorization after expiry and allows a clean subsequent attempt', async () => {
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        policy.withAuthorization = async (_identity, phase, action) => {
          if (phase === 'queue') await barrier;
          return action();
        };
        const signer = make('ecdsa', { signingTimeoutMs: 30 });
        const { outcome } = queue(signer);
        await outcome;
        release();
        await tick();
        expect(await signer.isInSign(message)).toEqual(false);
        const retry = queue(signer);
        await tick();
        expect(await signer.isInSign(message)).toEqual(true);
        expect(await retry.outcome).toHaveProperty('error');
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'cleans a late enqueue before allowing reuse of its digest'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Acquire the upstream signing mutex, queue with a short deadline and await expiry, reject digest reuse while the old enqueue waits, release the mutex and verify cleanup, then retry and verify fresh admission.
       * @expected cleans a late enqueue before allowing reuse of its digest.
       */
      it('cleans a late enqueue before allowing reuse of its digest', async () => {
        const signer = make('ecdsa', { signingTimeoutMs: 30 });
        const release = await signer['signAccessMutex'].acquire();
        const { outcome } = queue(signer);
        await outcome;
        await expect(async () =>
          signer.signPromised(message, 'fixture-chain', [44]),
        ).rejects.toThrow('already authorized');
        release();
        await tick();
        expect(await signer.isInSign(message)).toEqual(false);
        queue(signer);
        await tick();
        expect(await signer.isInSign(message)).toEqual(true);
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'keeps queue authorization until enqueue finishes, without retaining it for the result'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Record policy completion after queue work, hold the upstream signing mutex, queue and verify no completed phase, release the mutex, wait, and verify queue completion and active signing.
       * @expected keeps queue authorization until enqueue finishes, without retaining it for the result.
       */
      it('keeps queue authorization until enqueue finishes, without retaining it for the result', async () => {
        const completed: string[] = [];
        policy.withAuthorization = async (_identity, phase, action) => {
          const result = await action();
          completed.push(phase);
          return result;
        };
        const signer = make();
        const release = await signer['signAccessMutex'].acquire();
        queue(signer);
        await tick();
        expect(completed).toEqual([]);
        release();
        await tick();
        expect(completed).toEqual(['queue']);
        expect(await signer.isInSign(message)).toEqual(true);
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'bounds concurrent permits and rejects malformed local identities'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Fill the single pending slot, reject a second digest for capacity, then try malformed digests, an empty key and a negative path, checking their identity rejections.
       * @expected bounds concurrent permits and rejects malformed local identities.
       */
      it('bounds concurrent permits and rejects malformed local identities', async () => {
        const signer = make('ecdsa', { maxPending: 1 });
        queue(signer);
        await expect(async () =>
          signer.signPromised(nextMessage, 'fixture-chain', [1]),
        ).rejects.toThrow('capacity');
        for (const digest of [
          '',
          'zz'.repeat(32),
          '11'.repeat(31),
          'AA'.repeat(32),
        ])
          await expect(async () =>
            signer.signPromised(digest, 'fixture-chain', [1]),
          ).rejects.toThrow('identity');
        await expect(async () =>
          signer.signPromised(nextMessage, '', [1]),
        ).rejects.toThrow('identity');
        await expect(async () =>
          signer.signPromised(nextMessage, 'key', [-1]),
        ).rejects.toThrow('identity');
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'does not authorize result delivery until the queue policy releases its lease'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Keep the queue lease active until its action and a later tick finish, queue and wait for admission, deliver the upstream callback, verify result authorization sees the lease released, and await the signature.
       * @expected does not authorize result delivery until the queue policy releases its lease.
       */
      it('does not authorize result delivery until the queue policy releases its lease', async () => {
        let queueLease = false;
        policy.withAuthorization = async (_identity, phase, action) => {
          if (phase === 'queue') {
            queueLease = true;
            try {
              return await action();
            } finally {
              await tick();
              queueLease = false;
            }
          }
          if (phase === 'result') expect(queueLease).toEqual(false);
          return action();
        };
        const signer = make();
        const { result } = queue(signer);
        await tick();
        signer['signs'][0].callback(true, undefined, 'fixture-signature', '0');
        await expect(result).resolves.toMatchObject({
          signature: 'fixture-signature',
        });
      });

      /**
       * @target QualifiedEcdsaSigner.signPromised 'accepts the pinned backend path length %s'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue each supported derivation-path length with a bounded deadline, retain the pending result, wait for admission, and verify the upstream path retains that exact length.
       * @expected accepts the pinned backend path length %s.
       */
      it.each([1, 33, 255])(
        'accepts the pinned backend path length %s',
        async (length) => {
          const signer = make('ecdsa', { signingTimeoutMs: 25 });
          const outcome = signer
            .signPromised(message, 'fixture-chain', Array(length).fill(0))
            .catch(() => undefined);
          pending.push(outcome);
          await tick();
          expect(signer['signs'][0].derivationPath).toHaveLength(length);
        },
      );

      /**
       * @target QualifiedEcdsaSigner.signPromised 'rejects empty sparse or oversized paths %j'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Attempt signing with each invalid derivation path and await identity rejection.
       * @expected rejects empty sparse or oversized paths %j.
       */
      it.each([[], Array(2), Array(256).fill(0)])(
        'rejects empty sparse or oversized paths %j',
        async (path) => {
          await expect(async () =>
            make().signPromised(message, 'fixture-chain', path),
          ).rejects.toThrow('identity');
        },
      );
    }
  });
  describe('processMessage', () => {
    /**
     * @target QualifiedEcdsaSigner.processMessage / QualifiedEddsaSigner.processMessage `${algorithm}: blocks peer backend start after hold without leaking the upstream mutex`
     * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
     * @scenario Queue the selected algorithm, wait for admission, introduce a hold and prepare the approved peer state, process the start envelope, verify no HTTP dispatch, and reacquire and release the signing mutex after backend authorization was attempted.
     * @expected ${algorithm}: blocks peer backend start after hold without leaking the upstream mutex.
     */
    it(`${algorithm}: blocks peer backend start after hold without leaking the upstream mutex`, async () => {
      const signer = make(algorithm);
      queue(signer, algorithm);
      await tick();
      held = true;
      signer.getGuardTurn = () => 0;
      signer['getApprovedGuards'] = async () => [guard];
      signer['threshold'] = { value: 1, expiry: Infinity };
      await signer.processMessage(
        'start',
        { msg: message, guards: [guard], signs: ['fixture'] },
        'verified-envelope',
        0,
        guard.peerId,
        1,
      );
      expect(transport).not.toHaveBeenCalled();
      const release = await signer['signAccessMutex'].acquire();
      release();
      expect(phases).toContain('backend');
    });

    if (algorithm === 'ecdsa') {
      /**
       * @target QualifiedEcdsaSigner.processMessage 'rejects unknown peer digests and all unapproved cached responses'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Start an unknown digest and emit cached and approval envelopes without local queue admission, verifying no HTTP, outbound submission or authorization phase.
       * @expected rejects unknown peer digests and all unapproved cached responses.
       */
      it('rejects unknown peer digests and all unapproved cached responses', async () => {
        const signer = make();
        await signer.startSign(message, [guard]);
        await emit(signer, 'cached', message, {
          signature: 'unapproved',
          signatureRecovery: '0',
        });
        await emit(signer, 'approve');
        expect(transport).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(phases).toEqual([]);
      });

      /**
       * @target QualifiedEcdsaSigner.processMessage 'rechecks a delayed peer registration approval at outbound dispatch'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue the digest, wait for admission, pause unknown-guard registration through its retry callback, process the request, introduce a hold, invoke the retry, and verify fresh outbound authorization without submission.
       * @expected rechecks a delayed peer registration approval at outbound dispatch.
       */
      it('rechecks a delayed peer registration approval at outbound dispatch', async () => {
        const signer = make();
        queue(signer);
        await tick();
        signer.getGuardTurn = () => 0;
        signer['getInvalidGuards'] = async () => [];
        let registered = false;
        let retry!: () => void;
        signer['getUnknownGuards'] = async () => (registered ? [] : [guard]);
        signer['detection'].register = async (_peer, _key, callback) => {
          retry = () => {
            registered = true;
            callback(true);
          };
        };
        await signer.processMessage(
          'request',
          { msg: message, guards: [guard] },
          'verified',
          0,
          guard.peerId,
          1,
        );
        held = true;
        retry();
        await tick();
        expect(phases).toContain('outbound');
        expect(submit).not.toHaveBeenCalled();
      });

      /**
       * @target QualifiedEcdsaSigner.processMessage 'blocks an actual cached peer reply after hold and refuses foreign cached bytes'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue and complete the authorized signature, install its cached result, process a peer request and verify one reply, repeat while held and then with foreign cached bytes, and verify neither sends another reply.
       * @expected blocks an actual cached peer reply after hold and refuses foreign cached bytes.
       */
      it('blocks an actual cached peer reply after hold and refuses foreign cached bytes', async () => {
        const signer = make();
        const { result } = queue(signer);
        await tick();
        signer['signs'][0].callback(true, undefined, 'fixture-signature', '0');
        await result;
        signer['signCache'][message] = {
          signature: 'fixture-signature',
          signatureRecovery: '0',
        };
        signer.getGuardTurn = () => 0;
        signer['getInvalidGuards'] = async () => [];
        const request = () =>
          signer.processMessage(
            'request',
            { msg: message, guards: [guard] },
            'verified',
            0,
            guard.peerId,
            1,
          );
        await request();
        await tick();
        expect(submit).toHaveBeenCalledOnce();
        held = true;
        await request();
        await tick();
        expect(submit).toHaveBeenCalledOnce();
        held = false;
        signer['signCache'][message].signature = 'foreign-key-signature';
        await request();
        await tick();
        expect(submit).toHaveBeenCalledOnce();
      });

      /**
       * @target QualifiedEcdsaSigner.processMessage 'binds delayed detection callbacks to the expired attempt instead of a renewed queue'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Capture a delayed guard-registration callback, queue and process the old request, await its expiry, queue a new attempt and update detection state, invoke the old retry, and verify no submission while the new attempt remains active.
       * @expected binds delayed detection callbacks to the expired attempt instead of a renewed queue.
       */
      it('binds delayed detection callbacks to the expired attempt instead of a renewed queue', async () => {
        let retry!: () => void;
        const cfg = config();
        cfg.detection.register = async (_peer, _key, callback) => {
          retry = () => {
            callback(true);
          };
        };
        const signer = new QualifiedEcdsaSigner(cfg, {
          policy,
          signingTimeoutMs: 35,
          httpTimeoutMs: 20,
          maxPending: 4,
        });
        const first = queue(signer);
        await tick();
        signer.getGuardTurn = () => 0;
        signer['getInvalidGuards'] = async () => [];
        signer['getUnknownGuards'] = async () => [guard];
        await signer.processMessage(
          'request',
          { msg: message, guards: [guard] },
          'verified',
          0,
          guard.peerId,
          1,
        );
        await first.outcome;
        await tick();
        queue(signer);
        await tick();
        signer['getUnknownGuards'] = async () => [];
        retry();
        await tick();
        expect(submit).not.toHaveBeenCalled();
        expect(await signer.isInSign(message)).toEqual(true);
      });
    }
  });
  describe('startSign', () => {
    /**
     * @target QualifiedEcdsaSigner.startSign / QualifiedEddsaSigner.startSign `${algorithm}: dispatches exact backend identity with an effective HTTP timeout and abort signal`
     * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
     * @scenario Queue the selected algorithm, wait for admission, start signing, and verify one HTTP request with the exact message, algorithm, key, timeout and abort signal plus backend authorization.
     * @expected ${algorithm}: dispatches exact backend identity with an effective HTTP timeout and abort signal.
     */
    it(`${algorithm}: dispatches exact backend identity with an effective HTTP timeout and abort signal`, async () => {
      const signer = make(algorithm);
      queue(signer, algorithm);
      await tick();
      await signer.startSign(message, [guard]);
      expect(transport).toHaveBeenCalledOnce();
      const request = transport.mock.calls[0][0];
      expect(request.timeout).toEqual(40);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(request.data)).toMatchObject({
        message,
        crypto: algorithm,
        chainCode: 'fixture-chain',
      });
      expect(phases).toContain('backend');
    });

    if (algorithm === 'ecdsa') {
      /**
       * @target QualifiedEcdsaSigner.startSign 'rejects mismatched backend key material and repeated digest attempts'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue the identity, wait for admission, reject the same digest under another key and path, mutate the queued backend key, start signing, and verify no HTTP dispatch.
       * @expected rejects mismatched backend key material and repeated digest attempts.
       */
      it('rejects mismatched backend key material and repeated digest attempts', async () => {
        const signer = make();
        queue(signer);
        await tick();
        await expect(async () =>
          signer.signPromised(message, 'another-key', [1]),
        ).rejects.toThrow('already authorized');
        signer['signs'][0].chainCode = 'another-key';
        await signer.startSign(message, [guard]);
        expect(transport).not.toHaveBeenCalled();
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'rejects a backend request with only %s changed'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue the digest, wait for admission, intercept its HTTP request to change the selected algorithm or derivation-path field, start signing, and verify no backend transport call.
       * @expected rejects a backend request with only %s changed.
       */
      it.each(['crypto', 'derivationPath'] as const)(
        'rejects a backend request with only %s changed',
        async (field) => {
          const signer = make();
          queue(signer);
          await tick();
          signer['axios'].interceptors.request.use((request) => {
            if (request.url === 'sign') {
              request.data = {
                ...request.data,
                [field]: field === 'crypto' ? 'eddsa' : [44, 61],
              };
            }
            return request;
          });
          await signer.startSign(message, [guard]);
          expect(transport).not.toHaveBeenCalled();
        },
      );

      /**
       * @target QualifiedEcdsaSigner.startSign 'expires backend and cached sends even after a successful result'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Queue and deliver a signature before its deadline, await its result, wait beyond expiry, attempt backend signing and a cached reply, and verify neither HTTP nor outbound submission occurs.
       * @expected expires backend and cached sends even after a successful result.
       */
      it('expires backend and cached sends even after a successful result', async () => {
        const signer = make('ecdsa', { signingTimeoutMs: 30 });
        const { result } = queue(signer);
        await tick();
        signer['signs'][0].callback(true, undefined, 'fixture-signature', '0');
        await result;
        await wait(40);
        await signer.startSign(message, [guard]);
        await emit(signer, 'cached', message, {
          signature: 'fixture-signature',
          signatureRecovery: '0',
        });
        expect(transport).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'aborts a stalled HTTP adapter and releases the upstream start mutex'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Make backend HTTP stall until its abort signal fires, queue and wait for admission, hold the signing mutex, start signing and await completion, release the mutex, and verify an aborted request and failed signing outcome.
       * @expected aborts a stalled HTTP adapter and releases the upstream start mutex.
       */
      it('aborts a stalled HTTP adapter and releases the upstream start mutex', async () => {
        transport.mockImplementation(
          (config) =>
            new Promise((_resolve, reject) => {
              config.signal.addEventListener(
                'abort',
                () => reject(new Error('HTTP aborted')),
                { once: true },
              );
            }),
        );
        const signer = make();
        const { outcome } = queue(signer);
        await tick();
        const release = await signer['signAccessMutex'].acquire();
        await signer.startSign(message, [guard]);
        release();
        expect(transport.mock.calls[0][0].signal.aborted).toEqual(true);
        expect(await outcome).toHaveProperty('error');
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'does not dispatch after an asynchronous HTTP interceptor outlives the permit'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Delay the HTTP request interceptor beyond the signing deadline, queue and wait for admission, start signing and wait beyond the delay, then verify no backend transport call.
       * @expected does not dispatch after an asynchronous HTTP interceptor outlives the permit.
       */
      it('does not dispatch after an asynchronous HTTP interceptor outlives the permit', async () => {
        const signer = make('ecdsa', { signingTimeoutMs: 30 });
        signer['axios'].interceptors.request.use(async (request) => {
          await wait(50);
          return request;
        });
        queue(signer);
        await tick();
        await signer.startSign(message, [guard]);
        await wait(60);
        expect(transport).not.toHaveBeenCalled();
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'does not dispatch after backend authorization exceeds its HTTP deadline'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Delay backend qualification beyond the HTTP deadline, queue and wait for admission, start signing, and verify that the expired permit prevents transport dispatch.
       * @expected does not dispatch after backend authorization exceeds its HTTP deadline.
       */
      it('does not dispatch after backend authorization exceeds its HTTP deadline', async () => {
        policy.withAuthorization = async (_identity, phase, action) => {
          if (phase === 'backend') await wait(60);
          return action();
        };
        const signer = make();
        queue(signer);
        await tick();
        await signer.startSign(message, [guard]);
        expect(transport).not.toHaveBeenCalled();
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'quarantines an expired digest until old HTTP work settles before retry'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Pause the HTTP interceptor on a barrier, queue with a short deadline and start signing, await expiry and the old start, reject reuse while quarantined, release the barrier and verify no transport after two ticks, remove the interceptor, then retry and verify one fresh HTTP call.
       * @expected quarantines an expired digest until old HTTP work settles before retry.
       */
      it('quarantines an expired digest until old HTTP work settles before retry', async () => {
        const signer = make('ecdsa', { signingTimeoutMs: 35 });
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const interceptor = signer['axios'].interceptors.request.use(
          async (request) => {
            await barrier;
            return request;
          },
        );
        const first = queue(signer);
        await tick();
        const oldStart = signer.startSign(message, [guard]);
        await first.outcome;
        await oldStart;
        await expect(async () =>
          signer.signPromised(message, 'fixture-chain', [44]),
        ).rejects.toThrow('already authorized');
        release();
        await tick();
        await tick();
        expect(transport).not.toHaveBeenCalled();
        signer['axios'].interceptors.request.eject(interceptor);
        queue(signer);
        await tick();
        expect(await signer.isInSign(message)).toEqual(true);
        await signer.startSign(message, [guard]);
        expect(transport).toHaveBeenCalledOnce();
      });

      /**
       * @target QualifiedEcdsaSigner.startSign 'releases the real rate-limit slot immediately after authorization denial'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Register a local rate-limit rule, queue and wait for admission, introduce a hold and deny signing, race an actual rate-limited threshold request against a timeout, verify the slot remains available, and remove the rule in finally.
       * @expected releases the real rate-limit slot immediately after authorization denial.
       */
      it('releases the real rate-limit slot immediately after authorization denial', async () => {
        const pattern = '^http://127\\.0\\.0\\.1:1/';
        RateLimitedAxiosConfig.addRule(pattern, 1, 0, 60);
        try {
          const signer = make();
          queue(signer);
          await tick();
          held = true;
          await signer.startSign(message, [guard]);
          const result = await Promise.race([
            signer['axios'].get('threshold').then(() => 'released'),
            wait(100).then(() => 'blocked'),
          ]);
          expect(result).toEqual('released');
        } finally {
          RateLimitedAxiosConfig.removeRule(pattern);
        }
      });
    }
  });
  if (algorithm === 'ecdsa') {
    describe('sendMessage', () => {
      /**
       * @target QualifiedEcdsaSigner.sendMessage 'gates final outbound %s including delayed invocations and contains rejection'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario For each outbound envelope type, queue and complete the signature, send once, introduce a hold and verify no second submission, remove the hold and make submission reject, then verify that rejection is contained after the second attempt.
       * @expected gates final outbound %s including delayed invocations and contains rejection.
       */
      it.each(['request', 'approve', 'start', 'cached'])(
        'gates final outbound %s including delayed invocations and contains rejection',
        async (type) => {
          const signer = make();
          const { result } = queue(signer);
          await tick();
          signer['signs'][0].callback(
            true,
            undefined,
            'fixture-signature',
            '0',
          );
          await result;
          const extra = {
            signature: 'fixture-signature',
            signatureRecovery: '0',
          };
          await emit(signer, type, message, extra);
          expect(submit).toHaveBeenCalledOnce();
          held = true;
          await emit(signer, type, message, extra);
          expect(submit).toHaveBeenCalledOnce();
          held = false;
          submit.mockRejectedValue(new Error('transport rejected'));
          await emit(signer, type, message, extra);
          expect(submit).toHaveBeenCalledTimes(2);
        },
      );

      /**
       * @target QualifiedEcdsaSigner.sendMessage 'does not let an old delayed outbound envelope acquire a renewed permit'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Pause envelope signing on a barrier, queue and begin an old outbound send, await expiry and reject reuse, release the barrier and verify no stale submission, then queue a fresh attempt and verify one approval submission.
       * @expected does not let an old delayed outbound envelope acquire a renewed permit.
       */
      it('does not let an old delayed outbound envelope acquire a renewed permit', async () => {
        const signer = make('ecdsa', { signingTimeoutMs: 35 });
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = queue(signer);
        await tick();
        signer.signPayload = async () => {
          await barrier;
          return 'old-envelope';
        };
        const oldSend = signer['sendMessage']('approve', { msg: message }, [
          guard.peerId,
        ]);
        await first.outcome;
        await expect(async () =>
          signer.signPromised(message, 'fixture-chain', [44]),
        ).rejects.toThrow('already authorized');
        release();
        await oldSend;
        await tick();
        expect(submit).not.toHaveBeenCalled();
        queue(signer);
        await tick();
        await emit(signer, 'approve');
        expect(submit).toHaveBeenCalledOnce();
      });
    });
  }
  if (algorithm === 'ecdsa') {
    describe('constructor', () => {
      /**
       * @target QualifiedEcdsaSigner.constructor 'rejects invalid configured bounds %s'
       * @dependencies Real qualified and installed upstream signers; mocked Axios HTTP, detection, envelope and authorization boundary.
       * @scenario Construct the signer with each invalid timeout or capacity value independently and check the corresponding synchronous bounds errors.
       * @expected rejects invalid configured bounds %s.
       */
      it.each([0, -1, NaN, Infinity, 0.5, 2147483648])(
        'rejects invalid configured bounds %s',
        (value) => {
          expect(() => make('ecdsa', { signingTimeoutMs: value })).toThrow(
            'bound',
          );
          expect(() => make('ecdsa', { httpTimeoutMs: value })).toThrow(
            'bound',
          );
          expect(() => make('ecdsa', { maxPending: value })).toThrow('bound');
        },
      );
    });
  }
});
