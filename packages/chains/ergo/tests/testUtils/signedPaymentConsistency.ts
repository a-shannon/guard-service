import * as wasm from 'ergo-lib-wasm-nodejs';

import ErgoTransaction from '../../lib/ergoTransaction';
import Serializer from '../../lib/serializer';
import { generateChainObject } from '../ergoTestUtils';
import TestErgoNetwork from '../network/testErgoNetwork';
import {
  transaction2PartialUnsignedPaymentTransaction,
  transaction2SignedSerialized,
  transaction5PaymentTransaction,
} from '../transactionTestData';

/**
 * Creates fresh pinned and complete signed payment builders using actual WASM codecs.
 * Empty proofs exercise serialization and box identities, not spending validity.
 */
export const createSignedPaymentFixtures = () => {
  /**
   * Create a fresh chain over the fixture network.
   */
  const chain = () => generateChainObject(new TestErgoNetwork());

  /**
   * Create the partial payment with its pinned signed serialization.
   */
  const pinnedSigned = () => {
    const transaction = ErgoTransaction.fromJson(
      transaction2PartialUnsignedPaymentTransaction,
    );
    transaction.txBytes = Buffer.from(transaction2SignedSerialized, 'hex');
    return transaction;
  };

  // Complete fixture boxes are available for transaction5. Empty proofs supply
  // the signed serialization shape; these tests do not verify spending proofs.
  /**
   * Create a complete payment using the actual empty-proof signed codec.
   */
  const completeSigned = () => {
    const transaction = ErgoTransaction.fromJson(
      transaction5PaymentTransaction,
    );
    const unsigned = Serializer.deserialize(transaction.txBytes).unsigned_tx();
    const signed = wasm.Transaction.from_unsigned_tx(
      unsigned,
      Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
    );
    transaction.txBytes = Serializer.signedSerialize(signed);
    return transaction;
  };
  return { chain, pinnedSigned, completeSigned };
};
