import { Block } from 'ethers';

import { AvalancheSafetyState } from '@rosen-bridge/evm-scanner';
import { TransactionType } from '@rosen-chains/abstract-chain';

import { readAvalancheHealthConfig } from '../../src/configs/avalancheHealthConfig';
import Configs from '../../src/configs/configs';
import ChainHandler from '../../src/handlers/chainHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import * as scannerStartup from '../../src/jobs/initScanner';
import { createManagementProcessorFixture } from '../transaction/avalancheManagementProcessorTestUtils';
import { contracts } from '../utils/avalancheChainTestUtils';

/** JOE's mainnet contract; its wrapped counterpart comes from the existing fixture map. */
export const joe = '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd';
export const warn = 9007199254740993n;
export const critical = 9007199254740992n;

/** Synthetic provider fault changes exactly one network or canonical-block predicate. */
type Fault = 'none' | 'network' | 'frontier' | 'state';

/**
 * Joins actual Guard health registration, raw RPC readers and migrated SQLite scanner state.
 * Provider replies, chain registry and custody delegation are explicit fixture ports;
 * this does not initialize the full service or contact mainnet.
 */
export const createAssetHealthFixture = async () => {
  const f = await createManagementProcessorFixture(
    TransactionType.manual,
    true,
    true,
  );
  vi.mocked(f.network.assertNetwork).mockRestore();
  vi.mocked(f.network.getAddressBalanceForNativeToken).mockRestore();
  vi.mocked(f.network.getAddressBalanceForERC20Asset).mockRestore();
  const native = vi.spyOn(f.network, 'getAddressBalanceForNativeToken');
  const token = vi.spyOn(f.network, 'getAddressBalanceForERC20Asset');
  const lock = f.chain.getChainConfigs().addresses.lock;
  const state = {
    fault: 'none' as Fault,
    native: warn + 1n,
    token: warn + 1n,
    beforeBalance: undefined as (() => Promise<void>) | undefined,
  };
  const frontier = {
    number: 2,
    hash: '0x' + '02'.padStart(64, '0'),
    parentHash: '0x' + '01'.padStart(64, '0'),
  };
  /** Provider mock: canonical finalized header and independently mutable numeric lookup. */
  const blocks = vi
    .spyOn(f.network['provider'], 'getBlock')
    .mockImplementation(async (tag) => {
      if (tag !== 'finalized' && tag !== frontier.number)
        throw new Error('Unexpected health block tag');
      return {
        ...frontier,
        hash:
          tag === frontier.number && state.fault === 'frontier'
            ? '0x' + 'ff'.repeat(32)
            : frontier.hash,
      } as Block;
    });
  /** Provider mock: exact raw quantities/ABI words and uncached post-read canonical lookup. */
  const send = vi
    .spyOn(f.network['provider'], 'send')
    .mockImplementation(async (method) => {
      if (method === 'eth_chainId')
        return state.fault === 'network' ? '0xa869' : '0xa86a';
      if (method === 'eth_getBalance' || method === 'eth_call') {
        await state.beforeBalance?.();
        return method === 'eth_getBalance'
          ? '0x' + state.native.toString(16)
          : '0x' + state.token.toString(16).padStart(64, '0');
      }
      if (method === 'eth_getBlockByNumber')
        return {
          number: '0x2',
          hash:
            state.fault === 'state' ? '0x' + 'ff'.repeat(32) : frontier.hash,
        };
      throw new Error('Unexpected health RPC method');
    });
  /** Registry mock retains the real chain and delegates raw custody to its actual network. */
  const handler = {
    getChain: () => f.chain,
    getAvalancheLockBalance: () =>
      f.network.getAddressBalanceForNativeToken(lock),
  };
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue(
    handler as unknown as ChainHandler,
  );
  vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(f.tokens);
  vi.spyOn(scannerStartup, 'getAvalancheScanner').mockReturnValue(f.scanner);
  vi.spyOn(scannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
    config: { ...f.getPolicy().config, sourceId: 'synthetic-processor-source' },
    contracts: {
      ...contracts(),
      addresses: { ...contracts().addresses, lock },
    },
  });
  vi.spyOn(Configs, 'getAvalancheHealthConfig').mockReturnValue(
    readAvalancheHealthConfig({
      nativeWarnWei: warn.toString(),
      nativeCriticalWei: critical.toString(),
      scannerWarnAgeSeconds: 30,
      scannerCriticalAgeSeconds: 60,
      tokens: [
        {
          tokenId: joe,
          warnRaw: warn.toString(),
          criticalRaw: critical.toString(),
        },
      ],
    }),
  );
  const { getHealthCheck } = await import('../../src/guard/healthCheck');
  const health = await getHealthCheck();
  const tokenId = (await health.getHealthStatus()).find((item) =>
    item.id.startsWith('asset_' + joe + '_'),
  )!.id;
  const repository = f.database.dataSource.getRepository(AvalancheSafetyState);
  return {
    ...f,
    state,
    lock,
    health,
    tokenId,
    native,
    token,
    blocks,
    send,
    repository,
    /** Resets synthetic replies and removes only the hold inserted by this suite. */
    reset: async () => {
      state.fault = 'none';
      state.native = state.token = warn + 1n;
      state.beforeBalance = undefined;
      native.mockClear();
      token.mockClear();
      blocks.mockClear();
      send.mockClear();
      await repository.update({ scanner: 'avalanche' }, { holdReason: null });
    },
  };
};

/** Creates an explicitly released provider wait without clocks or timeout assumptions. */
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
