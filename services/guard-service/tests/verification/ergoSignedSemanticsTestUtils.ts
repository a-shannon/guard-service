import * as wasm from 'ergo-lib-wasm-nodejs';

import { ErgoTransaction } from '@rosen-chains/ergo';

import { assertSameSignedErgoSemantics } from '../../src/verification/ergoSignedSemantics';
import reducedFixture from '../signing/fixtures/recoveryMultiInput';

/** Creates a fresh complete reduced model from the recovery fixture. */
export const reduced = () => ErgoTransaction.fromJson(reducedFixture);

/** Reads the unsigned EIP-12 model with owned WASM handles. */
export const body = () => {
  const tx = wasm.ReducedTransaction.sigma_parse_bytes(reduced().txBytes);
  const unsigned = tx.unsigned_tx();
  try {
    return unsigned.to_js_eip12();
  } finally {
    unsigned.free();
    tx.free();
  }
};

/** Creates canonical signed bytes with arbitrary proof data. */
export const signed = (value = body(), proof = [1, 2, 3]) => {
  const unsigned = wasm.UnsignedTransaction.from_json(JSON.stringify(value));
  const inputs = unsigned.inputs();
  const count = inputs.len();
  inputs.free();
  // Real WASM codecs, arbitrary proof bytes: no cryptographic validity claim.
  const tx = wasm.Transaction.from_unsigned_tx(
    unsigned,
    Array.from({ length: count }, () => Uint8Array.from(proof)),
  );
  const id = tx.id();
  try {
    const model = reduced();
    model.txBytes = tx.sigma_serialize_bytes();
    model.txId = id.to_str();
    return model;
  } finally {
    id.free();
    tx.free();
  }
};

/** Returns the signed semantics comparison assertion callback. */
export const compare =
  (captured: ErgoTransaction, observed: ErgoTransaction) => () =>
    assertSameSignedErgoSemantics(captured, observed);

/** Single-field semantic mutation controls for the complete model. */
export const mutations: [string, (value: ReturnType<typeof body>) => void][] = [
  [
    'extension',
    (value) => {
      value.inputs[0].extension = { '1': '0402' };
    },
  ],
  [
    'input order',
    (value) => {
      value.inputs.reverse();
    },
  ],
  [
    'value',
    (value) => {
      value.outputs[0].value = String(BigInt(value.outputs[0].value) + 1n);
    },
  ],
  [
    'token amount',
    (value) => {
      value.outputs[0].assets[0].amount = String(
        BigInt(value.outputs[0].assets[0].amount) + 1n,
      );
    },
  ],
  [
    'register',
    (value) => {
      value.outputs[0].additionalRegisters = { R4: '0402' };
    },
  ],
  [
    'tree',
    (value) => {
      value.outputs[0].ergoTree =
        '0008cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37f';
    },
  ],
  [
    'height',
    (value) => {
      value.outputs[0].creationHeight++;
    },
  ],
  [
    'output order',
    (value) => {
      value.outputs.reverse();
    },
  ],
];
