import { performance } from 'node:perf_hooks';

import {
  BoundSigningAction,
  TssAuthorizationRegistry,
  TssSigningKey,
} from '../../src/signing/tssAuthorizationRegistry';
import {
  registryKey as key,
  registryIdentity as identity,
} from './signingTestData';
import { binding } from './signingTestUtils';

describe('TssAuthorizationRegistry', () => {
  let registry: TssAuthorizationRegistry;
  let now: number;

  beforeEach(() => {
    now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    registry = new TssAuthorizationRegistry(1000, 2);
  });

  afterEach(() => vi.restoreAllMocks());

  const enqueue = (bound = binding(), digest = identity) =>
    registry.withContext(digest, bound, () =>
      registry.withAuthorization(digest, 'queue', async () => undefined),
    );

  describe('withAuthorization', () => {
    /**
     * @target TssAuthorizationRegistry.withAuthorization 'rejects unknown requests at %s without invoking the action'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Request each authorization phase without a local context, await rejection, and verify that its action never runs.
     * @expected rejects unknown requests at %s without invoking the action.
     */
    it.each(['queue', 'backend', 'outbound', 'result'] as const)(
      'rejects unknown requests at %s without invoking the action',
      async (phase) => {
        const action = vi.fn();
        await expect(async () =>
          registry.withAuthorization(identity, phase, action),
        ).rejects.toThrow();
        expect(action).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'reauthorizes each actual dispatch and result using the bound transaction'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue a bound transaction, dispatch backend, outbound and result actions in order, check each returned phase, and verify four bound-action authorizations.
     * @expected reauthorizes each actual dispatch and result using the bound transaction.
     */
    it('reauthorizes each actual dispatch and result using the bound transaction', async () => {
      const guarded = vi.fn(async (action: () => Promise<unknown>) => action());
      const bound = { ...binding(), withAction: guarded } as BoundSigningAction;
      await enqueue(bound);
      for (const phase of ['backend', 'outbound', 'result'] as const)
        await expect(
          registry.withAuthorization(identity, phase, async () => phase),
        ).resolves.toEqual(phase);
      expect(guarded).toHaveBeenCalledTimes(4);
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'a hold appearing after enqueue vetoes %s'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue while the binding allows actions, set the durable hold, request the selected phase, and verify rejection without invoking its action.
     * @expected a hold appearing after enqueue vetoes %s.
     */
    it.each(['backend', 'outbound', 'result'] as const)(
      'a hold appearing after enqueue vetoes %s',
      async (phase) => {
        let held = false;
        await enqueue({
          ...binding(),
          withAction: async (action) => {
            if (held) throw new Error('durable hold');
            return action();
          },
        });
        held = true;
        const action = vi.fn();
        await expect(async () =>
          registry.withAuthorization(identity, phase, action),
        ).rejects.toThrow('durable hold');
        expect(action).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'rejects an independently changed identity field'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue the original identity, change one identity field, request backend authorization, and verify rejection without dispatch.
     * @expected rejects an independently changed identity field.
     */
    it.each([
      { ...identity, chainCode: 'OtherKey' },
      { ...identity, derivationPath: [44, 60, 1, 0] },
      { ...identity, message: 'cd'.repeat(32) },
      { ...identity, algorithm: 'eddsa' as const, derivationPath: undefined },
    ])('rejects an independently changed identity field', async (changed) => {
      await enqueue();
      const action = vi.fn();
      await expect(async () =>
        registry.withAuthorization(changed, 'backend', action),
      ).rejects.toThrow('not authorized');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'rejects a different transaction or key rebinding an active digest'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue the original binding, then try a different transaction binding and a different key for the active digest; await both rebinding rejections.
     * @expected rejects a different transaction or key rebinding an active digest.
     */
    it('rejects a different transaction or key rebinding an active digest', async () => {
      await enqueue();
      await expect(async () =>
        enqueue(binding('22'.repeat(32))),
      ).rejects.toThrow('different transaction');
      await expect(async () =>
        enqueue(binding(), { ...identity, chainCode: 'DifferentKey' }),
      ).rejects.toThrow('different transaction');
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'does not extend the deadline when the same context enqueues again'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue at the initial clock value, enqueue the same context again at 1099, advance to 1100, and verify that backend authorization expires at the original deadline.
     * @expected does not extend the deadline when the same context enqueues again.
     */
    it('does not extend the deadline when the same context enqueues again', async () => {
      await enqueue();
      now = 1099;
      await enqueue();
      now = 1100;
      await expect(async () =>
        registry.withAuthorization(identity, 'backend', vi.fn()),
      ).rejects.toThrow('not authorized');
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'rechecks expiry after asynchronous qualification before dispatch'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue a binding whose asynchronous qualification can advance the clock, enable expiry during the next check, and verify rejection before backend dispatch.
     * @expected rechecks expiry after asynchronous qualification before dispatch.
     */
    it('rechecks expiry after asynchronous qualification before dispatch', async () => {
      let expireOnCheck = false;
      await enqueue({
        ...binding(),
        withAction: async (action) => {
          await Promise.resolve();
          if (expireOnCheck) now = 1100;
          return action();
        },
      });
      expireOnCheck = true;
      const action = vi.fn();
      await expect(async () =>
        registry.withAuthorization(identity, 'backend', action),
      ).rejects.toThrow('expired before dispatch');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'revokes failed enqueue work before any delayed backend attempt'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Throw during queue work inside the local context, await its failure, then verify that a delayed backend request has no authorization.
     * @expected revokes failed enqueue work before any delayed backend attempt.
     */
    it('revokes failed enqueue work before any delayed backend attempt', async () => {
      await expect(async () =>
        registry.withContext(key, binding(), () =>
          registry.withAuthorization(identity, 'queue', async () => {
            throw new Error('enqueue failed');
          }),
        ),
      ).rejects.toThrow('enqueue failed');
      await expect(async () =>
        registry.withAuthorization(identity, 'backend', vi.fn()),
      ).rejects.toThrow('not authorized');
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'contains capacity growth and reclaims expired authorizations'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Fill both authorization slots, reject a third digest, advance the clock to expire the entries, and enqueue the third digest successfully.
     * @expected contains capacity growth and reclaims expired authorizations.
     */
    it('contains capacity growth and reclaims expired authorizations', async () => {
      await enqueue();
      await enqueue(binding(), { ...identity, message: 'cd'.repeat(32) });
      await expect(async () =>
        enqueue(binding(), { ...identity, message: 'ef'.repeat(32) }),
      ).rejects.toThrow('capacity reached');
      now = 1100;
      await expect(
        enqueue(binding(), { ...identity, message: 'ef'.repeat(32) }),
      ).resolves.toBeUndefined();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'rejects an unknown phase even for an already authorized digest'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue the valid digest, request an unknown phase, await its validation error, and verify that the action never runs.
     * @expected rejects an unknown phase even for an already authorized digest.
     */
    it('rejects an unknown phase even for an already authorized digest', async () => {
      await enqueue();
      const action = vi.fn();
      await expect(async () =>
        registry.withAuthorization(identity, 'unknown' as never, action),
      ).rejects.toThrow('Invalid TSS authorization request');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'revokes a backend action already waiting for asynchronous qualification'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue the binding, pause the backend qualification on a barrier, wait until it enters, fail a second queue action to revoke the authorization, release the barrier, and verify the pending error and absent backend dispatch.
     * @expected revokes a backend action already waiting for asynchronous qualification.
     */
    it('revokes a backend action already waiting for asynchronous qualification', async () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let calls = 0;
      const bound: BoundSigningAction = {
        ...binding(),
        withAction: async (action) => {
          if (++calls === 2) {
            entered();
            await waiting;
          }
          return action();
        },
      };
      await enqueue(bound);
      const action = vi.fn();
      const pending = registry.withAuthorization(identity, 'backend', action);
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await inside;
      await expect(async () =>
        registry.withContext(key, bound, () =>
          registry.withAuthorization(identity, 'queue', async () => {
            throw new Error('revoked enqueue');
          }),
        ),
      ).rejects.toThrow('revoked enqueue');
      release();
      expect(await outcome).toMatchObject({
        message: 'TSS authorization expired before dispatch',
      });
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'supports EdDSA with an exact key and no derivation path'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue an exact EdDSA key without a path, authorize its backend action, and verify that the action returns true.
     * @expected supports EdDSA with an exact key and no derivation path.
     */
    it('supports EdDSA with an exact key and no derivation path', async () => {
      const eddsa = {
        algorithm: 'eddsa' as const,
        chainCode: 'SyntheticEdwardsKey',
        message: identity.message,
      };
      await enqueue(binding(), eddsa);
      await expect(
        registry.withAuthorization(eddsa, 'backend', async () => true),
      ).resolves.toEqual(true);
    });
  });

  describe('withContext', () => {
    /**
     * @target TssAuthorizationRegistry.withContext 'captures key and binding bytes before asynchronous caller mutation'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enter with mutable key and binding objects, mutate their key, path, binding ID and action inside the context, enqueue the captured identity, and verify that backend work still returns 7.
     * @expected captures key and binding bytes before asynchronous caller mutation.
     */
    it('captures key and binding bytes before asynchronous caller mutation', async () => {
      const mutableKey = { ...key, derivationPath: [44, 60, 0, 0] };
      const mutableBinding = { ...binding() };
      await registry.withContext(mutableKey, mutableBinding, async () => {
        mutableKey.chainCode = 'Changed';
        mutableKey.derivationPath[0] = 99;
        mutableBinding.bindingId = '22'.repeat(32);
        mutableBinding.withAction = async () => {
          throw new Error('mutated function');
        };
        await registry.withAuthorization(
          identity,
          'queue',
          async () => undefined,
        );
      });
      await expect(
        registry.withAuthorization(identity, 'backend', async () => 7),
      ).resolves.toEqual(7);
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'separates concurrent async transaction contexts'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue two distinct bindings and digests concurrently, then attempt to bind the second digest to the first transaction and await rejection.
     * @expected separates concurrent async transaction contexts.
     */
    it('separates concurrent async transaction contexts', async () => {
      const second = { ...identity, message: 'cd'.repeat(32) };
      await Promise.all([
        enqueue(binding()),
        enqueue(binding('22'.repeat(32)), second),
      ]);
      await expect(async () => enqueue(binding(), second)).rejects.toThrow(
        'different transaction',
      );
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'rejects a malformed key before running local work'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Pass each malformed key to the local context, check its synchronous identity error, and verify that local work never runs.
     * @expected rejects a malformed key before running local work.
     */
    it.each([
      { ...key, algorithm: 'unknown' },
      { ...key, chainCode: 7 },
      { ...key, chainCode: '' },
      { ...key, chainCode: ' spaced ' },
    ])('rejects a malformed key before running local work', (invalidKey) => {
      const action = vi.fn();
      expect(() =>
        registry.withContext(invalidKey as TssSigningKey, binding(), action),
      ).toThrow('Invalid TSS signing key identity');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'rejects an invalid ECDSA path'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Pass each invalid ECDSA path to the local context, check its synchronous path error, and verify that local work never runs.
     * @expected rejects an invalid ECDSA path.
     */
    it.each([
      undefined,
      '44/60',
      [],
      Array(256).fill(0),
      Array(1),
      [0.5],
      [-1],
      [2 ** 31],
      [NaN],
      [Infinity],
    ])('rejects an invalid ECDSA path', (derivationPath) => {
      const action = vi.fn();
      expect(() =>
        registry.withContext(
          { ...key, derivationPath } as TssSigningKey,
          binding(),
          action,
        ),
      ).toThrow('Invalid TSS derivation path');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'accepts the exact non-hardened path size and index boundaries'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enqueue an ECDSA identity with 255 path entries at the maximum non-hardened index and await successful admission.
     * @expected accepts the exact non-hardened path size and index boundaries.
     */
    it('accepts the exact non-hardened path size and index boundaries', async () => {
      const boundary = {
        ...identity,
        derivationPath: Array(255).fill(2 ** 31 - 1),
      };
      await expect(enqueue(binding(), boundary)).resolves.toBeUndefined();
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'rejects an EdDSA path even when empty'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Pass an EdDSA key with an empty derivation path, check its synchronous rejection, and verify that local work never runs.
     * @expected rejects an EdDSA path even when empty.
     */
    it('rejects an EdDSA path even when empty', () => {
      const action = vi.fn();
      expect(() =>
        registry.withContext(
          { algorithm: 'eddsa', chainCode: key.chainCode, derivationPath: [] },
          binding(),
          action,
        ),
      ).toThrow('EdDSA does not use a derivation path');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'rejects a malformed binding without running local work'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Pass each malformed bound transaction to the local context, check its synchronous binding error, and verify that local work never runs.
     * @expected rejects a malformed binding without running local work.
     */
    it.each([
      { ...binding(), bindingId: 1 },
      { ...binding(), bindingId: '' },
      { ...binding(), bindingId: 'AA'.repeat(32) },
      { ...binding(), withAction: undefined },
    ])('rejects a malformed binding without running local work', (invalid) => {
      const action = vi.fn();
      expect(() =>
        registry.withContext(key, invalid as BoundSigningAction, action),
      ).toThrow('Invalid local TSS transaction binding');
      expect(action).not.toHaveBeenCalled();
    });

    /**
     * @target TssAuthorizationRegistry.withContext 'rejects noncanonical message %s'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Enter a local context, attempt to queue each noncanonical message, await its request validation error, and verify that the queue action never runs.
     * @expected rejects noncanonical message %s.
     */
    it.each(['', 'ab', 'AB'.repeat(32), 'gg'.repeat(32)])(
      'rejects noncanonical message %s',
      async (message) => {
        const action = vi.fn();
        await expect(async () =>
          registry.withContext(key, binding(), () =>
            registry.withAuthorization(
              { ...identity, message },
              'queue',
              action,
            ),
          ),
        ).rejects.toThrow('Invalid TSS authorization request');
        expect(action).not.toHaveBeenCalled();
      },
    );
  });

  describe('constructor', () => {
    /**
     * @target TssAuthorizationRegistry.constructor 'rejects invalid limits %s/%s'
     * @dependencies Real registry and local bound actions; mocked monotonic clock.
     * @scenario Construct the registry with each lifetime and capacity pair and check the synchronous limit rejection.
     * @expected rejects invalid limits %s/%s.
     */
    it.each([
      [0, 2],
      [-1, 2],
      [0.5, 2],
      [Infinity, 2],
      [2147483648, 2],
      [1000, 0],
      [1000, 0.5],
      [1000, 10001],
    ])('rejects invalid limits %s/%s', (lifetime, capacity) => {
      expect(() => new TssAuthorizationRegistry(lifetime, capacity)).toThrow();
    });
  });
});
