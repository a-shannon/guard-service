import * as wasm from 'ergo-lib-wasm-nodejs';

import { generateChainObject } from '../ergoTestUtils';
import TestErgoNetwork from '../network/testErgoNetwork';
import { transaction2SignedSerialized } from '../transactionTestData';

/**
 * Create a signed transaction with free/getTransaction spies for lifetime checks.
 */
export const createTransactionLifetimeFixture = () => {
  const transaction = wasm.Transaction.sigma_parse_bytes(
    Buffer.from(transaction2SignedSerialized, 'hex'),
  );
  const free = vi.spyOn(transaction, 'free');
  const network = new TestErgoNetwork();
  const fetch = vi
    .spyOn(network, 'getTransaction')
    .mockResolvedValue(transaction);
  return {
    transaction,
    free,
    fetch,
    chain: generateChainObject(network),
  };
};
