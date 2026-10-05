import { ChainMinimumFee } from '@rosen-bridge/minimum-fee';

import { ChainConfigs, EventTrigger } from '../lib';
import { validEvent } from './testData';

export const readerConfig: ChainConfigs = {
  fee: 100n,
  confirmations: {
    observation: 5,
    payment: 6,
    cold: 7,
    manual: 8,
    arbitrary: 9,
  },
  addresses: {
    lock: 'lock_addr',
    cold: 'cold_addr',
    permit: 'permit_addr',
    fraud: 'fraud_addr',
  },
  rwtId: 'rwt',
};

export const readerFees = new ChainMinimumFee({
  bridgeFee: 0n,
  networkFee: 0n,
  feeRatio: 0n,
  rsnRatio: 0n,
  rsnRatioDivisor: 10000000000000000n,
});

export const readerEventA: EventTrigger = {
  ...validEvent,
  sourceTxId: 'reader-tx-a',
  sourceBlockId: 'reader-block-a',
  fromAddress: 'reader-address-a',
};

export const readerEventB: EventTrigger = {
  ...validEvent,
  sourceTxId: 'reader-tx-b',
  sourceBlockId: 'reader-block-b',
  sourceChainHeight: validEvent.sourceChainHeight + 1,
  fromAddress: 'reader-address-b',
};

export const readerMethods = [
  'getBlockTransactionIds',
  'getTransaction',
  'getBlockInfo',
] as const;
