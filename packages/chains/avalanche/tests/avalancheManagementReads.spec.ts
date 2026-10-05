import { Block, getAddress } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenMap } from '@rosen-bridge/tokens';
import {
  ConfirmationStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { configs } from './avalancheTestData';
import {
  closeChainFixtures,
  createChainFixture as setup,
} from './avalancheTestUtils';

describe('AvalancheChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeChainFixtures();
  });

  describe('getTxRequiredConfirmation', () => {
    /**
     * @target AvalancheChain.getTxRequiredConfirmation projects the distinct $field policy without RPC
     * @dependencies
     * - Real AvalancheChain with five distinct synthetic confirmation counts.
     * @scenario
     * - Query each admitted type with the same complete configuration.
     * @expected
     * - Each type returns its own count, without network or transaction reads.
     */
    it.each([
      { type: TransactionType.lock, field: 'observation', count: 11 },
      { type: TransactionType.payment, field: 'payment', count: 13 },
      { type: TransactionType.coldStorage, field: 'cold', count: 17 },
      { type: TransactionType.manual, field: 'manual', count: 19 },
      { type: TransactionType.arbitrary, field: 'arbitrary', count: 23 },
    ])('projects the distinct $field policy without RPC', ({ type, count }) => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        confirmations: {
          observation: 11,
          payment: 13,
          cold: 17,
          manual: 19,
          arbitrary: 23,
        },
      });
      const read = vi.spyOn(network, 'getTxConfirmation');
      expect(chain.getTxRequiredConfirmation(type)).toEqual(count);
      expect(networkCheck).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getTxRequiredConfirmation rejects invalid $field count $value before RPC
     * @dependencies
     * - Real chain and one isolated invalid configuration field.
     * @scenario
     * - Supply each malformed count before constructing the chain and query its type.
     * @expected
     * - The malformed count rejects without qualifying or reading transactions.
     */
    it.each(
      [
        [TransactionType.lock, 'observation'],
        [TransactionType.payment, 'payment'],
        [TransactionType.coldStorage, 'cold'],
        [TransactionType.manual, 'manual'],
        [TransactionType.arbitrary, 'arbitrary'],
      ].flatMap(([type, field]) =>
        [
          undefined,
          null,
          '11',
          true,
          0,
          -1,
          1.5,
          NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
          1n,
        ].map((value) => ({ type: type as TransactionType, field, value })),
      ),
    )(
      'rejects invalid $field count $value before RPC',
      ({ type, field, value }) => {
        const config = structuredClone(configs);
        Reflect.set(config.confirmations, field, value);
        const { chain, network, networkCheck } = setup(43113n, config);
        const read = vi.spyOn(network, 'getTxConfirmation');
        expect(() => chain.getTxRequiredConfirmation(type)).toThrow(
          'Invalid Avalanche confirmation policy',
        );
        expect(networkCheck).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.getTxRequiredConfirmation refuses unsupported %s before RPC
     * @dependencies
     * - Real chain and synthetic unsupported route values.
     * @scenario
     * - Query rewards, an unknown string and an absent type.
     * @expected
     * - Each unsupported type rejects without any transaction observation.
     */
    it.each([TransactionType.reward, 'unknown', undefined])(
      'refuses unsupported %s before RPC',
      async (type) => {
        const { chain, network, networkCheck } = setup();
        const read = vi.spyOn(network, 'getTxConfirmation');
        await expect(
          chain.getTxConfirmationStatus(
            '0x' + 'ab'.repeat(32),
            type as TransactionType,
          ),
        ).rejects.toThrow('Unsupported Avalanche transaction route');
        expect(read).not.toHaveBeenCalled();
        expect(networkCheck).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.getTxRequiredConfirmation rejects changed %s policy before RPC
     * @dependencies
     * - Real chain whose original policy was captured at construction.
     * @scenario
     * - Change one valid count after constructing the chain, then query payment policy.
     * @expected
     * - A stale policy cannot be used for transaction observation.
     */
    it.each(['observation', 'payment', 'cold', 'manual', 'arbitrary'])(
      'rejects changed %s policy before RPC',
      (field) => {
        const { chain, network, networkCheck } = setup();
        const read = vi.spyOn(network, 'getTxConfirmation');
        Reflect.set(chain.configs.confirmations, field, 29);
        expect(() =>
          chain.getTxRequiredConfirmation(TransactionType.payment),
        ).toThrow('Avalanche read configuration changed');
        expect(read).not.toHaveBeenCalled();
        expect(networkCheck).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.getTxRequiredConfirmation refuses replaced %s read identity before RPC
     * @dependencies
     * - Real configured chain and one changed configuration or adapter identity.
     * @scenario
     * - Replace one captured object, chain identifier or native-chain label.
     * @expected
     * - The changed read identity rejects without any observation or qualification.
     */
    it.each([
      'configs',
      'confirmations',
      'network',
      'chainId',
      'expectedChainId',
      'chain',
      'native',
    ])('refuses replaced %s read identity before RPC', (field) => {
      const { chain, network, networkCheck } = setup();
      const read = vi.spyOn(network, 'getTxConfirmation');
      switch (field) {
        case 'configs':
          chain.configs = { ...chain.configs };
          break;
        case 'confirmations':
          chain.configs.confirmations = { ...chain.configs.confirmations };
          break;
        case 'network':
          Reflect.set(chain, 'network', {});
          break;
        case 'chainId':
          Reflect.set(chain, 'CHAIN_ID', 43114n);
          break;
        case 'expectedChainId':
          Reflect.set(network, 'expectedChainId', 43114n);
          break;
        case 'chain':
          Reflect.set(chain, 'CHAIN', 'ethereum');
          break;
        case 'native':
          Reflect.set(chain, 'NATIVE_TOKEN_ID', 'eth');
          break;
      }
      expect(() =>
        chain.getTxRequiredConfirmation(TransactionType.payment),
      ).toThrow('Avalanche read configuration changed');
      expect(read).not.toHaveBeenCalled();
      expect(networkCheck).not.toHaveBeenCalled();
    });
  });

  describe('getTxConfirmationStatus', () => {
    /**
     * @target AvalancheChain.getTxConfirmationStatus rejects a replaced policy before qualification
     * @dependencies
     * - Real chain with isolated policy replacement.
     * @scenario
     * - Replace the policy method before querying a manual transaction.
     * @expected
     * - The read rejects before qualification or observation.
     */
    it('rejects a replaced policy before qualification', async () => {
      const { chain, network, networkCheck } = setup();
      const observe = vi.spyOn(network, 'getTxConfirmation');
      chain.getTxRequiredConfirmation = vi.fn(() => 1);
      await expect(
        chain.getTxConfirmationStatus('ab'.repeat(32), TransactionType.manual),
      ).rejects.toThrow('Avalanche read configuration changed');
      expect(networkCheck).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheChain.getTxConfirmationStatus rejects $field mutation during $stage
     * @dependencies
     * - Real status consumer with isolated qualification and observation mocks.
     * @scenario
     * - Mutate one captured policy, method or adapter at either asynchronous boundary.
     * @expected
     * - A stale observation never becomes a returned status; qualification drift prevents observation.
     */
    it.each(
      ['qualification', 'observation'].flatMap((stage) =>
        [
          'policy',
          'policyMethod',
          'observationMethod',
          'qualificationMethod',
          'network',
          'chainId',
          'expectedChainId',
        ].map((field) => ({ stage, field })),
      ),
    )('rejects $field mutation during $stage', async ({ stage, field }) => {
      const { chain, network, networkCheck } = setup();
      const observe = vi
        .spyOn(network, 'getTxConfirmation')
        .mockResolvedValue(100);
      /** Mutate only this case's captured status-read boundary. */
      const mutate = () => {
        switch (field) {
          case 'policy':
            chain.configs.confirmations.manual = 29;
            break;
          case 'policyMethod':
            chain.getTxRequiredConfirmation = () => 1;
            break;
          case 'observationMethod':
            network.getTxConfirmation = async () => 100;
            break;
          case 'qualificationMethod':
            network.assertNetwork = async () => undefined;
            break;
          case 'network':
            Reflect.set(chain, 'network', {});
            break;
          case 'chainId':
            Reflect.set(chain, 'CHAIN_ID', 43114n);
            break;
          case 'expectedChainId':
            Reflect.set(network, 'expectedChainId', 43114n);
            break;
        }
      };
      if (stage === 'qualification')
        networkCheck.mockImplementation(async () => {
          mutate();
        });
      else
        observe.mockImplementation(async () => {
          mutate();
          return 100;
        });
      await expect(
        chain.getTxConfirmationStatus(
          '0x' + 'ab'.repeat(32),
          TransactionType.manual,
        ),
      ).rejects.toThrow('Avalanche read configuration changed');
      if (stage === 'qualification') expect(observe).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getTxConfirmationStatus rejects a wrong RPC chain before observing a transaction
     * @dependencies
     * - Real RPC qualification and a synthetic foreign-chain reply.
     * @scenario
     * - Query an admitted manual transaction while the endpoint returns Ethereum chain ID.
     * @expected
     * - No transaction observation follows the rejected identity.
     */
    it('rejects a wrong RPC chain before observing a transaction', async () => {
      const { chain, network, networkCheck } = setup();
      networkCheck.mockRestore();
      vi.spyOn(network['provider'], 'send').mockResolvedValue('0x1');
      const observe = vi.spyOn(network, 'getTxConfirmation');
      await expect(
        chain.getTxConfirmationStatus(
          '0x' + 'ab'.repeat(32),
          TransactionType.manual,
        ),
      ).rejects.toThrow('Avalanche RPC chain ID mismatch');
      expect(observe).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getTxConfirmationStatus rejects missing observation before RPC
     * @dependencies
     * - Real chain with an incomplete adapter observation interface.
     * @scenario
     * - Remove the transaction observation method before querying payment status.
     * @expected
     * - The missing method rejects before qualification.
     */
    it('rejects missing observation before RPC', async () => {
      const { chain, network, networkCheck } = setup();
      Reflect.set(network, 'getTxConfirmation', undefined);
      await expect(
        chain.getTxConfirmationStatus(
          '0x' + 'ab'.repeat(32),
          TransactionType.payment,
        ),
      ).rejects.toThrow('Invalid Avalanche read adapter');
      expect(networkCheck).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheChain.getTxConfirmationStatus applies the $type threshold at offset $offset
     * @dependencies
     * - Real inherited status consumer with a synthetic transaction confirmation producer.
     * @scenario
     * - Observe each type one below, exactly at and one above its distinct threshold.
     * @expected
     * - Only below-threshold observations remain unconfirmed; the hash is forwarded unchanged.
     */
    it.each(
      [
        [TransactionType.lock, 11],
        [TransactionType.payment, 13],
        [TransactionType.coldStorage, 17],
        [TransactionType.manual, 19],
        [TransactionType.arbitrary, 23],
      ].flatMap(([type, count]) =>
        [-1, 0, 1].map((offset) => ({
          type: type as TransactionType,
          count: count as number,
          offset,
        })),
      ),
    )(
      'applies the $type threshold at offset $offset',
      async ({ type, count, offset }) => {
        const { chain, network } = setup(43113n, {
          ...configs,
          confirmations: {
            observation: 11,
            payment: 13,
            cold: 17,
            manual: 19,
            arbitrary: 23,
          },
        });
        const read = vi
          .spyOn(network, 'getTxConfirmation')
          .mockResolvedValue(count + offset);
        const hash = '0x' + 'ab'.repeat(32);
        expect(await chain.getTxConfirmationStatus(hash, type)).toEqual(
          offset < 0
            ? ConfirmationStatus.NotConfirmedEnough
            : ConfirmationStatus.ConfirmedEnough,
        );
        expect(read).toHaveBeenCalledExactlyOnceWith(hash);
      },
    );

    /**
     * @target AvalancheChain.getTxConfirmationStatus preserves not-found status for %s
     * @dependencies
     * - Real inherited status consumer and explicit missing-transaction result.
     * @scenario
     * - Return the network's -1 sentinel for every admitted type.
     * @expected
     * - Missing transactions remain NotFound, never confirmed.
     */
    it.each([
      TransactionType.lock,
      TransactionType.payment,
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('preserves not-found status for %s', async (type) => {
      const { chain, network } = setup();
      vi.spyOn(network, 'getTxConfirmation').mockResolvedValue(-1);
      expect(
        await chain.getTxConfirmationStatus('0x' + 'ab'.repeat(32), type),
      ).toEqual(ConfirmationStatus.NotFound);
    });

    /**
     * @target AvalancheChain.getTxConfirmationStatus propagates unavailable transaction observations
     * @dependencies
     * - Real status consumer and an unavailable network observation.
     * @scenario
     * - Request a manual status while the observation producer rejects.
     * @expected
     * - Unavailable observations propagate instead of becoming confirmed.
     */
    it('propagates unavailable transaction observations', async () => {
      const { chain, network } = setup();
      vi.spyOn(network, 'getTxConfirmation').mockRejectedValue(
        new Error('Observation unavailable'),
      );
      await expect(
        chain.getTxConfirmationStatus(
          '0x' + 'ab'.repeat(32),
          TransactionType.manual,
        ),
      ).rejects.toThrow('Observation unavailable');
    });
  });

  describe('getColdAddressAssets', () => {
    /**
     * @target AvalancheChain.getColdAddressAssets preserves valid native boundary %s
     * @dependencies
     * - Real native cold reader and an exact zero or uint256 maximum balance.
     * @scenario
     * - Read both admitted native amount boundaries with an empty TokenMap.
     * @expected
     * - Exact bigint balance is preserved and token assets remain empty.
     */
    it.each([0n, (1n << 256n) - 1n])(
      'preserves valid native boundary %s',
      async (nativeToken) => {
        const { chain, network } = setup(43113n, {
          ...configs,
          addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
        });
        vi.spyOn(network, 'getAddressBalanceForNativeToken').mockResolvedValue(
          nativeToken,
        );
        expect(await chain.getColdAddressAssets()).toEqual({
          nativeToken,
          tokens: [],
        });
      },
    );

    /**
     * @target AvalancheChain.getColdAddressAssets refuses caller token-filter mutation after qualification
     * @dependencies
     * - Real cold reader and a mutable caller-owned native filter.
     * @scenario
     * - Replace native filter membership with ERC20 during qualification.
     * @expected
     * - The changed filter rejects before a native balance is read.
     */
    it('refuses caller token-filter mutation after qualification', async () => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      const tokenIds = ['avax'];
      const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
      networkCheck.mockImplementation(async () => {
        tokenIds[0] = '0x' + '33'.repeat(20);
      });
      await expect(chain.getColdAddressAssets(tokenIds)).rejects.toThrow(
        'Avalanche read configuration changed',
      );
      expect(native).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets derives native availability without mutable wrapping
     * @dependencies
     * - Real cold reader with a poisoned, unused wrapped-amount producer.
     * @scenario
     * - Supply a wrapper that would change the configured cold address if called.
     * @expected
     * - Derive availability from captured native units without invoking the wrapper.
     */
    it('derives native availability without mutable wrapping', async () => {
      const { chain, network } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      vi.spyOn(network, 'getAddressBalanceForNativeToken').mockResolvedValue(
        100n,
      );
      const wrap = vi
        .spyOn(chain['tokenMap'], 'wrapAmount')
        .mockImplementation(() => {
          chain.configs.addresses.cold = '0x' + '33'.repeat(20);
          return { amount: 100n, decimals: 0 };
        });
      expect(await chain.getColdAddressAssets()).toEqual({
        nativeToken: 100n,
        tokens: [],
      });
      expect(wrap).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheChain.getColdAddressAssets reads the distinct cold address at finalized state and wraps native AVAX on %s
     * @dependencies
     * - Real Avalanche RPC settled-state methods and a real TokenMap with nine-to-three decimal wrapping.
     * - Synthetic provider replies for Fuji, finalized block identity and native balance.
     * @scenario
     * - Read a configured cold address different from lock with a nontrivial native amount.
     * @expected
     * - Cold identity and finalized state are used; downward rounding produces 1000 available AVAX units and no ERC20 read.
     */
    it.each([43113n, 43114n])(
      'reads the distinct cold address at finalized state and wraps native AVAX on %s',
      async (chainId) => {
        const cold = '0x' + '22'.repeat(20);
        const tokens = new TokenMap();
        await tokens.updateConfigByJson([
          {
            avalanche: {
              tokenId: 'avax',
              name: 'AVAX',
              decimals: 18,
              type: 'native',
              residency: 'native',
              extra: {},
            },
            ergo: {
              tokenId: 'ab'.repeat(32),
              name: 'rsAVAX',
              decimals: 12,
              type: 'EIP-004',
              residency: 'wrapped',
              extra: {},
            },
          },
        ]);
        const { chain, network, networkCheck } = setup(
          chainId,
          {
            ...configs,
            addresses: { ...configs.addresses, cold },
          },
          tokens,
        );
        networkCheck.mockRestore();
        const block = {
          number: 42,
          hash: '0x' + 'ab'.repeat(32),
          parentHash: '0x' + 'cd'.repeat(32),
        } as Block;
        const blocks = vi
          .spyOn(network['provider'], 'getBlock')
          .mockResolvedValue(block);
        const send = vi
          .spyOn(network['provider'], 'send')
          .mockImplementation(async (method) => {
            if (method === 'eth_chainId') return '0x' + chainId.toString(16);
            if (method === 'eth_getBalance') return '0x3b9aca01';
            if (method === 'eth_getBlockByNumber')
              return { number: '0x2a', hash: block.hash };
            throw new Error('Unexpected RPC method');
          });
        const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
        const erc20 = vi.spyOn(network, 'getAddressBalanceForERC20Asset');
        const wrap = vi.spyOn(chain['tokenMap'], 'wrapAmount');
        expect(await chain.getColdAddressAssets(['avax'])).toEqual({
          nativeToken: 1000n,
          tokens: [],
        });
        expect(native).toHaveBeenCalledExactlyOnceWith(getAddress(cold));
        expect(wrap).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('eth_getBalance', [
          getAddress(cold),
          '0x2a',
        ]);
        expect(blocks.mock.calls).toEqual([['finalized'], [42]]);
        expect(
          send.mock.calls.filter(([method]) => method === 'eth_chainId'),
        ).toHaveLength(3);
        expect(erc20).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.getColdAddressAssets refuses invalid cold address %s before RPC
     * @dependencies
     * - Real chain with one isolated malformed, zero or lock-equivalent cold address.
     * @scenario
     * - Request native cold assets for each invalid configured address.
     * @expected
     * - Invalid cold configuration rejects before qualification, native balance or ERC20 reads.
     */
    it.each([
      '',
      undefined,
      '0x12',
      '0x' + '00'.repeat(20),
      configs.addresses.lock.toLowerCase(),
      ' ' + configs.addresses.lock,
      '0x19e7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    ])('refuses invalid cold address %s before RPC', async (cold) => {
      const config = structuredClone(configs);
      Reflect.set(config.addresses, 'cold', cold);
      const { chain, network, networkCheck } = setup(43113n, config);
      const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
      const erc20 = vi.spyOn(network, 'getAddressBalanceForERC20Asset');
      await expect(chain.getColdAddressAssets()).rejects.toThrow(
        'Invalid Avalanche cold address',
      );
      expect(networkCheck).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(erc20).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets refuses unmapped token requests before RPC
     * @dependencies
     * - Real native-only chain and a synthetic ERC20 request.
     * @scenario
     * - Request an ERC20 identifier despite a valid distinct cold address.
     * @expected
     * - The request rejects before qualification or any asset query.
     */
    it('refuses unmapped token requests before RPC', async () => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
      const erc20 = vi.spyOn(network, 'getAddressBalanceForERC20Asset');
      await expect(
        chain.getColdAddressAssets(['0x' + '33'.repeat(20)]),
      ).rejects.toThrow('Unsupported Avalanche cold balance asset');
      expect(networkCheck).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(erc20).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets refuses unsupported token-set drift before RPC
     * @dependencies
     * - Real chain whose supported-token set is mutated after policy capture.
     * @scenario
     * - Query cold assets after an ERC20 identifier enters supportedTokens.
     * @expected
     * - No native or ERC20 query runs under changed supported-token authority.
     */
    it('refuses unsupported token-set drift before RPC', async () => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      chain.supportedTokens.push('0x' + '33'.repeat(20));
      const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
      await expect(chain.getColdAddressAssets()).rejects.toThrow(
        'Invalid Avalanche cold asset mapping',
      );
      expect(networkCheck).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets refuses a wrong RPC chain before reading the balance
     * @dependencies
     * - Real assertNetwork with a synthetic Ethereum chain-ID reply.
     * @scenario
     * - Query a valid cold address while the endpoint reports chain 1.
     * @expected
     * - Chain mismatch rejects without native or ERC20 queries.
     */
    it('refuses a wrong RPC chain before reading the balance', async () => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      networkCheck.mockRestore();
      vi.spyOn(network['provider'], 'send').mockResolvedValue('0x1');
      const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
      const erc20 = vi.spyOn(network, 'getAddressBalanceForERC20Asset');
      await expect(chain.getColdAddressAssets()).rejects.toThrow(
        'Avalanche RPC chain ID mismatch',
      );
      expect(native).not.toHaveBeenCalled();
      expect(erc20).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets refuses missing %s adapter method before RPC
     * @dependencies
     * - Real configured chain and an isolated missing read method.
     * @scenario
     * - Remove network qualification or native balance reading before invocation.
     * @expected
     * - The incomplete adapter rejects before any qualification or balance call.
     */
    it.each(['assertNetwork', 'getAddressBalanceForNativeToken'])(
      'refuses missing %s adapter method before RPC',
      async (method) => {
        const { chain, network, networkCheck } = setup(43113n, {
          ...configs,
          addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
        });
        const native = vi.spyOn(network, 'getAddressBalanceForNativeToken');
        Reflect.set(network, method, undefined);
        await expect(chain.getColdAddressAssets()).rejects.toThrow(
          'Invalid Avalanche read adapter',
        );
        expect(networkCheck).not.toHaveBeenCalled();
        expect(native).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.getColdAddressAssets rejects $field mutation during $stage
     * @dependencies
     * - Real chain with synthetic asynchronous qualification and balance boundaries.
     * @scenario
     * - Change one configuration, address, adapter or method at each await boundary.
     * @expected
     * - The changed read rejects; qualification changes prevent balance reads, and every change prevents wrapping.
     */
    it.each(
      ['qualification', 'balance'].flatMap((stage) =>
        [
          'cold',
          'lock',
          'addresses',
          'configs',
          'network',
          'chainId',
          'expectedChainId',
          'balanceMethod',
          'identityMethod',
          'supportedTokens',
          'tokenMap',
        ].map((field) => ({ stage, field })),
      ),
    )('rejects $field mutation during $stage', async ({ stage, field }) => {
      const { chain, network, networkCheck } = setup(43113n, {
        ...configs,
        addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
      });
      const native = vi
        .spyOn(network, 'getAddressBalanceForNativeToken')
        .mockResolvedValue(100n);
      const wrap = vi.spyOn(chain['tokenMap'], 'wrapAmount');
      /** Apply only this case's caller mutation at its selected asynchronous boundary. */
      const mutate = () => {
        switch (field) {
          case 'cold':
            chain.configs.addresses.cold = '0x' + '33'.repeat(20);
            break;
          case 'lock':
            chain.configs.addresses.lock = '0x' + '33'.repeat(20);
            break;
          case 'addresses':
            chain.configs.addresses = { ...chain.configs.addresses };
            break;
          case 'configs':
            chain.configs = { ...chain.configs };
            break;
          case 'network':
            Reflect.set(chain, 'network', {});
            break;
          case 'chainId':
            Reflect.set(chain, 'CHAIN_ID', 43114n);
            break;
          case 'expectedChainId':
            Reflect.set(network, 'expectedChainId', 43114n);
            break;
          case 'balanceMethod':
            network.getAddressBalanceForNativeToken = async () => 1n;
            break;
          case 'identityMethod':
            network.assertNetwork = async () => undefined;
            break;
          case 'supportedTokens':
            chain.supportedTokens.push('0x' + '33'.repeat(20));
            break;
          case 'tokenMap':
            Reflect.set(chain, 'tokenMap', {});
            break;
        }
      };
      if (stage === 'qualification')
        networkCheck.mockImplementation(async () => {
          mutate();
        });
      else
        native.mockImplementation(async () => {
          mutate();
          return 100n;
        });
      await expect(chain.getColdAddressAssets()).rejects.toThrow(
        'Avalanche read configuration changed',
      );
      if (stage === 'qualification') expect(native).not.toHaveBeenCalled();
      expect(wrap).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.getColdAddressAssets refuses invalid native balance %s before wrapping
     * @dependencies
     * - Real native cold reader and an isolated malformed balance producer.
     * @scenario
     * - Return each negative, overflowing or incorrectly typed native balance.
     * @expected
     * - Invalid amounts reject without invoking TokenMap wrapping.
     */
    it.each([-1n, 1n << 256n, '1', 1, undefined])(
      'refuses invalid native balance %s before wrapping',
      async (balance) => {
        const { chain, network } = setup(43113n, {
          ...configs,
          addresses: { ...configs.addresses, cold: '0x' + '22'.repeat(20) },
        });
        vi.spyOn(network, 'getAddressBalanceForNativeToken').mockImplementation(
          async () => balance as bigint,
        );
        const wrap = vi.spyOn(chain['tokenMap'], 'wrapAmount');
        await expect(chain.getColdAddressAssets()).rejects.toThrow(
          'Invalid Avalanche native balance',
        );
        expect(wrap).not.toHaveBeenCalled();
      },
    );
  });
});
