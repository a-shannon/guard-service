import * as wasm from 'ergo-lib-wasm-nodejs';
import { isDeepStrictEqual } from 'node:util';

import { ErgoTransaction } from '@rosen-chains/ergo';

/** Checks canonical auxiliary box bytes against ordered expected identities. */
const canonicalAuxiliary = (
  boxes: readonly Uint8Array[],
  references: readonly string[],
): Buffer[] => {
  if (!Array.isArray(boxes) || boxes.length !== references.length)
    throw new Error('Ergo auxiliary count mismatch');
  const seen = new Set<string>();
  return Array.from({ length: references.length }, (_, index) => {
    if (!Object.hasOwn(boxes, index))
      throw new Error('Ergo auxiliary slot is missing');
    const bytes = boxes[index];
    if (!(bytes instanceof Uint8Array))
      throw new Error('Invalid Ergo auxiliary bytes');
    const box = wasm.ErgoBox.sigma_parse_bytes(bytes);
    try {
      const id = box.box_id();
      let key: string;
      try {
        key = id.to_str();
      } finally {
        id.free();
      }
      const canonical = Buffer.from(box.sigma_serialize_bytes());
      if (
        seen.has(key) ||
        key !== references[index] ||
        !canonical.equals(Buffer.from(bytes))
      )
        throw new Error('Ergo auxiliary identity mismatch');
      seen.add(key);
      return canonical;
    } finally {
      box.free();
    }
  });
};

/** Extracts signed Ergo identities and payment semantics with owned resources. */
const signedSemantics = (model: ErgoTransaction) => {
  if (
    !model ||
    model.network !== 'ergo' ||
    !(model.txBytes instanceof Uint8Array)
  )
    throw new Error('Invalid signed Ergo model');
  const transaction = wasm.Transaction.sigma_parse_bytes(model.txBytes);
  try {
    const id = transaction.id();
    let txId: string;
    try {
      txId = id.to_str();
    } finally {
      id.free();
    }
    if (
      model.txId !== txId ||
      !Buffer.from(transaction.sigma_serialize_bytes()).equals(
        Buffer.from(model.txBytes),
      )
    )
      throw new Error('Signed Ergo identity mismatch');

    const inputs = transaction.inputs();
    const unsignedInputs = new wasm.UnsignedInputs();
    try {
      for (let index = 0; index < inputs.len(); index++) {
        const input = inputs.get(index);
        const proof = input.spending_proof();
        const boxId = input.box_id();
        const extension = proof.extension();
        try {
          const unsignedInput = new wasm.UnsignedInput(boxId, extension);
          try {
            unsignedInputs.add(unsignedInput);
          } finally {
            unsignedInput.free();
          }
        } finally {
          extension.free();
          boxId.free();
          proof.free();
          input.free();
        }
      }
      const dataInputs = transaction.data_inputs();
      const outputs = transaction.output_candidates();
      try {
        const unsigned = new wasm.UnsignedTransaction(
          unsignedInputs,
          dataInputs,
          outputs,
        );
        try {
          // EIP-12 retains exact decimal strings and every body field; only the
          // proofs are removed by the public WASM reconstruction above.
          const body = unsigned.to_js_eip12();
          return {
            txId,
            body,
            inputs: canonicalAuxiliary(
              model.inputBoxes,
              body.inputs.map((input: { boxId: string }) => input.boxId),
            ),
            dataInputs: canonicalAuxiliary(
              model.dataInputs,
              body.dataInputs.map((input: { boxId: string }) => input.boxId),
            ),
          };
        } finally {
          unsigned.free();
        }
      } finally {
        dataInputs.free();
        outputs.free();
      }
    } finally {
      inputs.free();
      unsignedInputs.free();
    }
  } finally {
    transaction.free();
  }
};

/** Extracts canonical reduced Ergo identities and unsigned payment semantics. */
const reducedSemantics = (model: ErgoTransaction) => {
  if (
    !model ||
    model.network !== 'ergo' ||
    !(model.txBytes instanceof Uint8Array)
  )
    throw new Error('Invalid reduced Ergo model');
  const transaction = wasm.ReducedTransaction.sigma_parse_bytes(model.txBytes);
  try {
    if (
      !Buffer.from(transaction.sigma_serialize_bytes()).equals(
        Buffer.from(model.txBytes),
      )
    )
      throw new Error('Noncanonical reduced Ergo bytes');
    const unsigned = transaction.unsigned_tx();
    try {
      const id = unsigned.id();
      let txId: string;
      try {
        txId = id.to_str();
      } finally {
        id.free();
      }
      if (model.txId !== txId)
        throw new Error('Reduced Ergo identity mismatch');
      const body = unsigned.to_js_eip12();
      return {
        txId,
        body,
        inputs: canonicalAuxiliary(
          model.inputBoxes,
          body.inputs.map((input: { boxId: string }) => input.boxId),
        ),
        dataInputs: canonicalAuxiliary(
          model.dataInputs,
          body.dataInputs.map((input: { boxId: string }) => input.boxId),
        ),
      };
    } finally {
      unsigned.free();
    }
  } finally {
    transaction.free();
  }
};

/** Validates representation, model ID and complete ordered boxes, not reduction correctness. */
export const assertCanonicalReducedErgo = (model: ErgoTransaction): void => {
  reducedSemantics(model);
};

/**
 * Compare a canonical Reduced transaction with a canonical Signed transaction.
 * Proof bytes are deliberately excluded; proof validity, execution, settlement,
 * eventId and txType authorization remain the caller's responsibility.
 */
export const assertReducedToSignedErgoSemantics = (
  reduced: ErgoTransaction,
  signed: ErgoTransaction,
): void => {
  const expected = reducedSemantics(reduced);
  const actual = signedSemantics(signed);
  if (!isDeepStrictEqual(expected, actual))
    throw new Error('Reduced-to-signed Ergo semantics mismatch');
};

/**
 * Compare canonical signed Ergo bodies and their complete ordered auxiliary
 * boxes, allowing different proof bytes. This does not validate proofs,
 * execution, or settlement. Both networks must be Ergo; eventId and txType are
 * application metadata, deliberately left to the caller's authority checks.
 */
export const assertSameSignedErgoSemantics = (
  captured: ErgoTransaction,
  observed: ErgoTransaction,
): void => {
  const expected = signedSemantics(captured);
  const actual = signedSemantics(observed);
  if (!isDeepStrictEqual(expected, actual))
    throw new Error('Signed Ergo semantics mismatch');
};
