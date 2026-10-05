import axios, { AxiosAdapter, AxiosHeaders } from 'axios';
import { Transaction } from 'ethers';

import { AvalancheSafetyState } from '@rosen-bridge/evm-scanner';
import type { SignerConfig } from '@rosen-bridge/tss';
import { TransactionType } from '@rosen-chains/abstract-chain';

import { QualifiedEcdsaSigner } from '../../src/signing/qualifiedTssSigner';
import { createManagementSigningFixture } from './avalancheManagementSigningTestUtils';

describe('TransactionSigningContext', () => {
  const fixtures: Awaited<ReturnType<typeof createManagementSigningFixture>>[] =
    [];

  const originalAdapter = axios.defaults.adapter;

  const pending: Promise<unknown>[] = [];

  /** Binds one native signing context and registers its SQLite/scanner cleanup. */
  const setup = async (type = TransactionType.coldStorage, token = false) => {
    const f = await createManagementSigningFixture(type, token);
    fixtures.push(f);
    return f;
  };

  afterEach(async () => {
    await Promise.all(pending.splice(0));
    axios.defaults.adapter = originalAdapter;
    await Promise.all(fixtures.splice(0).map((f) => f.close()));
    vi.restoreAllMocks();
  });

  /** Constructs the actual installed signer with synthetic peers and an inert HTTP adapter. */
  const queueInstalledSigner = async (f: Awaited<ReturnType<typeof setup>>) => {
    const guard = {
      publicKey: 'fixture-guard',
      peerId: 'fixture-peer',
      index: 0,
    };
    const transport = vi.fn<AxiosAdapter>(async (config) => {
      await expect(f.scanner.update()).rejects.toThrow('already running');
      return {
        data: {},
        status: 200,
        statusText: 'OK',
        headers: new AxiosHeaders(),
        config,
      };
    });
    axios.defaults.adapter = transport;
    const config: SignerConfig = {
      tssApiUrl: 'http://127.0.0.1:1',
      callbackUrl: 'http://127.0.0.1:1',
      guardsPk: [guard.publicKey],
      shares: ['fixture-share'],
      getPeerId: async () => guard.peerId,
      messageEnc: {
        getPk: async () => guard.publicKey,
        sign: async () => 'fixture-envelope-signature',
        verify: async () => true,
      } as unknown as SignerConfig['messageEnc'],
      detection: {} as SignerConfig['detection'],
      submitMsg: vi.fn().mockResolvedValue(undefined),
      timeoutSeconds: 10,
    };
    const signer = new QualifiedEcdsaSigner(config, {
      policy: f.runtime.registry,
      signingTimeoutMs: 500,
      httpTimeoutMs: 100,
      maxPending: 2,
    });
    signer.getGuardTurn = () => 0;
    signer['getApprovedGuards'] = async () => [guard];
    signer['threshold'] = { value: 1, expiry: Infinity };
    f.chain['signMediator'].sign = async (bytes) => {
      const result = await f.runtime.context.withTssKey(f.key, () =>
        signer.signPromised(
          Buffer.from(bytes).toString('hex'),
          f.key.chainCode,
          [...f.key.derivationPath],
        ),
      );
      return {
        signature: result.signature,
        signatureRecovery: result.signatureRecovery!,
      };
    };
    const outcome = f.runtime.context
      .run(f.bound, () =>
        f.chain.signTransaction(f.bound.payment(), f.bound.requiredSign),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error: error as Error }),
      );
    pending.push(outcome);
    await vi.waitFor(() => expect(signer['signs']).toHaveLength(1));
    await vi.waitFor(async () => {
      await expect(f.scanner.withSafety(() => true)).resolves.toEqual(true);
    });
    return {
      signer,
      transport,
      outcome,
      start: () =>
        signer.processMessage(
          'start',
          { msg: f.identity.message, guards: [guard], signs: ['fixture'] },
          'verified-envelope',
          0,
          guard.peerId,
          1,
        ),
    };
  };
  describe('withTssKey', () => {
    /**
     * @target TransactionSigningContext.withTssKey joins mainnet JOE %s to retained backend authorization
     * @dependencies Actual chain, mainnet SQLite scanner, installed qualified signer and synthetic HTTP/signature result
     * @scenario Queue an admitted token route, authorize backend dispatch and supply the exact custody signature
     * @expected Only the original token bytes become signed and scanner exclusion is released
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'joins mainnet JOE %s to retained backend authorization',
      async (type) => {
        const f = await setup(type, true);
        const { signer, transport, start, outcome } =
          await queueInstalledSigner(f);
        await start();
        expect(transport).toHaveBeenCalledOnce();
        const signature = Transaction.from(
          '0x' + Buffer.from(f.signed().txBytes).toString('hex'),
        ).signature!;
        signer['signs'][0].callback(
          true,
          undefined,
          signature.r.slice(2) + signature.s.slice(2),
          String(signature.yParity),
        );
        const result = await outcome;
        expect(result).toHaveProperty('value');
        if (!('value' in result)) throw result.error;
        expect(result.value.toJson()).toEqual(f.signed().toJson());
        await expect(f.scanner.update()).resolves.toBeUndefined();
      },
    );

    /**
     * @target TransactionSigningContext.withTssKey refuses JOE backend dispatch after AVAX reserve loss
     * @dependencies Actual retained cold authorization and synthetic installed signer transport
     * @scenario Consume the AVAX gas floor after token queue admission and before backend start
     * @expected No HTTP dispatch and a rejected signing result while scanner operation resumes
     */
    it('refuses JOE backend dispatch after AVAX reserve loss', async () => {
      const f = await setup(TransactionType.coldStorage, true);
      const { transport, start, outcome } = await queueInstalledSigner(f);
      f.cold.locked.nativeToken = 939999n;
      await start();
      expect(await outcome).toHaveProperty('error');
      expect(transport).not.toHaveBeenCalled();
      await expect(f.scanner.update()).resolves.toBeUndefined();
    });
    /**
     * @target TransactionSigningContext.withTssKey joins actual native %s queue, backend HTTP and signed result
     * @dependencies
     * - Real Avalanche adapter, QualifiedEcdsaSigner, current-policy registry and SQLite scanner.
     * - Inert HTTP adapter, synthetic peers and deterministic public test signing key.
     * @scenario
     * - Queue the actual chain sign request, start its backend and provide a synthetic signature result.
     * @expected
     * - The captured native bytes are signed by the configured test lock key after each authorization.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'joins actual native %s queue, backend HTTP and signed result',
      async (type) => {
        const f = await setup(type);
        const { signer, transport, start, outcome } =
          await queueInstalledSigner(f);
        await start();
        expect(transport).toHaveBeenCalledOnce();
        expect(JSON.parse(transport.mock.calls[0][0].data)).toMatchObject({
          message: f.identity.message,
          chainCode: f.key.chainCode,
          derivationPath: f.key.derivationPath,
        });
        const sig = Transaction.from(
          '0x' + Buffer.from(f.signed().txBytes).toString('hex'),
        ).signature!;
        signer['signs'][0].callback(
          true,
          undefined,
          sig.r.slice(2) + sig.s.slice(2),
          String(sig.yParity),
        );
        const result = await outcome;
        expect(result).toHaveProperty('value');
        if (!('value' in result)) throw result.error;
        expect(result.value.toJson()).toEqual(f.signed().toJson());
        await expect(f.scanner.update()).resolves.toBeUndefined();
      },
    );

    /**
     * @target TransactionSigningContext.withTssKey refuses native management backend dispatch after reserve loss
     * @dependencies
     * - Actual native adapter and installed qualified backend path with synthetic transport.
     * @scenario
     * - Consume the cold reserve after queue admission and before the peer starts signing.
     * @expected
     * - No backend HTTP starts and the pending chain-sign promise rejects.
     */
    it('refuses native management backend dispatch after reserve loss', async () => {
      const f = await setup();
      const { transport, start, outcome } = await queueInstalledSigner(f);
      f.cold.locked.nativeToken = 1600000n;
      await start();
      expect(await outcome).toHaveProperty('error');
      expect(transport).not.toHaveBeenCalled();
      await expect(f.scanner.update()).resolves.toBeUndefined();
    });

    /**
     * @target TransactionSigningContext.withTssKey authorizes native %s signing phases through the real adapter
     * @dependencies
     * - Actual package fee/envelope validation, SQLite scanner, signing context and TSS registry.
     * - Synthetic RPC acquisition and admitted-row/order/balance ports; no live signer.
     * @scenario
     * - Execute all five prepared phases and all four registry dispatch phases.
     * @expected
     * - Each effect retains scanner exclusion and current native policy; updates resume afterward.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])(
      'authorizes native %s signing phases through the real adapter',
      async (type) => {
        const f = await setup(type);
        const prepared = await f.bound.prepareSigningAuthorization();
        const count = vi.fn();
        for (const phase of [
          'queue',
          'commitment',
          'sign',
          'outbound',
          'result',
        ] as const)
          await prepared.withAction(phase, count);
        const effect = vi.fn(async () => {
          await expect(f.scanner.update()).rejects.toThrow('already running');
        });
        await f.runtime.context.run(f.bound, () =>
          f.runtime.context.withTssKey(f.key, () =>
            f.runtime.registry.withAuthorization(f.identity, 'queue', effect),
          ),
        );
        for (const phase of ['backend', 'outbound', 'result'] as const)
          await f.runtime.registry.withAuthorization(f.identity, phase, effect);
        expect(count).toHaveBeenCalledTimes(5);
        expect(effect).toHaveBeenCalledTimes(4);
        expect(f.gas).toHaveBeenCalledTimes(9);
        await expect(f.scanner.update()).resolves.toBeUndefined();
      },
    );

    /**
     * @target TransactionSigningContext.withTssKey refuses reserve loss at registry %s
     * @dependencies
     * - Actual runtime, fee checker, registry and SQLite safety lease.
     * @scenario
     * - Admit a queue, then consume only enough native balance to cross the low reserve.
     * @expected
     * - Every later effect refuses, with no dispatched callback and no leaked scanner lease.
     */
    it.each(['backend', 'outbound', 'result'] as const)(
      'refuses reserve loss at registry %s',
      async (phase) => {
        const f = await setup();
        await f.runtime.context.run(f.bound, () =>
          f.runtime.context.withTssKey(f.key, () =>
            f.runtime.registry.withAuthorization(
              f.identity,
              'queue',
              async () => undefined,
            ),
          ),
        );
        f.cold.locked.nativeToken = 1600000n;
        const effect = vi.fn();
        await expect(
          f.runtime.registry.withAuthorization(f.identity, phase, effect),
        ).rejects.toThrow('reserve');
        expect(effect).not.toHaveBeenCalled();
        await expect(f.scanner.update()).resolves.toBeUndefined();
      },
    );

    /**
     * @target TransactionSigningContext.withTssKey refuses a persistent hold before a native TSS queue
     * @dependencies
     * - Actual SQLite scanner hold and runtime registry admission.
     * @scenario
     * - Add a durable hold after binding but before dispatch admission.
     * @expected
     * - The queue callback never executes.
     */
    it('refuses a persistent hold before a native TSS queue', async () => {
      const f = await setup(TransactionType.manual);
      await f.database
        .getRepository(AvalancheSafetyState)
        .update(
          { scanner: 'avalanche' },
          { holdReason: 'synthetic-management-hold' },
        );
      const effect = vi.fn();
      await expect(
        f.runtime.context.run(f.bound, () =>
          f.runtime.context.withTssKey(f.key, () =>
            f.runtime.registry.withAuthorization(f.identity, 'queue', effect),
          ),
        ),
      ).rejects.toThrow('not qualified');
      expect(effect).not.toHaveBeenCalled();
    });
  });
  describe('persistResult', () => {
    /**
     * @target TransactionSigningContext.persistResult validates a native signed body before persistence
     * @dependencies
     * - Real native decoder, synthetic key, signed-envelope checker, runtime and SQLite lease.
     * - Persistence callback spy; database transition is a separate consumer join.
     * @scenario
     * - Submit the exact signed native result captured from the current in-sign row.
     * @expected
     * - The callback receives the signed envelope only after native result and fee authorization.
     */
    it('validates a native signed body before persistence', async () => {
      const f = await setup();
      const persist = vi.fn();
      await f.runtime.context.persistResult(f.bound, f.signed(), persist);
      expect(persist).toHaveBeenCalledOnce();
    });
  });
});
