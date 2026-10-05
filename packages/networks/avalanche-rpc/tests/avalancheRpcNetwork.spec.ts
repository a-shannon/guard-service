import { FetchRequest, Transaction } from 'ethers';
import { createServer, Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { EvmTxStatus } from '@rosen-chains/evm';

import AvalancheRpcNetwork, {
  AVALANCHE_TX_EXTRACTOR,
} from '../lib/avalancheRpcNetwork';
import { avalancheGetUrl } from '../lib/avalancheTransport';
import * as submissionFixtures from './authorizedSubmissionTestUtils';
import * as networkFixtures from './avalancheRpcTestUtils';
import * as transportFixtures from './avalancheTransportTestUtils';
import { mockConstructorDatabase } from './mocked/constructorDatabase.mock';
import { receiptFixture } from './settledReceiptTestUtils';
import * as stateFixtures from './settledStateTestUtils';
import * as evidenceFixtures from './settledTransactionTestUtils';

describe('AvalancheRpcNetwork', () => {
  describe('getSettledTransactionReceiptEvidence', () => {
    /**
     * @target AvalancheRpcNetwork.getSettledTransactionReceiptEvidence returns a canonical mainnet signed receipt with detached nested logs
     * @dependencies Real RPC adapter and synthetic transaction, receipt, block and endpoint replies.
     * @scenario Read the token receipt, then mutate the original endpoint-owned log arrays.
     * @expected All returned identities remain bound to the signed bytes and nested views stay frozen and unchanged.
     */
    it('returns a canonical mainnet signed receipt with detached nested logs', async () => {
      const f = receiptFixture();
      const result = await f.network.getSettledTransactionReceiptEvidence(
        f.signed.hash!,
        f.block.hash,
      );
      expect(result).toMatchObject({
        signedBytes: f.signed.serialized,
        chainId: 43114n,
        blockHash: f.block.hash,
        confirmations: 3,
        status: EvmTxStatus.succeed,
      });
      const original = result.receipt.logs[0].topics[1];
      f.receipt.logs[0].topics[1] = '0x' + '33'.repeat(32);
      f.receipt.logs.splice(0);
      expect(result.receipt.logs).toHaveLength(1);
      expect(result.receipt.logs[0].topics[1]).toEqual(original);
      expect(
        [
          result,
          result.receipt,
          result.receipt.logs,
          result.receipt.logs[0],
          result.receipt.logs[0].topics,
        ].every(Object.isFrozen),
      ).toEqual(true);
      expect(f.find).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheRpcNetwork.getSettledTransactionReceiptEvidence refuses malformed or conflicting receipt field %s
     * @dependencies Actual adapter and one otherwise valid canonical mainnet receipt.
     * @scenario Change exactly the selected receipt or log field before reading.
     * @expected No qualified execution evidence is returned.
     */
    it.each([
      [
        'sender',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.from = '0x' + '33'.repeat(20);
        },
      ],
      [
        'contract',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.to = '0x' + '33'.repeat(20);
        },
      ],
      [
        'log topic',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.logs[0].topics[1] = '0x00';
        },
      ],
      [
        'log amount encoding',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.logs[0].data = '0xgg';
        },
      ],
      [
        'log index',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.logs[0].index = -1;
        },
      ],
      [
        'receipt identity',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.hash = '0x' + '33'.repeat(32);
        },
      ],
      [
        'receipt block',
        (f: ReturnType<typeof receiptFixture>) => {
          f.receipt.blockHash = '0x' + '33'.repeat(32);
        },
      ],
    ] as const)(
      'refuses malformed or conflicting receipt field %s',
      async (_label, change) => {
        const f = receiptFixture();
        change(f);
        await expect(
          f.network.getSettledTransactionReceiptEvidence(
            f.signed.hash!,
            f.block.hash,
          ),
        ).rejects.toThrow();
      },
    );
    /**
     * @target AvalancheRpcNetwork.getSettledTransactionReceiptEvidence detaches receipt fields before canonical block waits
     * @dependencies Real adapter and a numeric block lookup mutating the endpoint-owned receipt.
     * @scenario Change the original receipt data after capture while preserving canonical inclusion.
     * @expected Captured Transfer amount remains the original amount.
     */
    it('detaches receipt fields before canonical block waits', async () => {
      const f = receiptFixture();
      f.rpc.getBlock.mockImplementation(async (tag) => {
        if (tag === 'finalized' || tag === f.frontier.number) return f.frontier;
        f.receipt.logs[0].data = '0x' + '00'.repeat(32);
        return f.block;
      });
      const result = await f.network.getSettledTransactionReceiptEvidence(
        f.signed.hash!,
        f.block.hash,
      );
      expect(BigInt(result.receipt.logs[0].data)).toEqual(10000000000n);
    });
    /**
     * @target AvalancheRpcNetwork.getSettledTransactionReceiptEvidence preserves failed native evidence without imposing token transfer policy
     * @dependencies Real adapter and a reverted canonical token-shaped receipt.
     * @scenario Return status zero and no logs for included signed bytes.
     * @expected Failed execution remains available for invalidation; it is not classified as a transferred payment.
     */
    it('preserves failed native evidence without imposing token transfer policy', async () => {
      const f = receiptFixture();
      f.receipt.status = 0;
      f.receipt.logs = [];
      const result = await f.network.getSettledTransactionReceiptEvidence(
        f.signed.hash!,
        f.block.hash,
      );
      expect(result.status).toEqual(EvmTxStatus.failed);
      expect(result.receipt.logs).toEqual([]);
    });
  });
  describe('getERC20AssetTotalSupply', () => {
    /**
     * @target AvalancheRpcNetwork.getERC20AssetTotalSupply reads exactly one ABI supply word at the revalidated finalized height
     * @dependencies Real adapter, synthetic finalized state and mocked JSON-RPC responses.
     * @scenario Read token supply without using latest or the inherited contract helper.
     * @expected Exact raw units and eth_call totalSupply selector bound to height42.
     */
    it('reads exactly one ABI supply word at the revalidated finalized height', async () => {
      const f = stateFixtures.setup();
      expect(
        await f.network.getERC20AssetTotalSupply(stateFixtures.token),
      ).toEqual(9n);
      expect(f.rpc.send).toHaveBeenCalledWith('eth_call', [
        { to: stateFixtures.token, data: '0x18160ddd' },
        '0x2a',
      ]);
      expect(f.rpc.call).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheRpcNetwork.getERC20AssetTotalSupply refuses malformed ABI supply %s
     * @dependencies Actual finalized read and otherwise valid canonical state replies.
     * @scenario Substitute one invalid return value in the totalSupply eth_call.
     * @expected Supply read rejects, with no invented cap or latest fallback.
     */
    it.each([
      '0x',
      '0x9',
      '0x' + '00'.repeat(33),
      '0x' + 'gg'.repeat(32),
      null,
    ])('refuses malformed ABI supply %s', async (value) => {
      const f = stateFixtures.setup();
      const original = f.rpc.send.getMockImplementation()!;
      f.rpc.send.mockImplementation(async (method, params) =>
        method === 'eth_call' ? value : original(method, params),
      );
      await expect(
        f.network.getERC20AssetTotalSupply(stateFixtures.token),
      ).rejects.toThrow('Malformed Avalanche ERC-20 total supply');
    });
    /**
     * @target AvalancheRpcNetwork.getERC20AssetTotalSupply refuses changed %s identity
     * @dependencies Actual adapter and a state read that changes one identity after selection.
     * @scenario Move either network identity or canonical block hash during eth_call.
     * @expected Qualified supply is not returned.
     */
    it.each(['network', 'block'])(
      'refuses changed %s identity',
      async (kind) => {
        const f = stateFixtures.setup();
        const original = f.rpc.send.getMockImplementation()!;
        let changed = false;
        f.rpc.send.mockImplementation(async (method, params) => {
          if (method === 'eth_call') {
            changed = true;
            return stateFixtures.word(9n);
          }
          if (changed && kind === 'network' && method === 'eth_chainId')
            return '0xa86a';
          if (changed && kind === 'block' && method === 'eth_getBlockByNumber')
            return { ...f.block, number: '0x2a', hash: '0x' + '33'.repeat(32) };
          return original(method, params);
        });
        await expect(
          f.network.getERC20AssetTotalSupply(stateFixtures.token),
        ).rejects.toThrow();
      },
    );
  });
  afterEach(async () => {
    await submissionFixtures.closeSubmissionFixtures();
    await transportFixtures.closeTransportFixtures();
  });
  describe('constructor', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, address } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.constructor requires explicit supported identity and exposes Avalanche chain
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Construct unsupported and supported identities, then assert the mainnet fixture identity.
       * @expected
       * - Only explicit supported C-Chain identities are admitted.
       */
      it('requires explicit supported identity and exposes Avalanche chain', async () => {
        expect(f.network.chain).toEqual('avalanche');
        expect(f.network.expectedChainId).toEqual(43113n);
        expect(
          () =>
            new AvalancheRpcNetwork(
              'http://unused.invalid',
              f.db,
              address,
              1n,
              AVALANCHE_TX_EXTRACTOR,
              1000,
            ),
        ).toThrow();
        const mainnet = new AvalancheRpcNetwork(
          'http://unused.invalid',
          f.db,
          address,
          43114n,
          AVALANCHE_TX_EXTRACTOR,
          1000,
        );
        Object.defineProperty(mainnet, 'provider', { value: f.rpc });
        f.rpc.send.mockResolvedValue('0xa86a');
        await expect(mainnet.assertNetwork()).resolves.toBeUndefined();
      });
    });
    describe('SQLite provenance', () => {
      const { setup, address } = networkFixtures;

      let db: DataSource;

      beforeEach(async () => {
        db = await networkFixtures.createDatabase();
        setup(db);
      });

      afterEach(async () => {
        await db.destroy();
      });
      /**
       * @target AvalancheRpcNetwork.constructor rejects invalid extractor identity %s
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Construct with each malformed stable extractor identifier.
       * @expected
       * - Extractor identity validation rejects.
       */
      it.each([
        '',
        ' ',
        ' avalanche',
        'avalanche ',
        'avalanche\n',
        undefined,
        null,
      ])('rejects invalid extractor identity %s', (extractorId) => {
        expect(
          () =>
            new AvalancheRpcNetwork(
              'http://unused.invalid',
              db,
              address,
              43113n,
              extractorId as string,
              1000,
            ),
        ).toThrow('explicit stable extractor ID');
      });
    });
    describe('real provider deadline', () => {
      const networks: AvalancheRpcNetwork[] = [];
      const lock = networkFixtures.address;
      const url = 'http://127.0.0.1:1/ext/bc/C/rpc';
      const { getRepository, database } = mockConstructorDatabase();
      let server: Server | undefined;

      beforeEach(() => getRepository.mockClear());
      afterEach(async () => {
        networks.splice(0).forEach((network) => network['provider'].destroy());
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
          server = undefined;
        }
      });
      /**
       * @target AvalancheRpcNetwork.constructor sets the real provider request deadline while preserving URL/auth (%s)
       * @dependencies
       * - Real ethers provider and synthetic constructor repository mock.
       * - Synthetic loopback HTTP endpoint for the stalled response.
       * @scenario
       * - Construct each auth variant with an explicit deadline, inspect provider metadata and mutate a connection clone.
       * @expected
       * - Chain/extractor identity, endpoint/auth and the original deadline remain exact.
       */
      it.each([undefined, 'synthetic-token'])(
        'sets the real provider request deadline while preserving URL/auth (%s)',
        (authToken) => {
          const network = new AvalancheRpcNetwork(
            url,
            database,
            lock,
            43113n,
            AVALANCHE_TX_EXTRACTOR,
            8000,
            authToken,
          );
          networks.push(network);
          const connection = network['provider']._getConnection();
          expect(connection.timeout).toEqual(8000);
          expect(connection.url).toEqual(
            authToken ? `${url}/${authToken}` : url,
          );
          expect(network.chain).toEqual('avalanche');
          expect(network.expectedChainId).toEqual(43113n);
          expect(network.extractorId).toEqual(AVALANCHE_TX_EXTRACTOR);
          connection.timeout = 1;
          expect(network['provider']._getConnection().timeout).toEqual(8000);
        },
      );

      /**
       * @target AvalancheRpcNetwork.constructor accepts the explicit timer boundary %s
       * @dependencies
       * - Real ethers provider and synthetic constructor repository mock.
       * - Synthetic loopback HTTP endpoint for the stalled response.
       * @scenario
       * - Construct the mainnet adapter at each supported timer boundary.
       * @expected
       * - The configured deadline and mainnet identity are accepted.
       */
      it.each([1, 2147483647])(
        'accepts the explicit timer boundary %s',
        (timeoutMs) => {
          const network = new AvalancheRpcNetwork(
            url,
            database,
            lock,
            43114n,
            AVALANCHE_TX_EXTRACTOR,
            timeoutMs,
          );
          networks.push(network);
          expect(network['provider']._getConnection().timeout).toEqual(
            timeoutMs,
          );
          expect(network.expectedChainId).toEqual(43114n);
        },
      );

      /**
       * @target AvalancheRpcNetwork.constructor rejects invalid required timeout %s before repository/provider effects
       * @dependencies
       * - Real ethers provider and synthetic constructor repository mock.
       * - Synthetic loopback HTTP endpoint for the stalled response.
       * @scenario
       * - Supply each malformed required deadline before accessing the database.
       * @expected
       * - Timeout validation rejects before repository/provider effects.
       */
      it.each([
        undefined,
        null,
        '1000',
        true,
        0,
        -1,
        0.5,
        NaN,
        Infinity,
        2147483648,
      ])(
        'rejects invalid required timeout %s before repository/provider effects',
        (timeoutMs) => {
          expect(
            () =>
              new AvalancheRpcNetwork(
                url,
                database,
                lock,
                43113n,
                AVALANCHE_TX_EXTRACTOR,
                timeoutMs as number,
              ),
          ).toThrow('Avalanche RPC timeout');
          expect(getRepository).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.constructor aborts a real stalled loopback HTTP response at its configured request deadline
       * @dependencies
       * - Real ethers provider and synthetic constructor repository mock.
       * - Synthetic loopback HTTP endpoint for the stalled response.
       * @scenario
       * - Send a request through a real Avalanche provider to a stalled authenticated loopback URL.
       * @expected
       * - The configured deadline raises TIMEOUT and the server sees the exact auth path.
       */
      it('aborts a real stalled loopback HTTP response at its configured request deadline', async () => {
        const received = vi.fn();
        server = createServer((request) => {
          received(request.url);
          // Deliberately leave this synthetic local response open.
        });
        await new Promise<void>((resolve) =>
          server!.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing local server port');
        const network = new AvalancheRpcNetwork(
          `http://127.0.0.1:${address.port}/ext/bc/C/rpc`,
          database,
          lock,
          43113n,
          AVALANCHE_TX_EXTRACTOR,
          100,
          'synthetic-token',
        );
        networks.push(network);
        await expect(
          network['provider']._send({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_chainId',
            params: [],
          }),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(received).toHaveBeenCalledWith('/ext/bc/C/rpc/synthetic-token');
      });
    });
  });
  describe('getHeight', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, otherHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getHeight binds finalized by number and never uses latest or confirmations
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Read height and transaction confirmations and inspect block query order and forbidden provider helpers.
       * @expected
       * - Finalized is bound numerically; latest and provider wait/confirmation helpers are unused.
       */
      it('binds finalized by number and never uses latest or confirmations', async () => {
        await expect(f.network.getHeight()).resolves.toEqual(12);
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          3,
        );
        expect(f.rpc.getBlock.mock.calls.map(([tag]) => tag)).toEqual([
          'finalized',
          12,
          'finalized',
          12,
          10,
        ]);
        expect(f.rpc.getBlockNumber).not.toHaveBeenCalled();
        expect(f.tx.confirmations).not.toHaveBeenCalled();
        expect(f.tx.wait).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getHeight rechecks identity after a successful call
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Read once successfully, switch RPC identity, and read again.
       * @expected
       * - Identity is checked again and the changed chain rejects.
       */
      it('rechecks identity after a successful call', async () => {
        await f.network.getHeight();
        f.rpc.send.mockResolvedValue('0xa86a');
        await expect(async () => {
          await f.network.getHeight();
        }).rejects.toThrow('chain ID mismatch');
      });

      /**
       * @target AvalancheRpcNetwork.getHeight rejects malformed RPC identity %s
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Supply each malformed chain-ID response.
       * @expected
       * - The identity response rejects.
       */
      it.each(['0x00', '-1', '0xa869x', '', null, 43113])(
        'rejects malformed RPC identity %s',
        async (value) => {
          f.rpc.send.mockResolvedValue(value as string);
          await expect(async () => {
            await f.network.getHeight();
          }).rejects.toThrow();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getHeight rejects unavailable finalized with no latest fallback
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return no finalized block.
       * @expected
       * - The read rejects after one finalized lookup with no latest fallback.
       */
      it('rejects unavailable finalized with no latest fallback', async () => {
        f.rpc.getBlock.mockResolvedValue(null as never);
        await expect(async () => {
          await f.network.getHeight();
        }).rejects.toThrow('unavailable');
        expect(f.rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
        expect(f.rpc.getBlockNumber).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getHeight propagates unsupported finalized without fallback
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Reject the finalized lookup.
       * @expected
       * - The same failure reason propagates without fallback.
       */
      it('propagates unsupported finalized without fallback', async () => {
        f.rpc.getBlock.mockRejectedValue(new Error('unsupported finalized'));
        await expect(async () => {
          await f.network.getHeight();
        }).rejects.toThrow('unsupported finalized');
        expect(f.rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      });

      /**
       * @target AvalancheRpcNetwork.getHeight rejects malformed frontier height %s
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Replace the finalized block height with each malformed numeric boundary.
       * @expected
       * - Malformed heights reject.
       */
      it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
        'rejects malformed frontier height %s',
        async (value) => {
          f.frontier.number = value;
          await expect(async () => {
            await f.network.getHeight();
          }).rejects.toThrow('Malformed');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getHeight rejects malformed frontier %s
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Replace each frontier hash field with a short malformed hash.
       * @expected
       * - Malformed frontier identity rejects.
       */
      it.each(['hash', 'parentHash'] as const)(
        'rejects malformed frontier %s',
        async (field) => {
          f.frontier[field] = '0x123';
          await expect(async () => {
            await f.network.getHeight();
          }).rejects.toThrow('Malformed');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getHeight rejects a finalized hash that disagrees with its by-number lookup
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return a finalized-tag hash that differs from its numeric lookup.
       * @expected
       * - The frontier canonical binding rejects.
       */
      it('rejects a finalized hash that disagrees with its by-number lookup', async () => {
        f.rpc.getBlock.mockImplementation(async (tag) =>
          tag === 'finalized' ? f.frontier : { ...f.frontier, hash: otherHash },
        );
        await expect(async () => {
          await f.network.getHeight();
        }).rejects.toThrow('not canonical');
      });
    });
  });
  describe('assertNetwork', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, blockHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.assertNetwork checks live network identity in %s
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return a wrong chain identity for each public operation in the table.
       * @expected
       * - Each operation rejects before block, transaction or broadcast effects.
       */
      it.each([
        'getHeight',
        'getBlockInfo',
        'getBlockTransactionIds',
        'getTransaction',
        'getTxConfirmation',
        'getTransactionStatus',
        'getGasRequired',
        'submitTransaction',
        'getFeeData',
      ] as const)('checks live network identity in %s', async (method) => {
        f.rpc.send.mockResolvedValue('0x1');
        const operations = {
          getHeight: () => f.network.getHeight(),
          getBlockInfo: () => f.network.getBlockInfo(blockHash),
          getBlockTransactionIds: () =>
            f.network.getBlockTransactionIds(blockHash),
          getTransaction: () => f.network.getTransaction(f.tx.hash, blockHash),
          getTxConfirmation: () => f.network.getTxConfirmation(f.tx.hash),
          getTransactionStatus: () => f.network.getTransactionStatus(f.tx.hash),
          getGasRequired: () => f.network.getGasRequired(f.transaction),
          submitTransaction: () => f.network.submitTransaction(f.transaction),
          getFeeData: () => f.network.getFeeData(),
        };
        await expect(async () => {
          await operations[method]();
        }).rejects.toThrow('chain ID mismatch');
        expect(f.rpc.broadcastTransaction).not.toHaveBeenCalled();
        expect(f.rpc.getTransaction).not.toHaveBeenCalled();
        expect(f.rpc.getBlock).not.toHaveBeenCalled();
      });
    });
    describe('owned HTTP transport', () => {
      const { listen, providers, closed } = transportFixtures;
      const { database: db } = mockConstructorDatabase();

      /**
       * @target AvalancheRpcNetwork.assertNetwork uses owned transport for actual Avalanche chain identity reads and closes their stalled socket
       * @dependencies
       * - Real ethers provider and owned Avalanche transport hook.
       * - Stalled synthetic loopback HTTP peer and observed socket closure.
       * @scenario
       * - Perform a real Avalanche chain-identity request against a stalled loopback endpoint.
       * @expected
       * - The owned hook is retained, TIMEOUT occurs, and stalled sockets close.
       */
      it('uses owned transport for actual Avalanche chain identity reads and closes their stalled socket', async () => {
        const fixture = await listen(() => undefined);
        const network = new AvalancheRpcNetwork(
          fixture.url,
          db,
          '0x' + '11'.repeat(20),
          43113n,
          'avalanche-lock-address',
          120,
        );
        providers.push(network['provider']);
        expect(network['provider']._getConnection().getUrlFunc).toBe(
          avalancheGetUrl,
        );
        await expect(network.assertNetwork()).rejects.toMatchObject({
          code: 'TIMEOUT',
        });
        await closed(fixture.connections);
      });
    });
  });
  describe('getBlockInfo', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, blockHash, otherHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getBlockInfo returns canonical block information and transaction IDs
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Read the synthetic canonical block and its transaction identifiers.
       * @expected
       * - Exact block information and transaction hashes are returned.
       */
      it('returns canonical block information and transaction IDs', async () => {
        await expect(f.network.getBlockInfo(blockHash)).resolves.toEqual({
          hash: blockHash,
          parentHash: otherHash,
          height: 10,
        });
        await expect(
          f.network.getBlockTransactionIds(blockHash),
        ).resolves.toEqual([f.tx.hash]);
      });

      /**
       * @target AvalancheRpcNetwork.getBlockInfo rejects by-number block %s mismatch
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Change one numeric canonical lookup field while retaining the hash-addressed block.
       * @expected
       * - The by-number mismatch rejects.
       */
      it.each(['hash', 'number'] as const)(
        'rejects by-number block %s mismatch',
        async (field) => {
          const original = f.rpc.getBlock.getMockImplementation()!;
          f.rpc.getBlock.mockImplementation(async (tag) =>
            tag === 10
              ? { ...f.block, [field]: field === 'hash' ? otherHash : 9 }
              : original(tag),
          );
          await expect(async () => {
            await f.network.getBlockInfo(blockHash);
          }).rejects.toThrow('not canonical');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getBlockInfo rejects requested block hash mismatch
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return another block hash for the requested hash lookup.
       * @expected
       * - The requested block identity mismatch rejects.
       */
      it('rejects requested block hash mismatch', async () => {
        const original = f.rpc.getBlock.getMockImplementation()!;
        f.rpc.getBlock.mockImplementation(async (tag) =>
          tag === blockHash ? { ...f.block, hash: otherHash } : original(tag),
        );
        await expect(async () => {
          await f.network.getBlockInfo(blockHash);
        }).rejects.toThrow('requested block hash');
      });

      /**
       * @target AvalancheRpcNetwork.getBlockInfo rejects block access above captured finalized frontier
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Move the settled frontier below the requested transaction block.
       * @expected
       * - Both block information and transaction-list reads reject unsettled access.
       */
      it('rejects block access above captured finalized frontier', async () => {
        f.frontier.number = 9;
        await expect(async () => {
          await f.network.getBlockInfo(blockHash);
        }).rejects.toThrow('not settled');
        await expect(async () => {
          await f.network.getBlockTransactionIds(blockHash);
        }).rejects.toThrow('not settled');
      });
    });
  });
  describe('getTransaction', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, blockHash, otherHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getTransaction retrieves a successful settled transaction with exact serialization
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Read a canonical successful transaction and its status.
       * @expected
       * - Exact hash/serialization and successful status are retained.
       */
      it('retrieves a successful settled transaction with exact serialization', async () => {
        const tx = await f.network.getTransaction(f.tx.hash, blockHash);
        expect(tx.hash).toEqual(f.tx.hash);
        expect(tx.serialized).toEqual(f.transaction.serialized);
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.succeed);
      });

      /**
       * @target AvalancheRpcNetwork.getTransaction rejects isolated transaction %s mismatch (%s)
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Change one signed transaction identity/serialization field from the table.
       * @expected
       * - The inconsistent transaction rejects.
       */
      it.each([
        ['hash', otherHash],
        ['chainId', 43114n],
        ['blockHash', otherHash],
        ['blockNumber', 11],
        ['index', 1],
        ['index', -1],
        ['index', 0.5],
        ['blockHash', null],
        ['blockNumber', null],
      ])(
        'rejects isolated transaction %s mismatch (%s)',
        async (field, value) => {
          Object.assign(f.tx, { [field as string]: value });
          await expect(async () => {
            await f.network.getTransaction(f.transaction.hash!, blockHash);
          }).rejects.toThrow();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getTransaction rejects mismatching canonical inclusion index
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Move the transaction hash to another canonical block index.
       * @expected
       * - The inclusion-index mismatch rejects.
       */
      it('rejects mismatching canonical inclusion index', async () => {
        f.block.transactions = [otherHash, f.tx.hash];
        await expect(async () => {
          await f.network.getTransaction(f.tx.hash, blockHash);
        }).rejects.toThrow('inclusion mismatch');
      });

      /**
       * @target AvalancheRpcNetwork.getTransaction rejects contradictory transaction serialization
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Change transaction value without changing the signed hash.
       * @expected
       * - The contradictory serialization rejects.
       */
      it('rejects contradictory transaction serialization', async () => {
        Object.assign(f.tx, { value: '32' });
        await expect(async () => {
          await f.network.getTransaction(f.tx.hash, blockHash);
        }).rejects.toThrow();
      });
    });
  });
  describe('getTxConfirmation', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, blockHash, otherHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getTxConfirmation rejects isolated receipt %s mismatch (%s)
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Change one receipt identity/status field from the table and query confirmation/status.
       * @expected
       * - Both public reads reject the contradictory receipt.
       */
      it.each([
        ['hash', otherHash],
        ['blockHash', otherHash],
        ['blockNumber', 11],
        ['index', 1],
        ['index', -1],
        ['status', null],
        ['status', 2],
      ])('rejects isolated receipt %s mismatch (%s)', async (field, value) => {
        Object.assign(f.receipt, { [field as string]: value });
        await expect(async () => {
          await f.network.getTxConfirmation(f.tx.hash);
        }).rejects.toThrow();
        await expect(async () => {
          await f.network.getTransactionStatus(f.tx.hash);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getTxConfirmation rejects missing transaction index from block
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Remove all transaction identifiers from the canonical block.
       * @expected
       * - The missing inclusion index rejects.
       */
      it('rejects missing transaction index from block', async () => {
        f.block.transactions = [];
        await expect(async () => {
          await f.network.getTxConfirmation(f.tx.hash);
        }).rejects.toThrow('Malformed');
      });

      /**
       * @target AvalancheRpcNetwork.getTxConfirmation keeps a premature successful receipt pending until a later finalized observation
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Keep a successful receipt above finalized, query confirmation/status/transaction, then advance finalized and repeat.
       * @expected
       * - Premature success stays pending; a later settled observation yields three confirmations and success.
       */
      it('keeps a premature successful receipt pending until a later finalized observation', async () => {
        f.frontier.number = 9;
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          -1,
        );
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.mempool);
        await expect(async () => {
          await f.network.getTransaction(f.tx.hash, blockHash);
        }).rejects.toThrow('not settled success');
        f.frontier.number = 12;
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          3,
        );
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.succeed);
      });

      /**
       * @target AvalancheRpcNetwork.getTxConfirmation captures the frontier once rather than advancing during an operation
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Advance the shared frontier during a transaction-block lookup after capturing it.
       * @expected
       * - The current operation retains the original three-confirmation frontier.
       */
      it('captures the frontier once rather than advancing during an operation', async () => {
        const original = f.rpc.getBlock.getMockImplementation()!;
        f.rpc.getBlock.mockImplementation(async (tag) => {
          const result = { ...(await original(tag)) };
          if (tag === 10) f.frontier.number = 20;
          return result;
        });
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          3,
        );
      });

      /**
       * @target AvalancheRpcNetwork.getTxConfirmation resolves unsigned transaction aliases
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Provide a stored unsigned alias mapping and query confirmations with the alias.
       * @expected
       * - Only the mapped signed hash is fetched.
       */
      it('resolves unsigned transaction aliases', async () => {
        f.find.mockResolvedValue([
          {
            signedHash: f.tx.hash,
            unsignedHash: f.transaction.unsignedHash,
            blockId: blockHash,
            nonce: 7,
          },
        ]);
        await expect(
          f.network.getTxConfirmation(f.transaction.unsignedHash),
        ).resolves.toEqual(3);
        expect(f.rpc.getTransaction).toHaveBeenCalledWith(f.tx.hash);
      });
    });
    describe('SQLite provenance', () => {
      const { setup, createRow } = networkFixtures;

      let db: DataSource;
      let f: ReturnType<typeof setup>;
      beforeEach(async () => {
        db = await networkFixtures.createDatabase();
        f = setup(db);
      });

      afterEach(async () => {
        await db.destroy();
      });
      /**
       * @target AvalancheRpcNetwork.getTxConfirmation rejects alias nonce mismatch
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Store an alias with a changed nonce and query its confirmations.
       * @expected
       * - The stored transaction identity rejects.
       */
      it('rejects alias nonce mismatch', async () => {
        await db
          .getRepository(AddressTxsEntity)
          .insert({ ...createRow(f), nonce: 8 });
        await expect(async () => {
          await f.network.getTxConfirmation(f.transaction.unsignedHash);
        }).rejects.toThrow('stored transaction identity');
      });
    });
  });
  describe('getTransactionStatus', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, blockHash } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getTransactionStatus rejects missing receipt as unavailable
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return no receipt for an otherwise mined transaction.
       * @expected
       * - The missing receipt rejects as unavailable.
       */
      it('rejects missing receipt as unavailable', async () => {
        f.rpc.getTransactionReceipt.mockResolvedValue(null as never);
        await expect(async () => {
          await f.network.getTransactionStatus(f.tx.hash);
        }).rejects.toThrow('receipt unavailable');
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionStatus does not classify failed receipts as final above the frontier
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Keep a failed receipt above finalized, then advance finalized and query status/confirmation/transaction.
       * @expected
       * - The premature receipt stays pending; settled failure never becomes success-only retrieval.
       */
      it('does not classify failed receipts as final above the frontier', async () => {
        f.receipt.status = 0;
        f.frontier.number = 9;
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.mempool);
        f.frontier.number = 12;
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.failed);
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          -1,
        );
        await expect(async () => {
          await f.network.getTransaction(f.tx.hash, blockHash);
        }).rejects.toThrow('not settled success');
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionStatus classifies only null transactions as notFound
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return null for transaction lookup and compare confirmations, status and retrieval.
       * @expected
       * - Only absence produces notFound; retrieval rejects.
       */
      it('classifies only null transactions as notFound', async () => {
        f.rpc.getTransaction.mockResolvedValue(null as never);
        await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
          -1,
        );
        await expect(
          f.network.getTransactionStatus(f.tx.hash),
        ).resolves.toEqual(EvmTxStatus.notFound);
        await expect(async () => {
          await f.network.getTransaction(f.tx.hash, blockHash);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionStatus classifies pending transactions with index %s as mempool
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Remove block placement for each pending index representation.
       * @expected
       * - The transaction remains mempool and receipts are not fetched.
       */
      it.each([null, undefined])(
        'classifies pending transactions with index %s as mempool',
        async (index) => {
          Object.assign(f.tx, { blockNumber: null, blockHash: null, index });
          await expect(f.network.getTxConfirmation(f.tx.hash)).resolves.toEqual(
            -1,
          );
          await expect(
            f.network.getTransactionStatus(f.tx.hash),
          ).resolves.toEqual(EvmTxStatus.mempool);
          expect(f.rpc.getTransactionReceipt).not.toHaveBeenCalled();
        },
      );
    });
    describe('SQLite provenance', () => {
      const { setup, address, createRow } = networkFixtures;

      let db: DataSource;
      let f: ReturnType<typeof setup>;
      beforeEach(async () => {
        db = await networkFixtures.createDatabase();
        f = setup(db);
      });

      afterEach(async () => {
        await db.destroy();
      });
      /**
       * @target AvalancheRpcNetwork.getTransactionStatus rejects alias sender mismatch
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Store an alias, replace the RPC sender, and query status.
       * @expected
       * - The stored sender binding rejects.
       */
      it('rejects alias sender mismatch', async () => {
        await db.getRepository(AddressTxsEntity).insert(createRow(f));
        f.tx.from = address;
        await expect(async () => {
          await f.network.getTransactionStatus(f.transaction.unsignedHash);
        }).rejects.toThrow('stored transaction identity');
      });
    });
  });
  describe('getGasRequired', () => {
    describe('synthetic finalized RPC', () => {
      const { setup, address } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getGasRequired preserves value, sender, nonce and chain in estimation
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Estimate a canonical transaction and inspect exact request fields, then change its chain ID.
       * @expected
       * - Exact value/sender/nonce/chain are sent once; wrong-chain estimation rejects.
       */
      it('preserves value, sender, nonce and chain in estimation', async () => {
        await expect(f.network.getGasRequired(f.transaction)).resolves.toEqual(
          30000n,
        );
        expect(f.rpc.estimateGas).toHaveBeenCalledExactlyOnceWith({
          from: f.transaction.from,
          to: address,
          data: '0xabcd',
          value: 31n,
          nonce: 7,
          chainId: 43113n,
        });
        f.transaction.chainId = 43114n;
        await expect(async () => {
          await f.network.getGasRequired(f.transaction);
        }).rejects.toThrow('estimate chain ID');
        expect(f.rpc.estimateGas).toHaveBeenCalledTimes(1);
      });
    });
  });
  describe('submitTransaction', () => {
    describe('synthetic finalized RPC', () => {
      const { setup } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.submitTransaction rejects submission for chain %s without broadcasting
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Change the signed transaction chain ID to each unsupported binding.
       * @expected
       * - Protected-transaction validation rejects before broadcast.
       */
      it.each([0n, 43114n])(
        'rejects submission for chain %s without broadcasting',
        async (chainId) => {
          f.transaction.chainId = chainId;
          await expect(async () => {
            await f.network.submitTransaction(f.transaction);
          }).rejects.toThrow('protected transaction');
          expect(f.rpc.broadcastTransaction).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.submitTransaction rejects unsigned submission
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Remove the signed transaction signature and attempt submission.
       * @expected
       * - Unsigned input rejects before broadcast.
       */
      it('rejects unsigned submission', async () => {
        f.transaction.signature = null;
        await expect(async () => {
          await f.network.submitTransaction(f.transaction);
        }).rejects.toThrow('protected transaction');
        expect(f.rpc.broadcastTransaction).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.submitTransaction broadcasts only exact protected bytes to the mocked provider
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Submit the valid protected transaction to the mock provider.
       * @expected
       * - Only its exact serialized signed bytes are broadcast.
       */
      it('broadcasts only exact protected bytes to the mocked provider', async () => {
        await f.network.submitTransaction(f.transaction);
        expect(f.rpc.broadcastTransaction).toHaveBeenCalledExactlyOnceWith(
          f.transaction.serialized,
        );
      });
    });
  });
  describe('getFeeData', () => {
    describe('synthetic finalized RPC', () => {
      const { setup } = networkFixtures;

      let f: ReturnType<typeof setup>;
      beforeEach(() => {
        f = setup();
      });
      /**
       * @target AvalancheRpcNetwork.getFeeData uses Avalanche fee RPC quantities for EIP-1559 fees
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Read RPC base/priority fee quantities and the two fee accessors.
       * @expected
       * - EIP-1559 fees are exact and gasPrice remains null.
       */
      it('uses Avalanche fee RPC quantities for EIP-1559 fees', async () => {
        const fees = await f.network.getFeeData();
        expect(fees.gasPrice).toBeNull();
        expect(fees.maxFeePerGas).toEqual(22n);
        expect(fees.maxPriorityFeePerGas).toEqual(2n);
        await expect(f.network.getMaxFeePerGas()).resolves.toEqual(22n);
        await expect(f.network.getMaxPriorityFeePerGas()).resolves.toEqual(2n);
      });

      /**
       * @target AvalancheRpcNetwork.getFeeData fails unavailable %s without a fixed fallback
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Reject one selected fee RPC method while retaining the other responses.
       * @expected
       * - Unavailable fees reject without a fixed fallback.
       */
      it.each(['eth_baseFee', 'eth_maxPriorityFeePerGas'])(
        'fails unavailable %s without a fixed fallback',
        async (method) => {
          const original = f.rpc.send.getMockImplementation()!;
          f.rpc.send.mockImplementation(async (name) => {
            if (name === method) throw new Error('fee unavailable');
            return original(name);
          });
          await expect(async () => {
            await f.network.getFeeData();
          }).rejects.toThrow('fee unavailable');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getFeeData rejects malformed fee %s
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return each malformed base-fee quantity.
       * @expected
       * - Malformed fee quantities reject.
       */
      it.each(['-1', '0x01', '0x', '0x-1', null, '0x' + 'f'.repeat(65)])(
        'rejects malformed fee %s',
        async (value) => {
          const original = f.rpc.send.getMockImplementation()!;
          f.rpc.send.mockImplementation(async (name) =>
            name === 'eth_baseFee' ? (value as string) : original(name),
          );
          await expect(async () => {
            await f.network.getFeeData();
          }).rejects.toThrow('Malformed');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getFeeData rejects fee arithmetic overflow
       * @dependencies
       * - Synthetic signed transaction, finalized/canonical block and receipt fixtures.
       * - Mocked RPC identity, block, transaction, receipt, estimate and broadcast methods.
       * @scenario
       * - Return the maximum uint256 base fee before EIP-1559 arithmetic.
       * @expected
       * - Fee arithmetic overflow rejects.
       */
      it('rejects fee arithmetic overflow', async () => {
        const original = f.rpc.send.getMockImplementation()!;
        f.rpc.send.mockImplementation(async (name) =>
          name === 'eth_baseFee' ? '0x' + 'f'.repeat(64) : original(name),
        );
        await expect(async () => {
          await f.network.getFeeData();
        }).rejects.toThrow('overflow');
      });
    });
  });
  describe('getTransactionByNonce', () => {
    describe('SQLite provenance', () => {
      const { setup, otherHash, address, createRow } = networkFixtures;

      let db: DataSource;
      let f: ReturnType<typeof setup>;
      beforeEach(async () => {
        db = await networkFixtures.createDatabase();
        f = setup(db);
      });

      afterEach(async () => {
        await db.destroy();
      });
      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce does not use another chain row with the same address and nonce
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert a row for another chain with the same address and nonce.
       * @expected
       * - The nonce lookup rejects before RPC transaction retrieval.
       */
      it('does not use another chain row with the same address and nonce', async () => {
        await db
          .getRepository(AddressTxsEntity)
          .insert(createRow(f, 'ethereum-lock-address'));
        await expect(async () => {
          await f.network.getTransactionByNonce(7);
        }).rejects.toThrow('nonce not found');
        expect(f.rpc.getTransaction).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce selects the exact extractor among other-chain nonce and alias collisions
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert foreign-chain and exact-extractor collisions, then query nonce and alias-aware reads.
       * @expected
       * - Only the exact extractor signed transaction is resolved and fetched.
       */
      it('selects the exact extractor among other-chain nonce and alias collisions', async () => {
        const repository = db.getRepository(AddressTxsEntity);
        await repository.insert({
          ...createRow(f, 'ethereum-lock-address'),
          signedHash: otherHash,
        });
        await repository.insert(createRow(f));
        await expect(f.network.getTransactionByNonce(7)).resolves.toEqual({
          unsignedHash: f.transaction.unsignedHash,
          txId: f.transaction.hash,
        });
        await expect(
          f.network.getActualTxId(f.transaction.unsignedHash),
        ).resolves.toEqual(f.transaction.hash);
        await expect(
          f.network.getTxConfirmation(f.transaction.unsignedHash),
        ).resolves.toEqual(3);
        await expect(
          f.network.getTransactionStatus(f.transaction.unsignedHash),
        ).resolves.toEqual(EvmTxStatus.succeed);
        expect(
          f.rpc.getTransaction.mock.calls.every(
            ([id]) => id === f.transaction.hash,
          ),
        ).toEqual(true);
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce does not match another address within the selected extractor
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert a same-extractor row for another address.
       * @expected
       * - The nonce lookup rejects the address mismatch.
       */
      it('does not match another address within the selected extractor', async () => {
        await db
          .getRepository(AddressTxsEntity)
          .insert({ ...createRow(f), address });
        await expect(async () => {
          await f.network.getTransactionByNonce(7);
        }).rejects.toThrow('nonce not found');
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce rejects ambiguous %s records before RPC reads
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert duplicate provenance rows and query nonce or alias lookup.
       * @expected
       * - Ambiguity rejects before RPC transaction reads.
       */
      it.each(['nonce', 'alias'] as const)(
        'rejects ambiguous %s records before RPC reads',
        async (kind) => {
          await db
            .getRepository(AddressTxsEntity)
            .insert([createRow(f), createRow(f)]);
          await expect(async () => {
            await (kind === 'nonce'
              ? f.network.getTransactionByNonce(7)
              : f.network.getActualTxId(f.transaction.unsignedHash));
          }).rejects.toThrow('Ambiguous');
          expect(f.rpc.getTransaction).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce rejects stored %s mismatch against authoritative RPC
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Change exactly one stored provenance field while retaining authoritative RPC fixtures.
       * @expected
       * - The stored identity mismatch rejects.
       */
      it.each([
        ['blockId', otherHash],
        ['unsignedHash', otherHash],
        ['signedHash', otherHash],
      ])(
        'rejects stored %s mismatch against authoritative RPC',
        async (field, value) => {
          await db
            .getRepository(AddressTxsEntity)
            .insert({ ...createRow(f), [field]: value });
          await expect(async () => {
            await f.network.getTransactionByNonce(7);
          }).rejects.toThrow();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce rejects a stored nonce whose execution is above finalized
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert a valid nonce row but leave execution above finalized.
       * @expected
       * - The nonce result rejects as not settled.
       */
      it('rejects a stored nonce whose execution is above finalized', async () => {
        await db.getRepository(AddressTxsEntity).insert(createRow(f));
        f.frontier.number = 9;
        await expect(async () => {
          await f.network.getTransactionByNonce(7);
        }).rejects.toThrow('not settled');
      });

      /**
       * @target AvalancheRpcNetwork.getTransactionByNonce returns a settled reverted transaction because it still consumes its nonce
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert a valid nonce row with a settled reverted receipt.
       * @expected
       * - The reverted transaction still resolves its consumed nonce.
       */
      it('returns a settled reverted transaction because it still consumes its nonce', async () => {
        await db.getRepository(AddressTxsEntity).insert(createRow(f));
        f.receipt.status = 0;
        await expect(f.network.getTransactionByNonce(7)).resolves.toEqual({
          unsignedHash: f.transaction.unsignedHash,
          txId: f.transaction.hash,
        });
      });
    });
  });
  describe('getActualTxId', () => {
    describe('SQLite provenance', () => {
      const { setup, createRow } = networkFixtures;

      let db: DataSource;
      let f: ReturnType<typeof setup>;
      beforeEach(async () => {
        db = await networkFixtures.createDatabase();
        f = setup(db);
      });

      afterEach(async () => {
        await db.destroy();
      });
      /**
       * @target AvalancheRpcNetwork.getActualTxId %s does not use another extractor unsigned-hash alias
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert another extractor alias and query each alias-aware method with an absent RPC transaction.
       * @expected
       * - The foreign extractor alias is never resolved to its signed hash.
       */
      it.each([
        'getActualTxId',
        'getTxConfirmation',
        'getTransactionStatus',
      ] as const)(
        '%s does not use another extractor unsigned-hash alias',
        async (method) => {
          await db
            .getRepository(AddressTxsEntity)
            .insert(createRow(f, 'binance-lock-address'));
          f.rpc.getTransaction.mockResolvedValue(null as never);
          const result = f.network[method](f.transaction.unsignedHash);
          if (method === 'getActualTxId')
            await expect(async () => {
              await result;
            }).rejects.toThrow('not found');
          else await result;
          expect(f.rpc.getTransaction).toHaveBeenCalledExactlyOnceWith(
            f.transaction.unsignedHash,
          );
        },
      );

      /**
       * @target AvalancheRpcNetwork.getActualTxId rejects a stored alias with %s RPC transaction
       * @dependencies
       * - In-memory SQLite address transaction entity/migrations.
       * - Mocked chain, finalized/block, transaction and receipt RPC methods.
       * @scenario
       * - Insert an alias whose authoritative transaction is missing or pending.
       * @expected
       * - The stored alias identity rejects.
       */
      it.each(['missing', 'pending'] as const)(
        'rejects a stored alias with %s RPC transaction',
        async (state) => {
          await db.getRepository(AddressTxsEntity).insert(createRow(f));
          if (state === 'missing')
            f.rpc.getTransaction.mockResolvedValue(null as never);
          else
            Object.assign(f.tx, {
              blockHash: null,
              blockNumber: null,
              index: null,
            });
          await expect(async () => {
            await f.network.getActualTxId(f.transaction.unsignedHash);
          }).rejects.toThrow('stored transaction identity');
        },
      );
    });
  });
  describe('getSettledTransactionEvidence', () => {
    describe('exact signed transaction evidence', () => {
      const { fixture, hash, key, blockHash, frontierHash, read } =
        evidenceFixtures;

      let f: ReturnType<typeof fixture>;
      beforeEach(() => {
        f = fixture();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence captures initial frontier %s before numeric canonical lookup
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Mutate the captured finalized number or hash during its numeric canonical lookup.
       * @expected
       * - The original frontier binding rejects the conflicting lookup.
       */
      it.each(['number', 'hash'])(
        'captures initial frontier %s before numeric canonical lookup',
        async (field) => {
          if (field === 'number') f.frontier.number = 9;
          const requested = f.frontier.number;
          const original = f.rpc.getBlock.getMockImplementation()!;
          f.rpc.getBlock.mockImplementation(async (tag) => {
            if (tag === requested) {
              if (field === 'number') f.frontier.number = 12;
              else f.frontier.hash = hash('c');
              return f.frontier;
            }
            return original(tag);
          });
          await expect(async () => {
            await read(f);
          }).rejects.toThrow('finalized block is not canonical');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence returns canonical immutable evidence on chain %s
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Read complete evidence on each supported chain, mutate underlying transaction/receipt fields, and attempt to modify the returned value.
       * @expected
       * - Exact bytes, large integer value, normalized identity and confirmations are retained in an immutable detached object.
       */
      it.each([43113n, 43114n])(
        'returns canonical immutable evidence on chain %s',
        async (chainId) => {
          f = fixture(chainId);
          const evidence = await read(f);
          expect(evidence).toEqual({
            signedBytes: f.signed.serialized,
            hash: f.signed.hash,
            unsignedHash: f.signed.unsignedHash,
            from: f.signed.from!.toLowerCase(),
            chainId,
            nonce: 7,
            blockHash,
            blockNumber: 10,
            index: 0,
            finalizedBlockHash: frontierHash,
            finalizedBlockNumber: 12,
            confirmations: 3,
            status: EvmTxStatus.succeed,
          });
          expect(Object.isFrozen(evidence)).toEqual(true);
          expect(Transaction.from(evidence.signedBytes).value).toEqual(
            9007199254740993n,
          );
          expect(Reflect.set(evidence, 'status', EvmTxStatus.failed)).toEqual(
            false,
          );
          f.tx.blockNumber = 11;
          f.receipt.status = 0;
          expect(evidence.blockNumber).toEqual(10);
          expect(evidence.status).toEqual(EvmTxStatus.succeed);
          expect(f.find).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence returns reverted evidence but preserves success-only getTransaction
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Mark a canonical receipt reverted and compare evidence with success-only transaction retrieval.
       * @expected
       * - Evidence records failure while getTransaction rejects settled failure.
       */
      it('returns reverted evidence but preserves success-only getTransaction', async () => {
        f.receipt.status = 0;
        expect(await read(f)).toMatchObject({
          status: EvmTxStatus.failed,
          confirmations: 3,
        });
        await expect(async () => {
          await f.network.getTransaction(f.signed.hash!, blockHash);
        }).rejects.toThrow('settled success');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence does not impose payment type policy on canonical legacy transactions
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Read a canonical legacy-type signed transaction through evidence.
       * @expected
       * - Evidence retains the legacy type without applying payment policy.
       */
      it('does not impose payment type policy on canonical legacy transactions', async () => {
        f = fixture(43113n, 0);
        expect(Transaction.from((await read(f)).signedBytes).type).toEqual(0);
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence reports one confirmation at the exact finalized frontier for status %s
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Set the transaction block equal to the settled frontier for each receipt status.
       * @expected
       * - The evidence reports exactly one confirmation and the matching frontier identity.
       */
      it.each([0, 1])(
        'reports one confirmation at the exact finalized frontier for status %s',
        async (status) => {
          f.receipt.status = status;
          f.frontier.number = 10;
          f.frontier.hash = blockHash;
          f.frontier.transactions = [f.signed.hash!];
          expect(await read(f)).toMatchObject({
            confirmations: 1,
            finalizedBlockNumber: 10,
            finalizedBlockHash: blockHash,
          });
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects confirmation arithmetic overflow
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Set a zero-height transaction and maximum-safe frontier to overflow the confirmation arithmetic.
       * @expected
       * - The confirmation overflow rejects.
       */
      it('rejects confirmation arithmetic overflow', async () => {
        f.frontier.number = Number.MAX_SAFE_INTEGER;
        f.tx.blockNumber = 0;
        f.receipt.blockNumber = 0;
        f.block.number = 0;
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('confirmation count overflow');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence does not promote an unsettled transaction when frontier number mutates during %s wait
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Advance a previously insufficient frontier during receipt or block lookup.
       * @expected
       * - The initially unsettled transaction remains rejected.
       */
      it.each(['receipt', 'canonical'])(
        'does not promote an unsettled transaction when frontier number mutates during %s wait',
        async (phase) => {
          f.frontier.number = 9;
          if (phase === 'receipt')
            f.rpc.getTransactionReceipt.mockImplementation(async () => {
              f.frontier.number = 12;
              return f.receipt;
            });
          else {
            const original = f.rpc.getBlock.getMockImplementation()!;
            f.rpc.getBlock.mockImplementation(async (tag) => {
              if (tag === 10) f.frontier.number = 12;
              return original(tag);
            });
          }
          await expect(async () => {
            await read(f);
          }).rejects.toThrow('not settled');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence does not replace the finalized hash during %s wait
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Change the captured finalized hash during receipt or block lookup.
       * @expected
       * - The replacement frontier hash cannot make the transaction canonical.
       */
      it.each(['receipt', 'canonical'])(
        'does not replace the finalized hash during %s wait',
        async (phase) => {
          f.frontier.number = 10;
          f.frontier.transactions = [f.signed.hash!];
          if (phase === 'receipt')
            f.rpc.getTransactionReceipt.mockImplementation(async () => {
              f.frontier.hash = blockHash;
              return f.receipt;
            });
          else {
            let numericCalls = 0;
            const original = f.rpc.getBlock.getMockImplementation()!;
            f.rpc.getBlock.mockImplementation(async (tag) => {
              if (tag === 10 && ++numericCalls === 2)
                f.frontier.hash = blockHash;
              return original(tag);
            });
          }
          await expect(async () => {
            await read(f);
          }).rejects.toThrow('not canonical');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence accepts an omitted block requirement and canonicalizes hash case
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Read an uppercase exact signed hash without a required block argument.
       * @expected
       * - The returned signed hash is canonical lowercase.
       */
      it('accepts an omitted block requirement and canonicalizes hash case', async () => {
        const id = '0x' + f.signed.hash!.slice(2).toUpperCase();
        expect(
          (await f.network.getSettledTransactionEvidence(id)).hash,
        ).toEqual(f.signed.hash);
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects malformed exact hash %s before RPC
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Supply each malformed signed-hash argument before reading evidence.
       * @expected
       * - Malformed exact identity rejects before chain RPC.
       */
      it.each(['', '0x12', hash('a') + '00', 1, null])(
        'rejects malformed exact hash %s before RPC',
        async (id) => {
          await expect(async () => {
            await f.network.getSettledTransactionEvidence(id as string);
          }).rejects.toThrow();
          expect(f.rpc.send).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects malformed required block %s before RPC
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Supply each malformed required block identity before reading evidence.
       * @expected
       * - Malformed block identity rejects before chain RPC.
       */
      it.each(['', '0x12', 1, null])(
        'rejects malformed required block %s before RPC',
        async (block) => {
          await expect(async () => {
            await f.network.getSettledTransactionEvidence(
              f.signed.hash!,
              block as string,
            );
          }).rejects.toThrow();
          expect(f.rpc.send).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects another required block
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Require a block hash different from the synthetic transaction block.
       * @expected
       * - The conflicting required block rejects.
       */
      it('rejects another required block', async () => {
        await expect(async () => {
          await f.network.getSettledTransactionEvidence(
            f.signed.hash!,
            hash('c'),
          );
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence never resolves an unsigned alias as a signed hash
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Request evidence with the unsigned alias rather than the exact signed hash.
       * @expected
       * - The request rejects without resolving a stored alias.
       */
      it('never resolves an unsigned alias as a signed hash', async () => {
        await expect(async () => {
          await f.network.getSettledTransactionEvidence(f.signed.unsignedHash);
        }).rejects.toThrow();
        expect(f.find).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence defers absent transactions
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Return no transaction for the exact signed hash.
       * @expected
       * - Evidence remains unavailable as not settled.
       */
      it('defers absent transactions', async () => {
        f.rpc.getTransaction.mockResolvedValue(null);
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('not settled');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence defers pending transactions
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Clear block placement on the transaction before reading evidence.
       * @expected
       * - Pending evidence rejects before receipt lookup.
       */
      it('defers pending transactions', async () => {
        Object.assign(f.tx, {
          blockHash: null,
          blockNumber: null,
          index: undefined,
        });
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('not settled');
        expect(f.rpc.getTransactionReceipt).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects isolated transaction %s=%s
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Change exactly one transaction field from the table while keeping the requested signed hash.
       * @expected
       * - The inconsistent transaction rejects.
       */
      it.each([
        ['hash', hash('c')],
        ['chainId', 43114n],
        ['from', '0x' + '33'.repeat(20)],
        ['nonce', -1],
        ['nonce', 1.5],
        ['nonce', Number.MAX_SAFE_INTEGER + 1],
        ['nonce', 8],
        ['value', '9007199254740994'],
        ['data', '0xabce'],
        ['signature', null],
        ['blockHash', null],
        ['blockNumber', -1],
        ['blockNumber', 1.5],
        ['blockNumber', Number.MAX_SAFE_INTEGER + 1],
        ['index', -1],
        ['index', 1.5],
        ['index', Number.MAX_SAFE_INTEGER + 1],
        ['index', 1],
      ])('rejects isolated transaction %s=%s', async (field, value) => {
        Object.assign(f.tx, { [field as string]: value });
        await expect(async () => {
          await read(f);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects an altered signature even if RPC supplies the requested hash
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Alter the signature while leaving the RPC-provided requested hash unchanged.
       * @expected
       * - The contradictory signed transaction rejects.
       */
      it('rejects an altered signature even if RPC supplies the requested hash', async () => {
        f.tx.signature = key.sign(hash('f'));
        await expect(async () => {
          await read(f);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects isolated receipt %s=%s
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Change exactly one receipt identity/status field from the table.
       * @expected
       * - The contradictory receipt rejects.
       */
      it.each([
        ['hash', hash('c')],
        ['blockHash', hash('c')],
        ['blockNumber', 11],
        ['index', 1],
        ['status', 2],
        ['status', null],
        ['status', '1'],
        ['blockNumber', -1],
        ['index', Number.MAX_SAFE_INTEGER + 1],
      ])('rejects isolated receipt %s=%s', async (field, value) => {
        Object.assign(f.receipt, { [field as string]: value });
        await expect(async () => {
          await read(f);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence defers a missing receipt
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Return no receipt for an otherwise canonical transaction.
       * @expected
       * - Evidence rejects the missing receipt.
       */
      it('defers a missing receipt', async () => {
        f.rpc.getTransactionReceipt.mockResolvedValue(null);
        await expect(async () => {
          await read(f);
        }).rejects.toThrow();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence does not expose premature status %s as evidence
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Set each receipt status while keeping the transaction above the settled frontier.
       * @expected
       * - Premature status never becomes settled evidence.
       */
      it.each([0, 1])(
        'does not expose premature status %s as evidence',
        async (status) => {
          f.receipt.status = status;
          f.frontier.number = 9;
          await expect(async () => {
            await read(f);
          }).rejects.toThrow('not settled');
        },
      );

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects wrong chain before reading transaction
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Return another C-Chain identity before transaction retrieval.
       * @expected
       * - The chain mismatch rejects before reading the transaction.
       */
      it('rejects wrong chain before reading transaction', async () => {
        f.rpc.send.mockResolvedValue('0xa86a');
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('chain ID');
        expect(f.rpc.getTransaction).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects canonical block hash conflict
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Change the canonical transaction block hash.
       * @expected
       * - The block identity conflict rejects.
       */
      it('rejects canonical block hash conflict', async () => {
        f.block.hash = hash('c');
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects block inclusion mismatch
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Replace the transaction hash at its canonical inclusion index.
       * @expected
       * - The block inclusion mismatch rejects.
       */
      it('rejects block inclusion mismatch', async () => {
        f.block.transactions[0] = hash('c');
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('inclusion');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects conflicting finalized number binding
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Return a conflicting hash for the numeric finalized-block lookup.
       * @expected
       * - The finalized binding rejects.
       */
      it('rejects conflicting finalized number binding', async () => {
        const original = f.rpc.getBlock.getMockImplementation()!;
        f.rpc.getBlock.mockImplementation(async (tag) =>
          tag === 12 ? { ...f.frontier, hash: hash('c') } : original(tag),
        );
        await expect(async () => {
          await read(f);
        }).rejects.toThrow('finalized block');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence propagates RPC failure without latest fallback
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Reject the finalized lookup with one exact error instance.
       * @expected
       * - The same error instance propagates with no latest fallback.
       */
      it('propagates RPC failure without latest fallback', async () => {
        const error = Error('fixture RPC unavailable');
        f.rpc.getBlock.mockRejectedValue(error);
        await expect(read(f)).rejects.toBe(error);
        expect(f.rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence retains the receipt status validated before an awaited block read
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Mutate receipt status during the awaited transaction block lookup after validation.
       * @expected
       * - Evidence retains the validated successful receipt status.
       */
      it('retains the receipt status validated before an awaited block read', async () => {
        const original = f.rpc.getBlock.getMockImplementation()!;
        f.rpc.getBlock.mockImplementation(async (tag) => {
          if (tag === 10) f.receipt.status = 2;
          return original(tag);
        });
        expect((await read(f)).status).toEqual(EvmTxStatus.succeed);
      });

      /**
       * @target AvalancheRpcNetwork.getSettledTransactionEvidence rejects transaction %s mutation after receipt validation
       * @dependencies
       * - Synthetic signed transaction, canonical/finalized blocks and receipt fixtures.
       * - Mocked exact RPC methods and a repository lookup that forbids alias resolution.
       * @scenario
       * - Change one transaction block-placement field during the awaited block lookup after receipt validation.
       * @expected
       * - The mutated transaction placement rejects.
       */
      it.each(['blockHash', 'blockNumber', 'index'])(
        'rejects transaction %s mutation after receipt validation',
        async (field) => {
          const original = f.rpc.getBlock.getMockImplementation()!;
          f.rpc.getBlock.mockImplementation(async (tag) => {
            if (tag === 10)
              Object.assign(f.tx, {
                [field]: field === 'blockHash' ? hash('c') : 11,
              });
            return original(tag);
          });
          await expect(async () => {
            await read(f);
          }).rejects.toThrow();
        },
      );
    });
  });
  describe('getAddressBalanceForNativeToken', () => {
    describe('settled canonical state', () => {
      const { setup, word, address, token, hash } = stateFixtures;
      const name = stateFixtures.reads[0][0];
      const read = stateFixtures.reads[0][1];
      const method = stateFixtures.reads[0][2];

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken reads the exact settled height and rechecks canonical identity
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Read each public state operation and inspect the exact RPC sequence and block binding.
       * @expected
       * - The result uses settled height, exact raw method, canonical postcheck and chain recheck; SDK latest-state helpers are unused.
       */
      it('reads the exact settled height and rechecks canonical identity', async () => {
        const { network, rpc } = setup();
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 9 : 9n);
        const params =
          method === 'eth_call'
            ? [
                {
                  to: token,
                  data: `0x70a08231${address.slice(2).padStart(64, '0')}`,
                },
                '0x2a',
              ]
            : [address, '0x2a'];
        expect(rpc.send.mock.calls).toEqual([
          ['eth_chainId', []],
          [method, params],
          ['eth_getBlockByNumber', ['0x2a', false]],
          ['eth_chainId', []],
        ]);
        expect(rpc.getBlock.mock.calls).toEqual([['finalized'], [42]]);
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects a mismatched raw chain before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a mismatched raw chain ID before invoking the selected state operation.
       * @expected
       * - The chain mismatch rejects before state helpers.
       */
      it('rejects a mismatched raw chain before reading state', async () => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValue('0x1');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects malformed chain identity %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each malformed chain identity before reading the selected state quantity.
       * @expected
       * - Malformed identity rejects before block lookup.
       */
      it.each(['0x0a869', 43113, null])(
        'rejects malformed chain identity %s',
        async (identity) => {
          const { network, rpc } = setup();
          rpc.send.mockResolvedValueOnce(identity);
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('chain ID');
          expect(rpc.getBlock).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects an unavailable settled frontier without a latest fallback
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no settled frontier for the selected state operation.
       * @expected
       * - The read rejects after one finalized lookup without latest fallback.
       */
      it('rejects an unavailable settled frontier without a latest fallback', async () => {
        const { network, rpc } = setup();
        rpc.getBlock.mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('block unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(1);
        expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects unsafe frontier height %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each unsafe finalized height while keeping its block identity.
       * @expected
       * - The malformed block number rejects before a state call.
       */
      it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        'rejects unsafe frontier height %s',
        async (number) => {
          const { network, rpc, block } = setup();
          rpc.getBlock.mockResolvedValueOnce({ ...block, number });
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('block number');
          expect(rpc.send).toHaveBeenCalledTimes(1);
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects a frontier that is not canonical before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Make finalized and by-number canonical block hashes disagree.
       * @expected
       * - The state read rejects before issuing the raw state request.
       */
      it('rejects a frontier that is not canonical before reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.getBlock
          .mockResolvedValueOnce(block)
          .mockResolvedValueOnce({ ...block, hash: `0x${'cc'.repeat(32)}` });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('not canonical');
        expect(rpc.send).toHaveBeenCalledTimes(1);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects a changed canonical hash after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a changed canonical hash after the state response.
       * @expected
       * - The post-response block binding rejects.
       */
      it('rejects a changed canonical hash after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({
            ...block,
            number: '0x2a',
            hash: `0x${'cc'.repeat(32)}`,
          });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects a changed canonical height after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return another canonical height after the state response.
       * @expected
       * - The post-response height binding rejects.
       */
      it('rejects a changed canonical height after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ ...block, number: '0x2b' });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects an unavailable canonical block after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no canonical block after the state response.
       * @expected
       * - The post-response canonical binding rejects.
       */
      it('rejects an unavailable canonical block after reading state', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects a chain switch during the state response
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return the other supported chain after the state response and block check.
       * @expected
       * - The final chain recheck rejects.
       */
      it('rejects a chain switch during the state response', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ number: '0x2a', hash })
          .mockResolvedValueOnce('0xa86a');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken propagates the state failure without retrying at latest
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Reject the raw state request after chain identity succeeds.
       * @expected
       * - The error propagates with exactly two sends and no latest retry.
       */
      it('propagates the state failure without retrying at latest', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockRejectedValueOnce(new Error('state unavailable'));
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(2);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken accepts zero at a settled genesis block
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Set the settled block to genesis and supply zero state quantity.
       * @expected
       * - The exact genesis tag and zero balance/nonce are preserved.
       */
      it('accepts zero at a settled genesis block', async () => {
        const { network, rpc, block } = setup();
        block.number = 0;
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(0n) : '0x0');
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 0 : 0n);
        expect(rpc.send.mock.calls[1][1].at(-1)).toEqual('0x0');
      });
    });
    describe('state payload boundaries', () => {
      const { setup, word, address, token } = stateFixtures;

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects malformed native balance %s
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply each malformed native balance quantity.
       * @expected
       * - State quantity validation rejects.
       */
      it.each([
        null,
        9,
        9n,
        '',
        '0x',
        '0x00',
        '0x01',
        '9',
        '-0x1',
        '0X9',
        '0xg',
        `0x1${'0'.repeat(64)}`,
        '0x9\n',
      ])('rejects malformed native balance %s', async (value) => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValueOnce('0xa869').mockResolvedValueOnce(value);
        await expect(async () => {
          await network.getAddressBalanceForNativeToken(address);
        }).rejects.toThrow('state quantity');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken preserves the maximum uint256 native balance exactly
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply the maximum uint256 as the native RPC balance quantity.
       * @expected
       * - The full uint256 value is preserved exactly.
       */
      it('preserves the maximum uint256 native balance exactly', async () => {
        const { network, rpc } = setup();
        const max = (1n << 256n) - 1n;
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(word(max));
        await expect(
          network.getAddressBalanceForNativeToken(address),
        ).resolves.toEqual(max);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForNativeToken rejects address resolution or malformed address %s before RPC
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Pass each malformed or name-resolved account/token address to all relevant public state readers.
       * @expected
       * - Address validation rejects before RPC or block lookup.
       */
      it.each(['alice.eth', '0x12', ''])(
        'rejects address resolution or malformed address %s before RPC',
        async (invalid) => {
          const { network, rpc } = setup();
          await expect(async () => {
            await network.getAddressBalanceForNativeToken(invalid);
          }).rejects.toThrow();
          await expect(async () => {
            await network.getAddressBalanceForERC20Asset(invalid, token);
          }).rejects.toThrow();
          await expect(async () => {
            await network.getAddressBalanceForERC20Asset(address, invalid);
          }).rejects.toThrow();
          await expect(async () => {
            await network.getAddressNextAvailableNonce(invalid);
          }).rejects.toThrow();
          expect(rpc.send).not.toHaveBeenCalled();
          expect(rpc.getBlock).not.toHaveBeenCalled();
        },
      );
    });
  });
  describe('getAddressBalanceForERC20Asset', () => {
    describe('settled canonical state', () => {
      const { setup, word, address, token, hash } = stateFixtures;
      const name = stateFixtures.reads[1][0];
      const read = stateFixtures.reads[1][1];
      const method = stateFixtures.reads[1][2];

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset reads the exact settled height and rechecks canonical identity
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Read each public state operation and inspect the exact RPC sequence and block binding.
       * @expected
       * - The result uses settled height, exact raw method, canonical postcheck and chain recheck; SDK latest-state helpers are unused.
       */
      it('reads the exact settled height and rechecks canonical identity', async () => {
        const { network, rpc } = setup();
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 9 : 9n);
        const params =
          method === 'eth_call'
            ? [
                {
                  to: token,
                  data: `0x70a08231${address.slice(2).padStart(64, '0')}`,
                },
                '0x2a',
              ]
            : [address, '0x2a'];
        expect(rpc.send.mock.calls).toEqual([
          ['eth_chainId', []],
          [method, params],
          ['eth_getBlockByNumber', ['0x2a', false]],
          ['eth_chainId', []],
        ]);
        expect(rpc.getBlock.mock.calls).toEqual([['finalized'], [42]]);
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects a mismatched raw chain before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a mismatched raw chain ID before invoking the selected state operation.
       * @expected
       * - The chain mismatch rejects before state helpers.
       */
      it('rejects a mismatched raw chain before reading state', async () => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValue('0x1');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects malformed chain identity %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each malformed chain identity before reading the selected state quantity.
       * @expected
       * - Malformed identity rejects before block lookup.
       */
      it.each(['0x0a869', 43113, null])(
        'rejects malformed chain identity %s',
        async (identity) => {
          const { network, rpc } = setup();
          rpc.send.mockResolvedValueOnce(identity);
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('chain ID');
          expect(rpc.getBlock).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects an unavailable settled frontier without a latest fallback
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no settled frontier for the selected state operation.
       * @expected
       * - The read rejects after one finalized lookup without latest fallback.
       */
      it('rejects an unavailable settled frontier without a latest fallback', async () => {
        const { network, rpc } = setup();
        rpc.getBlock.mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('block unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(1);
        expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects unsafe frontier height %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each unsafe finalized height while keeping its block identity.
       * @expected
       * - The malformed block number rejects before a state call.
       */
      it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        'rejects unsafe frontier height %s',
        async (number) => {
          const { network, rpc, block } = setup();
          rpc.getBlock.mockResolvedValueOnce({ ...block, number });
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('block number');
          expect(rpc.send).toHaveBeenCalledTimes(1);
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects a frontier that is not canonical before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Make finalized and by-number canonical block hashes disagree.
       * @expected
       * - The state read rejects before issuing the raw state request.
       */
      it('rejects a frontier that is not canonical before reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.getBlock
          .mockResolvedValueOnce(block)
          .mockResolvedValueOnce({ ...block, hash: `0x${'cc'.repeat(32)}` });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('not canonical');
        expect(rpc.send).toHaveBeenCalledTimes(1);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects a changed canonical hash after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a changed canonical hash after the state response.
       * @expected
       * - The post-response block binding rejects.
       */
      it('rejects a changed canonical hash after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({
            ...block,
            number: '0x2a',
            hash: `0x${'cc'.repeat(32)}`,
          });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects a changed canonical height after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return another canonical height after the state response.
       * @expected
       * - The post-response height binding rejects.
       */
      it('rejects a changed canonical height after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ ...block, number: '0x2b' });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects an unavailable canonical block after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no canonical block after the state response.
       * @expected
       * - The post-response canonical binding rejects.
       */
      it('rejects an unavailable canonical block after reading state', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects a chain switch during the state response
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return the other supported chain after the state response and block check.
       * @expected
       * - The final chain recheck rejects.
       */
      it('rejects a chain switch during the state response', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ number: '0x2a', hash })
          .mockResolvedValueOnce('0xa86a');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset propagates the state failure without retrying at latest
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Reject the raw state request after chain identity succeeds.
       * @expected
       * - The error propagates with exactly two sends and no latest retry.
       */
      it('propagates the state failure without retrying at latest', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockRejectedValueOnce(new Error('state unavailable'));
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(2);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset accepts zero at a settled genesis block
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Set the settled block to genesis and supply zero state quantity.
       * @expected
       * - The exact genesis tag and zero balance/nonce are preserved.
       */
      it('accepts zero at a settled genesis block', async () => {
        const { network, rpc, block } = setup();
        block.number = 0;
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(0n) : '0x0');
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 0 : 0n);
        expect(rpc.send.mock.calls[1][1].at(-1)).toEqual('0x0');
      });
    });
    describe('state payload boundaries', () => {
      const { setup, word, address, token } = stateFixtures;

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset rejects malformed ERC-20 return data %s
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply each malformed ERC20 ABI return payload.
       * @expected
       * - ERC20 balance decoding rejects.
       */
      it.each([
        null,
        9,
        9n,
        '',
        '0x9',
        `0x${'0'.repeat(63)}`,
        `0x${'0'.repeat(65)}`,
        `0x${'0'.repeat(128)}`,
        `${word(9n)}\n`,
        `0x${'g'.repeat(64)}`,
      ])('rejects malformed ERC-20 return data %s', async (value) => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValueOnce('0xa869').mockResolvedValueOnce(value);
        await expect(async () => {
          await network.getAddressBalanceForERC20Asset(address, token);
        }).rejects.toThrow('ERC-20 balance');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressBalanceForERC20Asset preserves the maximum uint256 erc20 balance exactly
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply the maximum uint256 as the ABI-encoded token balance return word.
       * @expected
       * - The full uint256 value is preserved exactly.
       */
      it('preserves the maximum uint256 erc20 balance exactly', async () => {
        const { network, rpc } = setup();
        const max = (1n << 256n) - 1n;
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(word(max));
        await expect(
          network.getAddressBalanceForERC20Asset(address, token),
        ).resolves.toEqual(max);
      });
    });
  });
  describe('getAddressNextAvailableNonce', () => {
    describe('settled canonical state', () => {
      const { setup, word, address, token, hash } = stateFixtures;
      const name = stateFixtures.reads[2][0];
      const read = stateFixtures.reads[2][1];
      const method = stateFixtures.reads[2][2];

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce reads the exact settled height and rechecks canonical identity
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Read each public state operation and inspect the exact RPC sequence and block binding.
       * @expected
       * - The result uses settled height, exact raw method, canonical postcheck and chain recheck; SDK latest-state helpers are unused.
       */
      it('reads the exact settled height and rechecks canonical identity', async () => {
        const { network, rpc } = setup();
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 9 : 9n);
        const params =
          method === 'eth_call'
            ? [
                {
                  to: token,
                  data: `0x70a08231${address.slice(2).padStart(64, '0')}`,
                },
                '0x2a',
              ]
            : [address, '0x2a'];
        expect(rpc.send.mock.calls).toEqual([
          ['eth_chainId', []],
          [method, params],
          ['eth_getBlockByNumber', ['0x2a', false]],
          ['eth_chainId', []],
        ]);
        expect(rpc.getBlock.mock.calls).toEqual([['finalized'], [42]]);
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects a mismatched raw chain before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a mismatched raw chain ID before invoking the selected state operation.
       * @expected
       * - The chain mismatch rejects before state helpers.
       */
      it('rejects a mismatched raw chain before reading state', async () => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValue('0x1');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
        expect(rpc.getBalance).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.call).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects malformed chain identity %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each malformed chain identity before reading the selected state quantity.
       * @expected
       * - Malformed identity rejects before block lookup.
       */
      it.each(['0x0a869', 43113, null])(
        'rejects malformed chain identity %s',
        async (identity) => {
          const { network, rpc } = setup();
          rpc.send.mockResolvedValueOnce(identity);
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('chain ID');
          expect(rpc.getBlock).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects an unavailable settled frontier without a latest fallback
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no settled frontier for the selected state operation.
       * @expected
       * - The read rejects after one finalized lookup without latest fallback.
       */
      it('rejects an unavailable settled frontier without a latest fallback', async () => {
        const { network, rpc } = setup();
        rpc.getBlock.mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('block unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(1);
        expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith('finalized');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects unsafe frontier height %s
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Supply each unsafe finalized height while keeping its block identity.
       * @expected
       * - The malformed block number rejects before a state call.
       */
      it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        'rejects unsafe frontier height %s',
        async (number) => {
          const { network, rpc, block } = setup();
          rpc.getBlock.mockResolvedValueOnce({ ...block, number });
          await expect(async () => {
            await read(network);
          }).rejects.toThrow('block number');
          expect(rpc.send).toHaveBeenCalledTimes(1);
        },
      );

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects a frontier that is not canonical before reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Make finalized and by-number canonical block hashes disagree.
       * @expected
       * - The state read rejects before issuing the raw state request.
       */
      it('rejects a frontier that is not canonical before reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.getBlock
          .mockResolvedValueOnce(block)
          .mockResolvedValueOnce({ ...block, hash: `0x${'cc'.repeat(32)}` });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('not canonical');
        expect(rpc.send).toHaveBeenCalledTimes(1);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects a changed canonical hash after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return a changed canonical hash after the state response.
       * @expected
       * - The post-response block binding rejects.
       */
      it('rejects a changed canonical hash after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({
            ...block,
            number: '0x2a',
            hash: `0x${'cc'.repeat(32)}`,
          });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects a changed canonical height after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return another canonical height after the state response.
       * @expected
       * - The post-response height binding rejects.
       */
      it('rejects a changed canonical height after reading state', async () => {
        const { network, rpc, block } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ ...block, number: '0x2b' });
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects an unavailable canonical block after reading state
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return no canonical block after the state response.
       * @expected
       * - The post-response canonical binding rejects.
       */
      it('rejects an unavailable canonical block after reading state', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce(null);
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state block is not canonical');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects a chain switch during the state response
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Return the other supported chain after the state response and block check.
       * @expected
       * - The final chain recheck rejects.
       */
      it('rejects a chain switch during the state response', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(9n) : '0x9')
          .mockResolvedValueOnce({ number: '0x2a', hash })
          .mockResolvedValueOnce('0xa86a');
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('chain ID');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce propagates the state failure without retrying at latest
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Reject the raw state request after chain identity succeeds.
       * @expected
       * - The error propagates with exactly two sends and no latest retry.
       */
      it('propagates the state failure without retrying at latest', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockRejectedValueOnce(new Error('state unavailable'));
        await expect(async () => {
          await read(network);
        }).rejects.toThrow('state unavailable');
        expect(rpc.send).toHaveBeenCalledTimes(2);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce accepts zero at a settled genesis block
       * @dependencies
       * - Mocked raw chain/state RPC and canonical/finalized block lookup.
       * - Synthetic account, contract and ABI quantity fixtures.
       * @scenario
       * - Set the settled block to genesis and supply zero state quantity.
       * @expected
       * - The exact genesis tag and zero balance/nonce are preserved.
       */
      it('accepts zero at a settled genesis block', async () => {
        const { network, rpc, block } = setup();
        block.number = 0;
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce(name === 'erc20' ? word(0n) : '0x0');
        await expect(read(network)).resolves.toEqual(name === 'nonce' ? 0 : 0n);
        expect(rpc.send.mock.calls[1][1].at(-1)).toEqual('0x0');
      });
    });
    describe('state payload boundaries', () => {
      const { setup, address } = stateFixtures;

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects malformed nonce %s
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply each malformed nonce quantity.
       * @expected
       * - State quantity validation rejects.
       */
      it.each([
        null,
        9,
        9n,
        '',
        '0x',
        '0x00',
        '0x01',
        '-0x1',
        '0xg',
        `0x1${'0'.repeat(64)}`,
        '0x9\n',
      ])('rejects malformed nonce %s', async (value) => {
        const { network, rpc } = setup();
        rpc.send.mockResolvedValueOnce('0xa869').mockResolvedValueOnce(value);
        await expect(async () => {
          await network.getAddressNextAvailableNonce(address);
        }).rejects.toThrow('state quantity');
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce preserves the maximum safe integer nonce
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply the largest safe JavaScript nonce quantity.
       * @expected
       * - The maximum safe integer is preserved.
       */
      it('preserves the maximum safe integer nonce', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce('0x1fffffffffffff');
        await expect(
          network.getAddressNextAvailableNonce(address),
        ).resolves.toEqual(Number.MAX_SAFE_INTEGER);
      });

      /**
       * @target AvalancheRpcNetwork.getAddressNextAvailableNonce rejects nonce conversion overflow
       * @dependencies
       * - Mocked raw chain/state RPC and block lookups.
       * - Synthetic address and uint256 ABI fixtures.
       * @scenario
       * - Supply a nonce one above the largest safe JavaScript integer.
       * @expected
       * - Conversion rejects safe-integer overflow.
       */
      it('rejects nonce conversion overflow', async () => {
        const { network, rpc } = setup();
        rpc.send
          .mockResolvedValueOnce('0xa869')
          .mockResolvedValueOnce('0x20000000000000');
        await expect(async () => {
          await network.getAddressNextAvailableNonce(address);
        }).rejects.toThrow('safe integer');
      });
    });
  });
  describe('submitAuthorizedTransaction', () => {
    describe('captured authority and loopback', () => {
      const { network, signed, connection, ok, delay, listen } =
        submissionFixtures;

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction rejects captured network %s mutation during chain assertion
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Mutate transaction, network chain ID or captured connection during the chain identity assertion.
       * @expected
       * - Captured identity drift rejects before transport.
       */
      it.each(['transaction', 'chain', 'connection'])(
        'rejects captured network %s mutation during chain assertion',
        async (field) => {
          const net = network(),
            tx = signed(),
            request = connection(),
            transport = request.getUrlFunc;
          vi.spyOn(net['provider'], '_getConnection').mockImplementation(() =>
            request.clone(),
          );
          vi.spyOn(net['provider'], 'send').mockImplementation(async () => {
            if (field === 'transaction') tx.value = 99n;
            if (field === 'chain') Reflect.set(net, 'expectedChainId', 43114n);
            if (field === 'connection') request.url = 'https://changed.invalid';
            return '0xa869';
          });
          await expect(
            net.submitAuthorizedTransaction(tx, async (start) => start()),
          ).rejects.toMatchObject({
            reason: expect.stringMatching(/invalid|transport/),
          });
          expect(transport).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction rejects wrong RPC chain identity before authorization
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Return the other chain identity during network validation before authorization.
       * @expected
       * - The chain mismatch rejects before authority or transport.
       */
      it('rejects wrong RPC chain identity before authorization', async () => {
        const net = network(),
          request = connection(),
          transport = request.getUrlFunc,
          authorize = vi.fn();
        vi.spyOn(net['provider'], '_getConnection').mockImplementation(() =>
          request.clone(),
        );
        vi.spyOn(net['provider'], 'send').mockResolvedValue('0xa86a');
        await expect(async () => {
          await net.submitAuthorizedTransaction(signed(), authorize);
        }).rejects.toThrow();
        expect(authorize).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction keeps owned transport when SDK global transport changes after capture
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Replace the SDK global transport during the identity check after the request is captured.
       * @expected
       * - The owned transport sends once; the replacement is never invoked.
       */
      it('keeps owned transport when SDK global transport changes after capture', async () => {
        const original = new FetchRequest('https://fixture.invalid').getUrlFunc;
        const fixture = await listen(() => ({
          status: 200,
          body: { jsonrpc: '2.0', id: 1, result: signed().hash },
        }));
        const net = network(fixture.url),
          replacement = vi.fn(async () => ok()),
          authorize = vi.fn(async (start: () => void) => start());
        vi.spyOn(net['provider'], 'send').mockImplementation(async () => {
          FetchRequest.registerGetUrl(replacement);
          return '0xa869';
        });
        try {
          await expect(
            net.submitAuthorizedTransaction(signed(), authorize),
          ).resolves.toBeUndefined();
          expect(authorize).toHaveBeenCalledOnce();
          expect(replacement).not.toHaveBeenCalled();
          expect(fixture.bodies).toHaveLength(1);
        } finally {
          FetchRequest.registerGetUrl(original);
        }
      });

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction rejects current source %s drift inside authorization
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Wait inside authority and change one current transport/timeout/credential/callback/provider binding.
       * @expected
       * - Current-source drift rejects before transport; the fixture provider is restored.
       */
      it.each(['getUrl', 'timeout', 'credentials', 'callback', 'provider'])(
        'rejects current source %s drift inside authorization',
        async (field) => {
          const net = network(),
            request = connection(),
            transport = request.getUrlFunc;
          const provider = net['provider'];
          vi.spyOn(net['provider'], '_getConnection').mockImplementation(() =>
            request.clone(),
          );
          vi.spyOn(net['provider'], 'send').mockResolvedValue('0xa869');
          await expect(
            net.submitAuthorizedTransaction(signed(), async (start) => {
              await delay(0);
              if (field === 'getUrl') request.getUrlFunc = async () => ok();
              if (field === 'timeout') request.timeout = 2000;
              if (field === 'credentials')
                request.setCredentials('different', 'fixture');
              if (field === 'callback')
                net.assertNetwork = async () => undefined;
              if (field === 'provider') Reflect.set(net, 'provider', {});
              start();
            }),
          ).rejects.toMatchObject({ reason: 'invalid' });
          if (field === 'provider') Reflect.set(net, 'provider', provider);
          expect(transport).not.toHaveBeenCalled();
        },
      );

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction rejects unprotected/wrong-chain signed input before any chain RPC
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Change the signed input chain before qualified network submission.
       * @expected
       * - Unprotected/wrong-chain input rejects before any chain RPC.
       */
      it('rejects unprotected/wrong-chain signed input before any chain RPC', async () => {
        const net = network(),
          send = vi.spyOn(net['provider'], 'send');
        const tx = signed();
        tx.chainId = 43114n;
        await expect(async () => {
          await net.submitAuthorizedTransaction(tx, async (start) => start());
        }).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();
      });

      /**
       * @target AvalancheRpcNetwork.submitAuthorizedTransaction submits one real FetchRequest POST with exact RPC body, hash and captured credentials
       * @dependencies
       * - Real qualified submission helper and synthetic protected transaction.
       * - Spies on provider identity/current connection and authorization callbacks.
       * - Synthetic loopback submission peer or captured response mock.
       * @scenario
       * - Submit protected bytes over loopback with captured Basic fixture credentials and one custom header.
       * @expected
       * - The exact POST body/hash/path/headers are retained without legacy broadcastTransaction.
       */
      it('submits one real FetchRequest POST with exact RPC body, hash and captured credentials', async () => {
        const fixture = await listen(() => ({
          status: 200,
          body: { jsonrpc: '2.0', id: 1, result: signed().hash },
        }));
        const net = network(fixture.url),
          request = net['provider']._getConnection();
        request.setCredentials('fixture', 'password');
        request.allowInsecureAuthentication = true;
        request.setHeader('x-fixture', 'captured');
        vi.spyOn(net['provider'], '_getConnection').mockImplementation(() =>
          request.clone(),
        );
        vi.spyOn(net['provider'], 'send').mockResolvedValue('0xa869');
        const broadcast = vi.spyOn(net['provider'], 'broadcastTransaction');
        await net.submitAuthorizedTransaction(signed(), async (start) =>
          start(),
        );
        expect(fixture.bodies).toEqual([
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendRawTransaction',
            params: [signed().serialized],
          },
        ]);
        expect(fixture.paths).toEqual(['/rpc/token']);
        expect(fixture.headers[0]).toMatchObject({
          authorization:
            'Basic ' + Buffer.from('fixture:password').toString('base64'),
          'x-fixture': 'captured',
        });
        expect(broadcast).not.toHaveBeenCalled();
      });
    });
  });
});
