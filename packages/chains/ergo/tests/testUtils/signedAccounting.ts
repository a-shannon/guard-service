import * as wasm from 'ergo-lib-wasm-nodejs';

import ErgoTransaction from '../../lib/ergoTransaction';
import Serializer from '../../lib/serializer';
import { generateChainObject } from '../ergoTestUtils';
import TestErgoNetwork from '../network/testErgoNetwork';
import { transaction5PaymentTransaction } from '../transactionTestData';

/**
 * Creates fresh signed/reduced accounting builders over complete transaction5 boxes.
 * Empty proofs provide the signed encoding; these fixtures do not prove spending.
 */
export const createSignedAccountingFixtures = () => {
  /**
   * Create a fresh reduced payment from the complete transaction5 boxes.
   */
  const reduced = () =>
    ErgoTransaction.fromJson(transaction5PaymentTransaction);

  /**
   * Create a chain with the fixture network and the expected 1,100,000 fee.
   */
  const chain = () => {
    const result = generateChainObject(new TestErgoNetwork());
    result.configs.fee = 1100000n;
    return result;
  };

  /**
   * Decode the reduced payment's unsigned transaction as a JSON model.
   */
  const model = () =>
    JSON.parse(
      Serializer.deserialize(reduced().txBytes).unsigned_tx().to_json(),
    );

  /**
   * Set empty-proof signed bytes and their actual transaction ID on the payment.
   */
  const signed = (body = model(), payment = reduced()) => {
    const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(body));
    // Real signed codec and auxiliary boxes, with empty proofs. Accounting does
    // not validate spending proofs or certify that the transaction can execute.
    const tx = wasm.Transaction.from_unsigned_tx(
      unsigned,
      Array.from({ length: unsigned.inputs().len() }, () => new Uint8Array()),
    );
    payment.txBytes = tx.sigma_serialize_bytes();
    payment.txId = tx.id().to_str();
    return payment;
  };
  return { reduced, chain, model, signed };
};
