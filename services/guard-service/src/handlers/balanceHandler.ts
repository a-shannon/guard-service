import { chunk } from 'lodash-es';

import { RosenTokens } from '@rosen-bridge/tokens';
import { BINANCE_CHAIN, BNB } from '@rosen-chains/binance';
import { BITCOIN_CHAIN, BTC } from '@rosen-chains/bitcoin';
import { BITCOIN_RUNES_CHAIN } from '@rosen-chains/bitcoin-runes';
import { ADA, CARDANO_CHAIN } from '@rosen-chains/cardano';
import { KOIOS_NETWORK } from '@rosen-chains/cardano-koios-network';
import { DOGE, DOGE_CHAIN } from '@rosen-chains/doge';
import { ERG, ERGO_CHAIN } from '@rosen-chains/ergo';
import { NODE_NETWORK } from '@rosen-chains/ergo-node-network';
import { ETH, ETHEREUM_CHAIN } from '@rosen-chains/ethereum';
import { FIRO, FIRO_CHAIN } from '@rosen-chains/firo';
import { HANDSHAKE_CHAIN, HNS } from '@rosen-chains/handshake';

import {
  AvalancheBalanceConfig,
  readAvalancheBalanceConfig,
} from '../configs/avalancheBalanceConfig';
import Configs from '../configs/configs';
import GuardsCardanoConfigs from '../configs/guardsCardanoConfigs';
import GuardsDogeConfigs from '../configs/guardsDogeConfigs';
import GuardsErgoConfigs from '../configs/guardsErgoConfigs';
import { DatabaseAction } from '../db/databaseAction';
import { ChainAddressBalanceEntity } from '../db/entities/chainAddressBalanceEntity';
import {
  AddressBalance,
  AvalancheAddressBalance,
  AvalancheLockBalance,
  Page,
} from '../types/api';
import {
  ChainConfigKey,
  ChainNativeToken,
  LEGACY_BALANCE_CHAINS,
} from '../utils/constants';
import { getTokenData } from '../utils/getTokenData';
import ChainHandler from './chainHandler';
import { TokenHandler } from './tokenHandler';

class BalanceHandler {
  private static instance?: BalanceHandler;
  protected chainsTokensPerIteration: Record<string, number> = {};
  protected nativeTokenIds: Record<string, string> = {};
  private readonly avalancheConfig?: AvalancheBalanceConfig;

  /**
   * creates a BalanceHandler instance
   * @returns BalanceHandler instance
   */
  protected constructor(avalanche?: AvalancheBalanceConfig) {
    if (avalanche) {
      this.avalancheConfig = readAvalancheBalanceConfig(avalanche);
      this.nativeTokenIds.avalanche = ChainNativeToken.avalanche;
      this.chainsTokensPerIteration.avalanche =
        this.avalancheConfig.tokensPerIteration.rpc;
    }
    for (const chain of LEGACY_BALANCE_CHAINS) {
      switch (chain) {
        case ERGO_CHAIN:
          this.nativeTokenIds[chain] = ERG;
          this.chainsTokensPerIteration[chain] =
            GuardsErgoConfigs.chainNetworkName === NODE_NETWORK
              ? Configs.balanceHandler.ergo.tokensPerIteration.node
              : Configs.balanceHandler.ergo.tokensPerIteration.explorer;
          break;
        case CARDANO_CHAIN:
          this.nativeTokenIds[chain] = ADA;
          this.chainsTokensPerIteration[chain] =
            GuardsCardanoConfigs.chainNetworkName === KOIOS_NETWORK
              ? Configs.balanceHandler.cardano.tokensPerIteration.koios
              : Configs.balanceHandler.cardano.tokensPerIteration.blockfrost;
          break;
        case BITCOIN_CHAIN:
          this.nativeTokenIds[chain] = BTC;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.bitcoin.tokensPerIteration.esplora;
          break;
        case DOGE_CHAIN:
          this.nativeTokenIds[chain] = DOGE;
          this.chainsTokensPerIteration[chain] =
            GuardsDogeConfigs.chainNetworkName === 'rpc-blockcypher'
              ? Configs.balanceHandler.doge.tokensPerIteration.blockcypher
              : Configs.balanceHandler.doge.tokensPerIteration.esplora;
          break;
        case FIRO_CHAIN:
          this.nativeTokenIds[chain] = FIRO;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.firo.tokensPerIteration.rpc;
          break;
        case HANDSHAKE_CHAIN:
          this.nativeTokenIds[chain] = HNS;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.handshake.tokensPerIteration.rpc;
          break;
        case ETHEREUM_CHAIN:
          this.nativeTokenIds[chain] = ETH;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.ethereum.tokensPerIteration.rpc;
          break;
        case BINANCE_CHAIN:
          this.nativeTokenIds[chain] = BNB;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.binance.tokensPerIteration.rpc;
          break;
        case BITCOIN_RUNES_CHAIN:
          this.nativeTokenIds[chain] = BTC;
          this.chainsTokensPerIteration[chain] =
            Configs.balanceHandler.bitcoinRunes.tokensPerIteration.rpc;
          break;
        default:
          throw Error(`Chain [${chain}] is not implemented`);
      }
    }
  }

  /**
   * initializes the BalanceHandler singleton
   * @returns promise of void
   */
  static init = (avalanche?: AvalancheBalanceConfig) => {
    BalanceHandler.instance = new BalanceHandler(avalanche);
  };

  /** Returns the configured per-chain balance update schedule. */
  getUpdateSchedule = (): ReadonlyArray<{
    chain: string;
    intervalMs: number;
  }> => [
    ...LEGACY_BALANCE_CHAINS.map((chain) => ({
      chain,
      intervalMs:
        Configs.balanceHandler[ChainConfigKey[chain]].updateInterval * 1000,
    })),
    ...(this.avalancheConfig
      ? [
          {
            chain: 'avalanche',
            intervalMs: this.avalancheConfig.updateInterval * 1000,
          },
        ]
      : []),
  ];

  /**
   * retrieves the initialized BalanceHandler singleton instance
   * @returns BalanceHandler instance
   */
  static getInstance = () => {
    if (!BalanceHandler.instance)
      throw Error(
        `BalanceHandler should have been initialized before getInstance`,
      );
    return BalanceHandler.instance;
  };

  /**
   * retrieves all native token balances of supported chains
   * @returns promise of AddressBalance array
   */
  getNativeTokenBalances = async (): Promise<AddressBalance[]> => {
    const nativeTokenIds: Set<string> = new Set();

    for (const chain of LEGACY_BALANCE_CHAINS) {
      nativeTokenIds.add(ChainNativeToken[chain]);
    }

    const balances =
      await DatabaseAction.getInstance().getChainAddressBalanceByTokenIds([
        ...nativeTokenIds,
      ]);

    return balances
      .filter((balance) => balance.chain !== 'avalanche')
      .map(this.balanceEntityToAddressBalance);
  };

  /**
   * get cold or lock address assets of supported chains
   * @param address
   * @param chain
   * @param tokenId
   * @param offset
   * @param limit
   * @returns a promise of Page AddressBalance object
   */
  getAddressAssets = async (
    address: 'cold' | 'lock',
    chain?: string,
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<Page<AddressBalance>> => {
    if (chain === 'avalanche')
      throw new Error('Avalanche requires the exact lock-balance reader');
    const addresses: string[] = [];

    const chains = chain ? [chain] : LEGACY_BALANCE_CHAINS;
    for (const chain of chains) {
      const chainConfig = ChainHandler.getInstance()
        .getChain(chain)
        .getChainConfigs();
      addresses.push(chainConfig.addresses[address]);
    }

    const balances =
      await DatabaseAction.getInstance().getChainAddressBalanceByAddresses(
        addresses,
        chain ?? LEGACY_BALANCE_CHAINS,
        tokenId,
        offset,
        limit,
      );

    return {
      items: balances.items.map(this.balanceEntityToAddressBalance),
      total: balances.total,
    };
  };

  /** Binds cached reads and collection writes to their configured custody. */
  protected getAvalancheBalanceContext = (includeCold: boolean) => {
    if (!this.avalancheConfig)
      throw new Error('Avalanche balance collection is not enabled');
    const owner = ChainHandler.getInstance();
    const chain = owner.getChain('avalanche');
    const chainId = 'CHAIN_ID' in chain ? chain.CHAIN_ID : undefined;
    if (chainId !== 43113n && chainId !== 43114n)
      throw new Error('Invalid Avalanche balance deployment');
    const config = chain.getChainConfigs();
    const addresses = config.addresses;
    const lock = addresses.lock;
    const cold = includeCold ? addresses.cold : '';
    const tokenMap = TokenHandler.getInstance().getTokenMap();
    const policy = JSON.stringify(tokenMap.getRawConfig());
    if (
      typeof lock !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(lock) ||
      /^0x0{40}$/.test(lock) ||
      (includeCold &&
        (typeof cold !== 'string' ||
          (cold !== '' &&
            (!/^0x[0-9a-fA-F]{40}$/.test(cold) ||
              /^0x0{40}$/.test(cold) ||
              cold.toLowerCase() === lock.toLowerCase()))))
    )
      throw new Error('Invalid Avalanche balance custody');
    /** Refuses an owner or address change across an awaited read before writes. */
    const assertCurrent = () => {
      if (
        ChainHandler.getInstance() !== owner ||
        owner.getChain('avalanche') !== chain ||
        !('CHAIN_ID' in chain) ||
        chain.CHAIN_ID !== chainId ||
        chain.getChainConfigs() !== config ||
        config.addresses !== addresses ||
        addresses.lock !== lock ||
        (includeCold && addresses.cold !== cold)
      )
        throw new Error('Avalanche balance custody changed');
      if (
        TokenHandler.getInstance().getTokenMap() !== tokenMap ||
        JSON.stringify(tokenMap.getRawConfig()) !== policy
      )
        throw new Error('Avalanche balance token metadata changed');
    };
    return {
      chain,
      chainId: Number(chainId) as 43113 | 43114,
      lock,
      cold,
      assertCurrent,
    };
  };

  /** Cached Rosen wrapped units; token metadata supplies significant decimals. */
  getAvalancheLockAssets = async (
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<Page<AvalancheAddressBalance>> => {
    return this.getAvalancheCachedAssets('lock', tokenId, offset, limit);
  };

  /** Returns configured cold cached wrapped units, without any chain state read. */
  getAvalancheColdAssets = async (
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<Page<AvalancheAddressBalance>> => {
    return this.getAvalancheCachedAssets('cold', tokenId, offset, limit);
  };

  /** Keeps both custody pages on one configuration through their awaited reads. */
  getAvalancheBalances = async (
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<AvalancheLockBalance> => {
    const context = this.getAvalancheBalanceContext(true);
    const tokenMap = TokenHandler.getInstance().getTokenMap();
    const policy = JSON.stringify(tokenMap.getRawConfig());
    const assertCurrent = () => {
      context.assertCurrent();
      if (
        TokenHandler.getInstance().getTokenMap() !== tokenMap ||
        JSON.stringify(tokenMap.getRawConfig()) !== policy
      )
        throw new Error('Avalanche balance token metadata changed');
    };
    const hot = await this.getAvalancheLockAssets(tokenId, offset, limit);
    assertCurrent();
    const cold = await this.getAvalancheColdAssets(tokenId, offset, limit);
    assertCurrent();
    return { chainId: context.chainId, hot, cold };
  };

  /** Reads one configured address from cache without changing its mapped units. */
  protected getAvalancheCachedAssets = async (
    role: 'lock' | 'cold',
    tokenId?: string,
    offset?: number,
    limit?: number,
  ): Promise<Page<AvalancheAddressBalance>> => {
    const context = this.getAvalancheBalanceContext(role === 'cold');
    const address = role === 'lock' ? context.lock : context.cold;
    if (address === '') return { items: [], total: 0 };
    const tokenMap = TokenHandler.getInstance().getTokenMap();
    const policy = JSON.stringify(tokenMap.getRawConfig());
    /** Refuses changed conversion metadata before labeling cached wrapped units. */
    const assertCurrent = () => {
      context.assertCurrent();
      if (
        TokenHandler.getInstance().getTokenMap() !== tokenMap ||
        JSON.stringify(tokenMap.getRawConfig()) !== policy
      )
        throw new Error('Avalanche balance token metadata changed');
    };
    const page =
      await DatabaseAction.getInstance().getChainAddressBalanceByAddresses(
        [address],
        'avalanche',
        tokenId,
        offset,
        limit,
      );
    assertCurrent();
    return {
      total: page.total,
      items: page.items.map((row) => {
        if (
          tokenMap.search('avalanche', {
            tokenId: row.tokenId,
          }).length !== 1
        )
          throw new Error('Avalanche cached token metadata is unavailable');
        const metadata = getTokenData(
          'avalanche',
          row.tokenId,
          'avalanche',
          true,
        );
        assertCurrent();
        if (
          row.chain !== 'avalanche' ||
          row.address !== address ||
          typeof row.balance !== 'bigint' ||
          row.balance < 0n ||
          row.balance >= 1n << 256n ||
          !Number.isSafeInteger(metadata.decimals) ||
          metadata.decimals < 0 ||
          metadata.decimals > 255
        )
          throw new Error('Invalid Avalanche cached balance');
        return {
          address: row.address,
          chain: 'avalanche' as const,
          balance: {
            ...metadata,
            tokenId: row.tokenId,
            amount: row.balance.toString(),
          },
        };
      }),
    };
  };

  /**
   * maps a ChainAddressBalanceEntity record to AddressBalance
   * @param balance
   * @returns an AddressBalance object
   */
  protected balanceEntityToAddressBalance = (
    balance: ChainAddressBalanceEntity,
  ): AddressBalance => {
    if (balance.chain === 'avalanche')
      throw new Error('Avalanche requires the exact lock-balance reader');
    const tokenData = getTokenData(
      balance.chain,
      balance.tokenId,
      balance.chain,
      true,
    );

    return {
      address: balance.address,
      chain: balance.chain,
      balance: {
        tokenId: balance.tokenId,
        amount: Number(balance.balance),
        name: tokenData.name,
        decimals: tokenData.decimals,
        isNativeToken: tokenData.isNativeToken,
      },
    };
  };

  /**
   * gets tokens for the given chain using its token map
   * @param chain
   * @returns array of chain's supported token ids
   */
  protected getChainTokenIds = (chain: string) => {
    const rosenTokens: RosenTokens = TokenHandler.getInstance()
      .getTokenMap()
      .getConfig();

    const supportedTokenIds = rosenTokens
      .filter(
        (tokenSet) =>
          Object.keys(tokenSet).includes(chain) &&
          tokenSet[chain].type !== 'native',
      )
      .map((tokenSet) => tokenSet[chain].tokenId);

    return supportedTokenIds;
  };

  /**
   * updates the balances of addresses and tokens for the given chain by executing periodic batch requests
   * @param chain
   * @returns promise of void
   */
  updateChainBalances = async (chain: string) => {
    if (chain === 'avalanche' && !this.avalancheConfig)
      throw new Error('Avalanche balance collection is not enabled');
    const context =
      chain === 'avalanche' ? this.getAvalancheBalanceContext(true) : undefined;
    const savedBalances =
      await DatabaseAction.getInstance().getChainAddressBalanceByChain(chain);
    context?.assertCurrent();
    const balancesMap: Map<string, ChainAddressBalanceEntity> = new Map();
    savedBalances.forEach((balance) =>
      balancesMap.set(`${balance.address}-${balance.tokenId}`, balance),
    );

    const chainConfig = ChainHandler.getInstance()
      .getChain(chain)
      .getChainConfigs();

    const supportedTokenIds = this.getChainTokenIds(chain);

    // batch the tokens by token per minute config of the chain
    const tokensBatches = chunk(
      supportedTokenIds,
      this.chainsTokensPerIteration[chain],
    );

    const addresses =
      chain === 'avalanche'
        ? [context!.lock, context!.cold]
        : [chainConfig.addresses.lock, chainConfig.addresses.cold];
    for (const address of addresses) {
      context?.assertCurrent();
      if (address === '') continue;

      for (const tokensBatch of tokensBatches) {
        const balances = await this.updateChainBatchBalances(
          chain,
          address,
          tokensBatch,
        );
        context?.assertCurrent();
        balances.forEach((balance) =>
          balancesMap.delete(`${balance.address}-${balance.tokenId}`),
        );

        await new Promise((r) =>
          setTimeout(
            r,
            (chain === 'avalanche'
              ? this.avalancheConfig!.updateBatchInterval
              : Configs.balanceHandler[ChainConfigKey[chain]]
                  .updateBatchInterval) * 1000,
          ),
        );
      }
      if (supportedTokenIds.length === 0) {
        const balances = await this.updateChainBatchBalances(chain, address);
        context?.assertCurrent();
        balances.forEach((balance) =>
          balancesMap.delete(`${balance.address}-${balance.tokenId}`),
        );
      }
    }

    // remove outdated balance entities from database
    context?.assertCurrent();
    await DatabaseAction.getInstance().removeChainAddressBalances([
      ...balancesMap.values(),
    ]);
  };

  /**
   * updates balance of a specific address and batch of tokens of the given chain
   * @param chain
   * @param address
   * @param tokensBatch
   * @returns promise of ChainAddressBalanceEntity array
   */
  updateChainBatchBalances = async (
    chain: string,
    address: string,
    tokensBatch?: string[],
  ) => {
    if (chain === 'avalanche' && !this.avalancheConfig)
      throw new Error('Avalanche balance collection is not enabled');
    // get address assets
    const abstractChain = ChainHandler.getInstance().getChain(chain);
    const context =
      chain === 'avalanche' ? this.getAvalancheBalanceContext(true) : undefined;
    if (
      context &&
      (address === '' || (address !== context.lock && address !== context.cold))
    )
      throw new Error('Invalid Avalanche balance collection address');
    const addressAssets =
      context && address === context.cold
        ? await context.chain.getColdAddressAssets(tokensBatch)
        : await abstractChain.getAddressAssets(address, tokensBatch);
    context?.assertCurrent();
    const balances: ChainAddressBalanceEntity[] = [
      {
        chain,
        address,
        tokenId: this.nativeTokenIds[chain],
        lastUpdate: String(Math.floor(Date.now() / 1000)),
        balance: addressAssets.nativeToken,
      },
      ...addressAssets.tokens.map((token) => ({
        chain,
        address,
        tokenId: token.id,
        lastUpdate: String(Math.floor(Date.now() / 1000)),
        balance: token.value,
      })),
    ];

    // upsert batch tokens balances
    await DatabaseAction.getInstance().upsertChainAddressBalances(balances);

    return balances;
  };
}

export default BalanceHandler;
