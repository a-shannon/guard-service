import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import {
  EsploraAssetHealthCheckParam,
  CardanoBlockFrostAssetHealthCheckParam,
  CardanoKoiosAssetHealthCheckParam,
  ErgoExplorerAssetHealthCheckParam,
  ErgoNodeAssetHealthCheckParam,
  EvmRpcAssetHealthCheckParam,
  AvalancheRpcAssetHealthCheckParam,
} from '@rosen-bridge/asset-check';
import {
  EventInfo,
  EventProgressHealthCheckParam,
} from '@rosen-bridge/event-progress-check';
import { HealthCheck, HealthStatusLevel } from '@rosen-bridge/health-check';
import { LogLevelHealthCheck } from '@rosen-bridge/log-level-check';
import { ErgoNodeSyncHealthCheckParam } from '@rosen-bridge/node-sync-check';
import { ScannerSyncHealthCheckParam } from '@rosen-bridge/scanner-sync-check';
import { LastSavedBlock } from '@rosen-bridge/scanner-sync-check';
import {
  TxInfo,
  TxProgressHealthCheckParam,
} from '@rosen-bridge/tx-progress-check';
import { NotFoundError } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';
import { BINANCE_CHAIN, BNB } from '@rosen-chains/binance';
import { BITCOIN_CHAIN, BTC } from '@rosen-chains/bitcoin';
import { BITCOIN_RUNES_CHAIN } from '@rosen-chains/bitcoin-runes';
import { ADA, CARDANO_CHAIN } from '@rosen-chains/cardano';
import { BLOCKFROST_NETWORK } from '@rosen-chains/cardano-blockfrost-network';
import { KOIOS_NETWORK } from '@rosen-chains/cardano-koios-network';
import { ERG, ERGO_CHAIN } from '@rosen-chains/ergo';
import { EXPLORER_NETWORK } from '@rosen-chains/ergo-explorer-network';
import { NODE_NETWORK } from '@rosen-chains/ergo-node-network';
import { ETH, ETHEREUM_CHAIN } from '@rosen-chains/ethereum';

import Configs from '../configs/configs';
import GuardsBinanceConfigs from '../configs/guardsBinanceConfigs';
import GuardsBitcoinConfigs from '../configs/guardsBitcoinConfigs';
import GuardsCardanoConfigs from '../configs/guardsCardanoConfigs';
import GuardsErgoConfigs from '../configs/guardsErgoConfigs';
import GuardsEthereumConfigs from '../configs/guardsEthereumConfigs';
import { rosenConfig } from '../configs/rosenConfig';
import { DatabaseAction } from '../db/databaseAction';
import ChainHandler from '../handlers/chainHandler';
import { NotificationHandler } from '../handlers/notificationHandler';
import { TokenHandler } from '../handlers/tokenHandler';
import {
  getAvalancheScanner,
  getPreparedAvalancheInputs,
} from '../jobs/initScanner';
import {
  ADA_DECIMALS,
  ERG_DECIMALS,
  EventStatus,
  ETHEREUM_BLOCK_TIME,
  BINANCE_BLOCK_TIME,
  ERGO_BLOCK_TIME,
} from '../utils/constants';
import { AvalancheScannerHealthCheckParam } from './avalancheHealthCheck';

const logger = DefaultLogger.getInstance().child(import.meta.url);
let healthCheck: HealthCheck | undefined;

/**
 * Returns the instance of the health check with all required parameters
 * @returns healthCheck instance
 */
const getHealthCheck = async () => {
  if (!healthCheck) {
    // initialize HealthCheck
    const notificationHandler = NotificationHandler.getInstance();
    const notificationConfig = {
      historyConfig: {
        cleanupThreshold: Configs.historyCleanupThreshold,
      },
      notificationCheckConfig: {
        hasBeenUnstableForAWhile: {
          windowDuration: Configs.hasBeenUnstableForAWhileWindowDuration,
        },
        hasBeenUnknownForAWhile: {
          windowDuration: Configs.hasBeenUnknownForAWhileWindowDuration,
        },
        isStillUnhealthy: {
          windowDuration: Configs.isStillUnhealthyWindowDuration,
        },
      },
    };
    const candidate = new HealthCheck(
      notificationHandler.notify,
      notificationConfig,
    );

    // TODO: local:ergo/rosen-bridge/health-check/55
    //  should replace p2p healthcheck param with detected active guards in detection scenario

    // add TxProgress param
    const getActiveTransactions = async (): Promise<TxInfo[]> => {
      return (await DatabaseAction.getInstance().getActiveTransactions()).map(
        (txEntity) => ({
          txId: txEntity.txId,
          txType: txEntity.type,
          signFailedCount: txEntity.signFailedCount,
          chain: txEntity.chain,
          eventId: txEntity.event?.id ?? '',
        }),
      );
    };
    const txProgressHealthCheck = new TxProgressHealthCheckParam(
      getActiveTransactions,
      Configs.txSignFailedWarnThreshold,
      Configs.txSignFailedCriticalThreshold,
    );
    candidate.register(txProgressHealthCheck);

    // add EventProgress param
    const getActiveEvents = async (): Promise<EventInfo[]> => {
      return (
        await DatabaseAction.getInstance().getEventsByStatuses([
          EventStatus.pendingPayment,
          EventStatus.pendingReward,
        ])
      ).map((eventEntity) => ({
        id: eventEntity.id,
        firstTry: eventEntity.firstTry,
        status: eventEntity.status,
      }));
    };
    const eventProgressHealthCheck = new EventProgressHealthCheckParam(
      getActiveEvents,
      Configs.eventDurationWarnThreshold,
      Configs.eventDurationCriticalThreshold,
    );
    candidate.register(eventProgressHealthCheck);

    const ergoContracts = rosenConfig.contractReader(ERGO_CHAIN);
    const cardanoContracts = rosenConfig.contractReader(CARDANO_CHAIN);
    const bitcoinContracts = rosenConfig.contractReader(BITCOIN_CHAIN);
    const ethereumContracts = rosenConfig.contractReader(ETHEREUM_CHAIN);
    const binanceContracts = rosenConfig.contractReader(BINANCE_CHAIN);
    // We skipped Doge, Firo and Handshake AssetCheck parameters, so we don't need their contracts here
    const bitcoinRunesContracts =
      rosenConfig.contractReader(BITCOIN_RUNES_CHAIN);

    const generateLastBlockFetcher = (scannerName: string) => {
      return async (): Promise<LastSavedBlock> => {
        try {
          return await DatabaseAction.getInstance().getLastSavedBlockForScanner(
            scannerName,
          );
        } catch (e) {
          if (e instanceof NotFoundError) {
            logger.info(
              `No block found in database. Passing 0 as last height to HealthCheck`,
            );
            return {
              height: 0,
              timestamp: 0,
            };
          } else throw e;
        }
      };
    };

    if (GuardsErgoConfigs.chainNetworkName === NODE_NETWORK) {
      const ergAssetHealthCheck = new ErgoNodeAssetHealthCheckParam(
        ERG,
        ERG,
        ergoContracts.addresses.lock,
        Configs.ergWarnThreshold,
        Configs.ergCriticalThreshold,
        GuardsErgoConfigs.node.url,
        ERG_DECIMALS,
      );
      candidate.register(ergAssetHealthCheck);

      const emissionTokenAssetHealthCheck = new ErgoNodeAssetHealthCheckParam(
        GuardsErgoConfigs.emissionTokenId,
        GuardsErgoConfigs.emissionTokenName,
        ergoContracts.addresses.lock,
        Configs.emissionTokenWarnThreshold,
        Configs.emissionTokenCriticalThreshold,
        GuardsErgoConfigs.node.url,
        GuardsErgoConfigs.emissionTokenDecimal,
      );
      candidate.register(emissionTokenAssetHealthCheck);

      const ergoScannerSyncCheck = new ScannerSyncHealthCheckParam(
        ERGO_CHAIN,
        generateLastBlockFetcher(ERGO_CHAIN),
        Configs.ergoScannerWarnDiff,
        Configs.ergoScannerCriticalDiff,
        ERGO_BLOCK_TIME,
        GuardsErgoConfigs.scannerInterval,
      );
      candidate.register(ergoScannerSyncCheck);

      const ergoNodeSyncCheck = new ErgoNodeSyncHealthCheckParam(
        Configs.ergoNodeMaxHeightDiff,
        Configs.ergoNodeMaxBlockTime,
        Configs.ergoNodeMinPeerCount,
        Configs.ergoNodeMaxPeerHeightDifference,
        GuardsErgoConfigs.node.url,
      );
      candidate.register(ergoNodeSyncCheck);
    } else if (GuardsErgoConfigs.chainNetworkName === EXPLORER_NETWORK) {
      const ergAssetHealthCheck = new ErgoExplorerAssetHealthCheckParam(
        ERG,
        ERG,
        ergoContracts.addresses.lock,
        Configs.ergWarnThreshold,
        Configs.ergCriticalThreshold,
        GuardsErgoConfigs.explorer.url,
        ERG_DECIMALS,
      );
      candidate.register(ergAssetHealthCheck);

      const emissionTokenAssetHealthCheck =
        new ErgoExplorerAssetHealthCheckParam(
          GuardsErgoConfigs.emissionTokenId,
          GuardsErgoConfigs.emissionTokenName,
          ergoContracts.addresses.lock,
          Configs.emissionTokenWarnThreshold,
          Configs.emissionTokenCriticalThreshold,
          GuardsErgoConfigs.explorer.url,
          GuardsErgoConfigs.emissionTokenDecimal,
        );
      candidate.register(emissionTokenAssetHealthCheck);

      const ergoScannerSyncCheck = new ScannerSyncHealthCheckParam(
        ERGO_CHAIN,
        generateLastBlockFetcher(ERGO_CHAIN),
        Configs.ergoScannerWarnDiff,
        Configs.ergoScannerCriticalDiff,
        ERGO_BLOCK_TIME,
        GuardsErgoConfigs.scannerInterval,
      );
      candidate.register(ergoScannerSyncCheck);
    }
    if (GuardsCardanoConfigs.chainNetworkName === KOIOS_NETWORK) {
      const adaAssetHealthCheck = new CardanoKoiosAssetHealthCheckParam(
        ADA,
        ADA,
        cardanoContracts.addresses.lock,
        Configs.adaWarnThreshold,
        Configs.adaCriticalThreshold,
        GuardsCardanoConfigs.koios.url,
        ADA_DECIMALS,
        GuardsCardanoConfigs.koios.authToken,
      );
      candidate.register(adaAssetHealthCheck);
    } else if (GuardsCardanoConfigs.chainNetworkName === BLOCKFROST_NETWORK) {
      const adaAssetHealthCheck = new CardanoBlockFrostAssetHealthCheckParam(
        ADA,
        ADA,
        cardanoContracts.addresses.lock,
        Configs.adaWarnThreshold,
        Configs.adaCriticalThreshold,
        GuardsCardanoConfigs.blockfrost.projectId,
        ADA_DECIMALS,
        GuardsCardanoConfigs.blockfrost.url,
      );
      candidate.register(adaAssetHealthCheck);
    }
    if (GuardsBitcoinConfigs.chainNetworkName === 'esplora') {
      // register BTC asset-check on Bitcoin lock address
      const btcAssetHealthCheck = new EsploraAssetHealthCheckParam(
        BITCOIN_CHAIN,
        BTC,
        bitcoinContracts.addresses.lock,
        Configs.btcWarnThreshold,
        Configs.btcCriticalThreshold,
        GuardsBitcoinConfigs.esplora.url,
        8,
      );
      candidate.register(btcAssetHealthCheck);
      // register BTC asset-check on Bitcoin Runes lock address
      const btcRunesAssetHealthCheck = new EsploraAssetHealthCheckParam(
        BITCOIN_RUNES_CHAIN,
        BTC,
        bitcoinRunesContracts.addresses.lock,
        Configs.btcWarnThreshold,
        Configs.btcCriticalThreshold,
        GuardsBitcoinConfigs.esplora.url,
        8,
      );
      candidate.register(btcRunesAssetHealthCheck);
    }
    if (GuardsEthereumConfigs.chainNetworkName === 'rpc') {
      const ethAssetHealthCheck = new EvmRpcAssetHealthCheckParam(
        ETHEREUM_CHAIN,
        ETH,
        ETH,
        ETH,
        ethereumContracts.addresses.lock,
        Configs.ethWarnThreshold,
        Configs.ethCriticalThreshold,
        GuardsEthereumConfigs.rpc.url,
        8,
        GuardsEthereumConfigs.rpc.authToken,
        18,
      );
      candidate.register(ethAssetHealthCheck);

      const ethereumScannerSyncCheck = new ScannerSyncHealthCheckParam(
        ETHEREUM_CHAIN,
        generateLastBlockFetcher(ETHEREUM_CHAIN),
        Configs.ethereumScannerWarnDiff,
        Configs.ethereumScannerCriticalDiff,
        ETHEREUM_BLOCK_TIME,
        GuardsEthereumConfigs.rpc.scannerInterval,
      );
      candidate.register(ethereumScannerSyncCheck);
    }
    if (GuardsBinanceConfigs.chainNetworkName === 'rpc') {
      const bnbAssetHealthCheck = new EvmRpcAssetHealthCheckParam(
        BINANCE_CHAIN,
        BNB,
        BNB,
        BNB,
        binanceContracts.addresses.lock,
        Configs.bnbWarnThreshold,
        Configs.bnbCriticalThreshold,
        GuardsBinanceConfigs.rpc.url,
        8,
        GuardsBinanceConfigs.rpc.authToken,
        18,
      );
      candidate.register(bnbAssetHealthCheck);

      const binanceScannerSyncCheck = new ScannerSyncHealthCheckParam(
        BINANCE_CHAIN,
        generateLastBlockFetcher(BINANCE_CHAIN),
        Configs.binanceScannerWarnDiff,
        Configs.binanceScannerCriticalDiff,
        BINANCE_BLOCK_TIME,
        GuardsBinanceConfigs.rpc.scannerInterval,
      );
      candidate.register(binanceScannerSyncCheck);
    }

    const avalancheInputs = getPreparedAvalancheInputs();
    if (avalancheInputs) {
      const thresholds = Configs.getAvalancheHealthConfig();
      const scanner = getAvalancheScanner();
      if (!scanner)
        throw new Error('Avalanche health requires a registered scanner');
      const chains = ChainHandler.getInstance();
      const database = DatabaseAction.getInstance();
      const chain = chains.getChain('avalanche') as AvalancheChain;
      const network = chain.network as AvalancheRpcNetwork;
      const assertNetwork = network.assertNetwork;
      const withHealthRead = scanner.withHealthRead;
      const nativeBalance = network.getAddressBalanceForNativeToken;
      const tokenBalance = network.getAddressBalanceForERC20Asset;
      const readLockBalance = chains.getAvalancheLockBalance;
      /** Rechecks the exact registered custody source across each health read. */
      const assertSource = () => {
        if (
          getAvalancheScanner() !== scanner ||
          scanner.withHealthRead !== withHealthRead ||
          chains.getChain('avalanche') !== chain ||
          chain.network !== network ||
          network.expectedChainId !== BigInt(avalancheInputs.config.chainId) ||
          network.assertNetwork !== assertNetwork ||
          network.getAddressBalanceForNativeToken !== nativeBalance ||
          network.getAddressBalanceForERC20Asset !== tokenBalance ||
          chains.getAvalancheLockBalance !== readLockBalance
        )
          throw new Error('Avalanche asset health source changed');
      };
      /** Holds scanner exclusion for raw custody reads and refuses late source drift. */
      const healthReadTimeoutMs = Math.ceil(
        avalancheInputs.config.rpc.timeout * 1000,
      );
      const healthReadMaxPending = chain.supportedTokens.length + 2;
      const qualified = <T>(read: () => Promise<T>) =>
        withHealthRead(
          async () => {
            assertSource();
            const value = await read();
            assertSource();
            return value;
          },
          healthReadTimeoutMs,
          healthReadMaxPending,
        );
      const nativeHealth = new AvalancheRpcAssetHealthCheckParam(
        {
          chainId: avalancheInputs.config.chainId,
          sourceId: avalancheInputs.config.sourceId,
          address: avalancheInputs.contracts.addresses.lock,
          warnThreshold: thresholds.nativeWarnWei,
          criticalThreshold: thresholds.nativeCriticalWei,
        },
        {
          expectedChainId: network.expectedChainId,
          assertNetwork: async () => {
            assertSource();
            await assertNetwork.call(network);
            assertSource();
          },
          getAddressBalanceForNativeToken: async () =>
            qualified(() => readLockBalance.call(chains)),
        },
      );
      // This Guard registers one native AVAX parameter; retain its monitoring ID.
      nativeHealth.getId = () => 'avalanche-native-balance';
      candidate.register(nativeHealth);
      const selected = thresholds.tokens ?? [];
      if (
        selected.length !== chain.supportedTokens.length ||
        selected.some((token) => !chain.supportedTokens.includes(token.tokenId))
      )
        throw new Error(
          'Avalanche health requires thresholds for every mapped token',
        );
      for (const token of selected) {
        const tokens = TokenHandler.getInstance().getTokenMap();
        const matches = tokens.search('avalanche', { tokenId: token.tokenId });
        if (matches.length !== 1 || typeof tokenBalance !== 'function')
          throw new Error('Invalid Avalanche token health source');
        const asset = matches[0].avalanche;
        const metadata = JSON.stringify(asset);
        const search = tokens.search;
        /** Retains the selected map and asset metadata during qualified reads. */
        const assertToken = () => {
          assertSource();
          if (
            TokenHandler.getInstance().getTokenMap() !== tokens ||
            tokens.search !== search ||
            JSON.stringify(
              search.call(tokens, 'avalanche', { tokenId: token.tokenId })[0]
                ?.avalanche,
            ) !== metadata
          )
            throw new Error('Avalanche token health map changed');
        };
        candidate.register(
          new AvalancheRpcAssetHealthCheckParam(
            {
              chainId: avalancheInputs.config.chainId,
              sourceId: avalancheInputs.config.sourceId,
              address: avalancheInputs.contracts.addresses.lock,
              warnThreshold: token.warnRaw,
              criticalThreshold: token.criticalRaw,
              token: {
                tokenId: token.tokenId,
                name: asset.name,
                decimals: asset.decimals,
              },
            },
            {
              expectedChainId: network.expectedChainId,
              assertNetwork: async () => {
                assertToken();
                await assertNetwork.call(network);
                assertToken();
              },
              getAddressBalanceForNativeToken: async () =>
                qualified(() => readLockBalance.call(chains)),
              getAddressBalanceForERC20Asset: async (address, id) =>
                qualified(async () => {
                  assertToken();
                  const value = await tokenBalance.call(network, address, id);
                  assertToken();
                  return value;
                }),
            },
          ),
        );
      }
      const lastSavedBlock = database.getLastSavedBlockForScanner;
      /** Refuses late replacement of the database reader used by scanner health. */
      const assertScannerHealthSource = () => {
        assertSource();
        if (
          DatabaseAction.getInstance() !== database ||
          database.getLastSavedBlockForScanner !== lastSavedBlock
        )
          throw new Error('Avalanche scanner health source changed');
      };
      candidate.register(
        new AvalancheScannerHealthCheckParam(thresholds, () =>
          qualified(async () => {
            assertScannerHealthSource();
            const value = await lastSavedBlock.call(database, 'avalanche');
            assertScannerHealthSource();
            return value;
          }),
        ),
      );
    }

    // add LogLevel param
    const warnLogCheck = new LogLevelHealthCheck(
      HealthStatusLevel.UNSTABLE,
      Configs.warnLogAllowedCount,
      Configs.logDuration,
      'warn',
    );
    candidate.register(warnLogCheck);
    const errorLogCheck = new LogLevelHealthCheck(
      HealthStatusLevel.UNSTABLE,
      Configs.errorLogAllowedCount,
      Configs.logDuration,
      'error',
    );
    candidate.register(errorLogCheck);
    healthCheck = candidate;
  }

  return healthCheck;
};

export { getHealthCheck };
