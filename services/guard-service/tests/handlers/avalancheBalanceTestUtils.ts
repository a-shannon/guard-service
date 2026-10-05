import {
  AvalancheBalanceConfig,
  readAvalancheBalanceConfig,
} from '../../src/configs/avalancheBalanceConfig';
import BalanceHandler from '../../src/handlers/balanceHandler';

/** Expose construction and injected token batches while retaining real balance logic. */
export class TestBalances extends BalanceHandler {
  tokens: string[] = [];
  /** Construct the real handler with an optional synthetic balance policy. */
  constructor(config?: AvalancheBalanceConfig) {
    super(config);
  }
  /** Return the scenario's explicit supported-token batch. */
  protected getChainTokenIds = () => this.tokens;
}
/** Build a bounded synthetic Avalanche balance policy. */
export const policy = () =>
  readAvalancheBalanceConfig({
    updateInterval: 12,
    updateBatchInterval: 0.001,
    tokensPerIteration: { rpc: 2 },
  });
