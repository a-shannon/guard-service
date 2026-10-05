import { FeeData, Transaction } from 'ethers';

import {
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import { createManagementSafetyFixture } from '../utils/avalancheManagementSafetyTestUtils';
import { createManagementAuthorizationFixture } from '../verification/avalancheManagementAuthorizationTestUtils';

/** Joins real package fee/envelope checks, runtime and SQLite scanner to synthetic DAO ports. */
export const createManagementSigningFixture = async (
  type: TransactionType = TransactionType.coldStorage,
  token = false,
) => {
  const f = await createManagementAuthorizationFixture(type, token);
  const s = await createManagementSafetyFixture(type, f.chain.CHAIN_ID);
  f.fee.mockRestore();
  const gas = vi.spyOn(f.network, 'getGasRequired').mockResolvedValue(21000n);
  vi.spyOn(f.network, 'getFeeData').mockResolvedValue(
    new FeeData(null, 20000000000n, 2000000000n),
  );
  vi.spyOn(f.network, 'assertNetwork').mockResolvedValue(undefined);
  const runtime = createGuardSigningRuntime({
    getEvent: vi.fn(async () => null),
    getTx: async () => {
      const row = await f.getTx();
      if (!row) return null;
      return {
        ...row,
        event: null,
        order: row.order
          ? {
              id: row.order.id,
              chain: 'avalanche',
              status: f.order.status,
              orderJson: f.order.orderJson,
              firstTry: '0',
              unexpectedFails: 0,
            }
          : null,
        lastCheck: 0,
        lastStatusUpdate: '0',
        failedInSign: false,
        signFailedCount: 0,
      };
    },
    decode: (json) => f.chain.PaymentTransactionFromJson(json),
    getScanner: s.getScanner,
    curveTimeoutSeconds: 1,
    edwardTimeoutSeconds: 1,
    ergoTimeoutSeconds: 1,
    maxPending: 2,
    management: {
      getPolicy: f.getPolicy,
      getChain: () => f.chain,
      getTx: f.getTx,
      decode: (json) => f.chain.PaymentTransactionFromJson(json),
      getOrder: f.getOrder,
      getOrderTxIds: f.getOrderTxIds,
      getColdState: f.getColdState,
      assertTokenMapUnchanged: f.unchanged,
    },
  });
  const key = {
    algorithm: 'ecdsa' as const,
    chainCode: f.policy.config.tssChainCode,
    derivationPath: [...f.policy.config.derivationPath],
  };
  const identity = { ...key, message: f.tx.unsignedHash.slice(2) };
  const bound = await runtime.context.bind(f.row, ['in-sign']);
  return {
    ...s,
    ...f,
    runtime,
    key,
    identity,
    bound,
    gas,
    signed: () => {
      const tx = Transaction.from(f.tx.unsignedSerialized);
      tx.signature = f.key.sign(tx.unsignedHash);
      return new PaymentTransaction(
        'avalanche',
        tx.unsignedHash,
        f.payment().eventId,
        Buffer.from(tx.serialized.slice(2), 'hex'),
        type,
      );
    },
    close: async () => {
      f.close();
      await s.close();
    },
  };
};
