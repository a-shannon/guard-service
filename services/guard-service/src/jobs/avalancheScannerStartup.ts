import {
  BlockEntity,
  ExtractorStatusEntity,
} from '@rosen-bridge/abstract-scanner';
import { AddressTxsEntity } from '@rosen-bridge/evm-address-tx-extractor';
import {
  AvalancheRpcScanner,
  AvalancheSafetyState,
} from '@rosen-bridge/evm-scanner';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { EventTriggerEntity } from '@rosen-bridge/watcher-data-extractor';

import { GuardsAvalancheConfig } from '../configs/guardsAvalancheConfigs';
import { readAvalancheBridgeContracts } from '../configs/rosenConfig';
import { AddressEntity } from '../db/entities/addressEntity';
import { ArbitraryEntity } from '../db/entities/arbitraryEntity';
import { ChainAddressBalanceEntity } from '../db/entities/chainAddressBalanceEntity';
import { TransactionEntity } from '../db/entities/transactionEntity';
import { AvalancheBridgeContracts } from '../types/contract';
import {
  AVALANCHE_LOCK_EXTRACTOR_ID,
  AvalancheScannerDependencies,
  createAvalancheScanner,
} from '../utils/avalancheScanner';

export interface PreparedAvalancheInputs {
  readonly config: GuardsAvalancheConfig;
  readonly contracts: AvalancheBridgeContracts;
}

/** One startup owner and one update loop for the single-writer safety lease. */
export class AvalancheScannerStartup {
  private phase:
    | 'new'
    | 'preparing'
    | 'prepared'
    | 'initializing'
    | 'initialized'
    | 'started' = 'new';
  private config?: GuardsAvalancheConfig;
  private inputs?: PreparedAvalancheInputs;
  private source?: DataSource;
  private scanner?: AvalancheRpcScanner;
  private run?: () => Promise<void>;

  /** Retains startup readers, the scanner factory and the update scheduler. */
  constructor(
    private readonly readConfig: () => GuardsAvalancheConfig | undefined,
    private readonly readContracts: () => AvalancheBridgeContracts,
    private readonly getSource: () => DataSource,
    private readonly create = createAvalancheScanner,
    private readonly schedule: (
      action: () => void,
      milliseconds: number,
    ) => unknown = setTimeout,
  ) {}

  /** Returns the scanner once initialization has constructed it. */
  getScanner = (): AvalancheRpcScanner | undefined => this.scanner;

  /** Returns captured enabled-chain inputs only after preparation has completed. */
  getPreparedInputs = (): PreparedAvalancheInputs | undefined => {
    if (this.phase === 'new' || this.phase === 'preparing')
      throw new Error('Avalanche startup inputs are not prepared');
    return this.inputs;
  };

  /** Captures enabled policy or rejects disabled startup when Avalanche state remains. */
  prepare = async (): Promise<void> => {
    if (this.phase !== 'new')
      throw new Error('Avalanche scanner preparation already attempted');
    this.phase = 'preparing';
    const config = this.readConfig();
    const source = this.getSource();
    if (!source.isInitialized)
      throw new Error('Avalanche startup requires an initialized database');
    this.source = source;
    if (config) {
      // Capture operator inputs before any later startup work can mutate them.
      this.config = Object.freeze({
        ...config,
        rpc: Object.freeze({ ...config.rpc }),
        confirmations: Object.freeze({ ...config.confirmations }),
        routes: Object.freeze({ ...config.routes }),
        derivationPath: Object.freeze([
          ...config.derivationPath,
        ]) as unknown as number[],
      });
      this.inputs = Object.freeze({
        config: this.config,
        contracts: readAvalancheBridgeContracts(this.readContracts()),
      });
    } else {
      // Configuration removal is refused for all recorded Avalanche state,
      // including historical orders, registered addresses, and cached balances.
      const residues = await Promise.all([
        source.getRepository(AvalancheSafetyState).count(),
        source.getRepository(BlockEntity).countBy({ scanner: 'avalanche' }),
        source.getRepository(ExtractorStatusEntity).count({
          where: [
            { scannerId: 'avalanche' },
            { extractorId: AVALANCHE_LOCK_EXTRACTOR_ID },
            { extractorId: 'avalancheCommitment' },
            { extractorId: 'avalancheEventTrigger' },
          ],
        }),
        source
          .getRepository(AddressTxsEntity)
          .countBy({ extractor: AVALANCHE_LOCK_EXTRACTOR_ID }),
        source
          .getRepository(TransactionEntity)
          .createQueryBuilder('tx')
          .where('LOWER(tx.chain) = :chain', { chain: 'avalanche' })
          .getCount(),
        source
          .getRepository(ArbitraryEntity)
          .createQueryBuilder('orders')
          .where('LOWER(orders.chain) = :chain', { chain: 'avalanche' })
          .getCount(),
        source
          .getRepository(AddressEntity)
          .createQueryBuilder('address')
          .where('LOWER(address.chain) = :chain', { chain: 'avalanche' })
          .getCount(),
        source
          .getRepository(ChainAddressBalanceEntity)
          .createQueryBuilder('balance')
          .where('LOWER(balance.chain) = :chain', { chain: 'avalanche' })
          .getCount(),
        source
          .getRepository(EventTriggerEntity)
          .createQueryBuilder('event')
          .where(
            'LOWER(event.fromChain) = :chain OR LOWER(event.toChain) = :chain',
            { chain: 'avalanche' },
          )
          .getCount(),
      ]);
      if (residues.some((count) => count !== 0))
        throw new Error(
          'Stored Avalanche state, including historical orders, addresses, and balances, requires enabled Avalanche configuration',
        );
    }
    this.phase = 'prepared';
  };

  /** Constructs the prepared scanner and its single update loop before registration. */
  initialize = async (
    dependencies: Omit<
      AvalancheScannerDependencies,
      'dataSource' | 'lockAddress'
    >,
  ): Promise<void> => {
    if (this.phase !== 'prepared')
      throw new Error(
        'Avalanche scanner is not prepared or initialization already attempted',
      );
    this.phase = 'initializing';
    if (this.config) {
      const instance = await this.create(this.config, {
        ...dependencies,
        dataSource: this.source!,
        lockAddress: this.inputs!.contracts.addresses.lock,
      });
      this.scanner = instance.scanner;
      /** Runs one update and schedules the next attempt even after a failed update. */
      const run = async (): Promise<void> => {
        try {
          await instance.scanner.update();
        } catch {
          dependencies.logger.warn(
            'Avalanche scanner update failed; inspect persisted safety state.',
          );
        } finally {
          this.schedule(() => {
            void run();
          }, instance.intervalMs);
        }
      };
      this.run = run;
    }
    this.phase = 'initialized';
  };

  /** Starts the registered scanner loop once, leaving disabled startup idle. */
  start = (): void => {
    if (this.phase !== 'initialized')
      throw new Error('Avalanche scanner is not registered or already started');
    this.phase = 'started';
    if (this.run) void this.run();
  };
}
