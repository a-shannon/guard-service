import { DataSource } from '@rosen-bridge/extended-typeorm';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import { DatabaseAction } from '../../src/db/databaseAction';

/** Exposes the existing protected DAO constructor to SQLite test fixtures. */
export class TestDatabase extends DatabaseAction {
  /** Retains the caller-owned fixture source. */
  constructor(source: DataSource) {
    super(source);
  }
}

/** Encodes the synthetic fixture height as a 32-byte hash. */
export const blockHash = (height: number) =>
  '0x' + height.toString(16).padStart(64, '0');

/** Restores the captured payment or Ergo transaction JSON. */
export const decode = (json: string): PaymentTransaction => {
  const value = JSON.parse(json);
  return value.network === 'ergo'
    ? ErgoTransaction.fromJson(json)
    : new PaymentTransaction(
        value.network,
        value.txId,
        value.eventId,
        Buffer.from(value.txBytes, 'hex'),
        value.txType,
      );
};

/** Creates a promise with explicit resolution controls. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
