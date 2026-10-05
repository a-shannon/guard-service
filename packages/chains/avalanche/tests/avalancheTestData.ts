import { EvmConfigs } from '@rosen-chains/evm';

/** Address recovered from the public synthetic 0x11 scalar fixture. */
export const address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
/** Event identifier bound into synthetic payment metadata. */
export const eventId = 'ab'.repeat(32);
/** Baseline native payment, confirmation and gas-limit configuration. */
export const configs: EvmConfigs = {
  fee: 1n,
  rwtId: 'cd'.repeat(32),
  addresses: { lock: address, cold: address, permit: '', fraud: '' },
  confirmations: {
    observation: 1,
    payment: 1,
    cold: 1,
    manual: 1,
    arbitrary: 1,
  },
  maxParallelTx: 1,
  gasPriceSlippage: 10n,
  gasLimitSlippage: 10n,
  gasLimitMultiplier: 2n,
  gasLimitCap: 100000n,
};
