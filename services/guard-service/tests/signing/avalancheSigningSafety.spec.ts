import '@rosen-bridge/extended-typeorm/bootstrap';

import axios, { AxiosAdapter, AxiosHeaders } from 'axios';
import { blake2b } from 'blakejs';

import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations,
} from '@rosen-bridge/abstract-scanner';
import {
  AvalancheRpcNetwork,
  AvalancheRpcScanner,
  AvalancheSafetyState,
  AvalancheSafetyState1790769600000,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { SignerConfig } from '@rosen-bridge/tss';
import { TransactionType } from '@rosen-chains/abstract-chain';

import { QualifiedEcdsaSigner } from '../../src/signing/qualifiedTssSigner';
import { TssAuthorizationRegistry } from '../../src/signing/tssAuthorizationRegistry';
import {
  AvalancheTransactionEvent,
  AvalancheTransactionIntent,
  AvalancheTransactionSafety,
  BoundAvalancheTransaction,
} from '../../src/utils/avalancheTransactionSafety';

const hash = (height: number) => '0x' + height.toString(16).padStart(64, '0');
const digest = (value: string) =>
  Buffer.from(blake2b(value, undefined, 32)).toString('hex');
const key = {
  algorithm: 'ecdsa' as const,
  chainCode: 'SyntheticChainCode',
  derivationPath: [44, 60, 0, 0],
};

describe.each(['source', 'destination'] as const)(
  'Avalanche %s registry and action safety join',
  (direction) => {
    let database: DataSource;
    let network: AvalancheRpcNetwork;
    let scanner: AvalancheRpcScanner;
    let event: AvalancheTransactionEvent;
    let intent: AvalancheTransactionIntent;
    let bound: BoundAvalancheTransaction;
    let registry: TssAuthorizationRegistry;
    const originalAdapter = axios.defaults.adapter;
    const pending: Promise<unknown>[] = [];
    const guard = {
      publicKey: 'fixture-guard',
      peerId: 'fixture-peer',
      index: 0,
    };

    const identity = () => ({ ...key, message: digest(bound.intent.txBytes) });
    const enqueue = () =>
      registry.withContext(key, bound, () =>
        registry.withAuthorization(identity(), 'queue', async () => undefined),
      );

    beforeEach(async () => {
      database = await new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: [BlockEntity, ExtractorStatusEntity, AvalancheSafetyState],
        migrations: [...migrations.sqlite, AvalancheSafetyState1790769600000],
        synchronize: false,
      }).initialize();
      await database.runMigrations();
      network = new AvalancheRpcNetwork('http://127.0.0.1:1', 43113n);
      vi.spyOn(network, 'getCurrentHeight').mockResolvedValue(2);
      vi.spyOn(network, 'getBlockAtHeight').mockImplementation(
        async (height) => ({
          hash: hash(height),
          height,
          parentHash: hash(height - 1),
          timestamp: 100 + height,
          txCount: 0,
        }),
      );
      vi.spyOn(network, 'getBlockTxs').mockResolvedValue([]);
      scanner = new AvalancheRpcScanner({
        network,
        dataSource: database,
        sourceId: 'synthetic-signing-source',
        initialHeight: 0,
        blockCleanupConfig: {
          blockCleanupThresholdDuration: 86400,
          blockTrimCountInRound: 0,
        },
      });
      await scanner.update();
      event = {
        id: digest('synthetic-source-tx'),
        eventData: {
          height: 4,
          fromChain: direction === 'source' ? 'avalanche' : 'ergo',
          toChain: direction === 'source' ? 'ergo' : 'avalanche',
          fromAddress: 'source-address',
          toAddress: 'destination-address',
          amount: '10',
          bridgeFee: '1',
          networkFee: '1',
          sourceChainTokenId: 'source-token',
          targetChainTokenId: 'target-token',
          sourceTxId: 'synthetic-source-tx',
          sourceChainHeight: 1,
          sourceBlockId: direction === 'source' ? hash(1) : 'external-block',
          WIDsHash: 'wid-hash',
          WIDsCount: 1,
        },
      };
      intent = {
        network: event.eventData.toChain,
        eventId: event.id,
        txType: TransactionType.payment,
        txId: 'synthetic-payment-id',
        txBytes: 'abcd',
      };
      const safety = new AvalancheTransactionSafety(
        async () => event,
        () => scanner,
      );
      bound = await safety.bindTransaction(intent);
      registry = new TssAuthorizationRegistry(10000, 2);
    });

    afterEach(async () => {
      await Promise.all(pending.splice(0));
      axios.defaults.adapter = originalAdapter;
      network['provider'].destroy();
      await database.destroy();
      vi.restoreAllMocks();
    });

    const qualifiedSigner = () => {
      const transport = vi.fn<AxiosAdapter>(async (config) => {
        await expect(scanner.update()).rejects.toThrow('already running');
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
        policy: registry,
        signingTimeoutMs: 500,
        httpTimeoutMs: 100,
        maxPending: 2,
      });
      signer.getGuardTurn = () => 0;
      signer['getApprovedGuards'] = async () => [guard];
      signer['threshold'] = { value: 1, expiry: Infinity };
      return { signer, transport };
    };

    const queueSigner = async (signer: QualifiedEcdsaSigner) => {
      const outcome = Promise.resolve(
        registry.withContext(key, bound, () =>
          signer.signPromised(
            identity().message,
            key.chainCode,
            key.derivationPath,
          ),
        ),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      pending.push(outcome);
      await vi.waitFor(() => expect(signer['signs']).toHaveLength(1));
      await vi.waitFor(async () => {
        await expect(scanner.withSafety(() => true)).resolves.toBe(true);
      });
      return { outcome };
    };

    const peerStart = (signer: QualifiedEcdsaSigner) =>
      signer.processMessage(
        'start',
        { msg: identity().message, guards: [guard], signs: ['fixture'] },
        'verified-envelope',
        0,
        guard.peerId,
        1,
      );

    /**
     * @target QualifiedEcdsaSigner.signPromised 'joins installed signer queue, peer backend start and result after releasing the queue lease'
     * @dependencies Actual QualifiedEcdsaSigner sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'joins installed signer queue, peer backend start and result after releasing the queue lease' through QualifiedEcdsaSigner.signPromised.
     * @expected expect(transport).toHaveBeenCalledOnce(); expect(JSON.parse(transport.mock.calls[0][0].data)).toMatchObject({ message: digest('abcd'), crypto: 'ecdsa', chainCode: key.chainCode, derivationPath: key.derivationPath, }); expect(await outcome).toEqual({ value: { signature: 'fixture-signature', signatureRecovery: '0' }, }); await expect(scanner.update()).resolves.toBeUndefined();
     */
    it('joins installed signer queue, peer backend start and result after releasing the queue lease', async () => {
      const { signer, transport } = qualifiedSigner();
      Object.assign(intent, { txBytes: 'ffff' });
      const { outcome } = await queueSigner(signer);
      await peerStart(signer);
      expect(transport).toHaveBeenCalledOnce();
      expect(JSON.parse(transport.mock.calls[0][0].data)).toMatchObject({
        message: digest('abcd'),
        crypto: 'ecdsa',
        chainCode: key.chainCode,
        derivationPath: key.derivationPath,
      });
      // Synthetic completion exercises result authorization, not cryptography.
      signer['signs'][0].callback(true, undefined, 'fixture-signature', '0');
      expect(await outcome).toEqual({
        value: { signature: 'fixture-signature', signatureRecovery: '0' },
      });
      await expect(scanner.update()).resolves.toBeUndefined();
    });

    /**
     * @target QualifiedEcdsaSigner.signPromised 'blocks installed peer backend start after hold and releases exclusion after rejection'
     * @dependencies Actual QualifiedEcdsaSigner sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'blocks installed peer backend start after hold and releases exclusion after rejection' through QualifiedEcdsaSigner.signPromised.
     * @expected expect(transport).not.toHaveBeenCalled(); expect(await outcome).toHaveProperty('error'); await expect(scanner.update()).rejects.toThrow('later-hold');
     */
    it('blocks installed peer backend start after hold and releases exclusion after rejection', async () => {
      const { signer, transport } = qualifiedSigner();
      const { outcome } = await queueSigner(signer);
      await database
        .getRepository(AvalancheSafetyState)
        .update({ scanner: 'avalanche' }, { holdReason: 'later-hold' });
      await peerStart(signer);
      expect(transport).not.toHaveBeenCalled();
      expect(await outcome).toHaveProperty('error');
      // The durable hold remains; update reaches that check instead of a leaked lease.
      await expect(scanner.update()).rejects.toThrow('later-hold');
    });

    /**
     * @target QualifiedEcdsaSigner.signPromised 'expires a queued installed signer without retaining the scanner lease'
     * @dependencies Actual QualifiedEcdsaSigner sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'expires a queued installed signer without retaining the scanner lease' through QualifiedEcdsaSigner.signPromised.
     * @expected await expect(scanner.update()).resolves.toBeUndefined(); expect(await outcome).toHaveProperty('error'); expect(transport).not.toHaveBeenCalled(); await expect(scanner.update()).resolves.toBeUndefined();
     */
    it('expires a queued installed signer without retaining the scanner lease', async () => {
      const { signer, transport } = qualifiedSigner();
      const { outcome } = await queueSigner(signer);
      await expect(scanner.update()).resolves.toBeUndefined();
      expect(await outcome).toHaveProperty('error');
      expect(transport).not.toHaveBeenCalled();
      await expect(scanner.update()).resolves.toBeUndefined();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'dispatches copied intent bytes under update exclusion'
     * @dependencies Actual TssAuthorizationRegistry sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'dispatches copied intent bytes under update exclusion' through TssAuthorizationRegistry.withAuthorization.
     * @expected expect(Object.isFrozen(bound.intent)).toBe(true); expect(bound.intent.txBytes).toBe('abcd'); expect(bound.intent.txId).toBe('synthetic-payment-id'); await expect(scanner.update()).rejects.toThrow('already running'); await expect( registry.withAuthorization(identity(), phase, dispatch), ).resolves.toBe('abcd'); expect(dispatch).toHaveBeenCalledTimes(4); await expect(scanner.update()).resolves.toBeUndefined();
     */
    it('dispatches copied intent bytes under update exclusion', async () => {
      Object.assign(intent, { txBytes: 'ffff', txId: 'mutated' });
      const dispatch = vi.fn(async () => {
        expect(Object.isFrozen(bound.intent)).toBe(true);
        expect(bound.intent.txBytes).toBe('abcd');
        expect(bound.intent.txId).toBe('synthetic-payment-id');
        await expect(scanner.update()).rejects.toThrow('already running');
        return bound.intent.txBytes;
      });
      await registry.withContext(key, bound, () =>
        registry.withAuthorization(identity(), 'queue', dispatch),
      );
      for (const phase of ['backend', 'outbound', 'result'] as const)
        await expect(
          registry.withAuthorization(identity(), phase, dispatch),
        ).resolves.toBe('abcd');
      expect(dispatch).toHaveBeenCalledTimes(4);
      await expect(scanner.update()).resolves.toBeUndefined();
    });

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'blocks %s after a persisted hold'
     * @dependencies Actual TssAuthorizationRegistry sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'blocks %s after a persisted hold' through TssAuthorizationRegistry.withAuthorization.
     * @expected await expect( registry.withAuthorization(identity(), phase, dispatch), ).rejects.toThrow('not qualified'); expect(dispatch).not.toHaveBeenCalled();
     */
    it.each(['backend', 'outbound', 'result'] as const)(
      'blocks %s after a persisted hold',
      async (phase) => {
        await enqueue();
        await database
          .getRepository(AvalancheSafetyState)
          .update({ scanner: 'avalanche' }, { holdReason: 'later-hold' });
        const dispatch = vi.fn();
        await expect(
          registry.withAuthorization(identity(), phase, dispatch),
        ).rejects.toThrow('not qualified');
        expect(dispatch).not.toHaveBeenCalled();
      },
    );

    /**
     * @target TssAuthorizationRegistry.withAuthorization 'blocks %s after event drift and releases the lease'
     * @dependencies Actual TssAuthorizationRegistry sources and the suite's explicit database, scanner, codec and transport fixtures.
     * @scenario Run 'blocks %s after event drift and releases the lease' through TssAuthorizationRegistry.withAuthorization.
     * @expected await expect( registry.withAuthorization(identity(), phase, dispatch), ).rejects.toThrow('event changed'); expect(dispatch).not.toHaveBeenCalled(); await expect(scanner.update()).resolves.toBeUndefined();
     */
    it.each(['backend', 'outbound', 'result'] as const)(
      'blocks %s after event drift and releases the lease',
      async (phase) => {
        await enqueue();
        event.eventData.amount = '11';
        const dispatch = vi.fn();
        await expect(
          registry.withAuthorization(identity(), phase, dispatch),
        ).rejects.toThrow('event changed');
        expect(dispatch).not.toHaveBeenCalled();
        await expect(scanner.update()).resolves.toBeUndefined();
      },
    );
  },
);
