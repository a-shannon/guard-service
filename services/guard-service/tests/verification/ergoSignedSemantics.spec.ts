/* eslint vitest/expect-expect: ["error", {"assertFunctionNames": ["expect", "reject", "rejectReduced"]}] */
import * as wasm from 'ergo-lib-wasm-nodejs';

import { TransactionType } from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import {
  assertCanonicalReducedErgo,
  assertReducedToSignedErgoSemantics,
  assertSameSignedErgoSemantics,
} from '../../src/verification/ergoSignedSemantics';
import {
  reduced,
  body,
  signed,
  compare,
  mutations,
} from './ergoSignedSemanticsTestUtils';

describe('assertSameSignedErgoSemantics', () => {
  for (const field of ['inputBoxes', 'dataInputs'] as const) {
    for (const side of ['captured', 'observed', 'identical'] as const) {
      /**
       * @target assertSameSignedErgoSemantics `${side} ${field} rejects %s slots independently`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare captured, observed, boxes, original, length, prototype. Change only delete boxes[0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected toBe(original); toBe(length); toBe(false); toThrow('Ergo auxiliary slot is missing')
       */

      it.each(['sparse', 'inherited'])(
        `${side} ${field} rejects %s slots independently`,
        (kind) => {
          const captured = signed();
          const observed = side === 'identical' ? captured : signed();
          const boxes = (side === 'observed' ? observed : captured)[field];
          const original = boxes[0];
          const length = boxes.length;
          delete boxes[0];
          if (kind === 'inherited') {
            const prototype = Object.create(Object.getPrototypeOf(boxes));
            Object.defineProperty(prototype, '0', { value: original });
            Object.setPrototypeOf(boxes, prototype);
            expect(boxes[0]).toBe(original);
          }
          expect(boxes.length).toBe(length);
          expect(Object.hasOwn(boxes, 0)).toBe(false);
          expect(compare(captured, observed)).toThrow(
            'Ergo auxiliary slot is missing',
          );
        },
      );
    }
  }

  /**
   * @target assertSameSignedErgoSemantics 'accepts different canonical proofs for the same body and complete boxes'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare captured, observed. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toBe(observed.txId); toEqual(observed.txBytes); toThrow()
   */

  it('accepts different canonical proofs for the same body and complete boxes', () => {
    const captured = signed(undefined, []);
    const observed = signed();
    expect(captured.txId).toBe(observed.txId);
    expect(captured.txBytes).not.toEqual(observed.txBytes);
    expect(compare(captured, observed)).not.toThrow();
    expect(compare(observed, captured)).not.toThrow();
  });

  /**
   * @target assertSameSignedErgoSemantics 'leaves application event and transaction type authorization to its caller'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare observed. Change only observed.eventId, observed.txType as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow()
   */

  it('leaves application event and transaction type authorization to its caller', () => {
    const observed = signed();
    observed.eventId = 'different application event';
    observed.txType = TransactionType.manual;
    expect(compare(signed(), observed)).not.toThrow();
  });

  /**
   * @target assertSameSignedErgoSemantics 'does not modify caller buffers or arrays'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare captured, observed, before. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toEqual(before)
   */

  it('does not modify caller buffers or arrays', () => {
    const captured = signed();
    const observed = signed(undefined, []);
    const before = [captured.toJson(), observed.toJson()];
    assertSameSignedErgoSemantics(captured, observed);
    expect([captured.toJson(), observed.toJson()]).toEqual(before);
  });

  /**
   * @target assertSameSignedErgoSemantics 'preserves large output amounts as exact strings'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, captured. Change only value.outputs[0].value as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it('preserves large output amounts as exact strings', () => {
    const value = body();
    value.outputs[0].value = '9007199254740993';
    const captured = signed(value);
    expect(compare(captured, signed(value, []))).not.toThrow();
    value.outputs[0].value = '9007199254740992';
    expect(compare(captured, signed(value))).toThrow('semantics mismatch');
  });

  for (const side of ['captured', 'observed'] as const) {
    const reject = (
      mutate: (model: ErgoTransaction) => void,
      message?: string,
    ) => {
      const pair = { captured: signed(), observed: signed() };
      mutate(pair[side]);
      expect(compare(pair.captured, pair.observed)).toThrow(message);
    };
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects a non-Ergo network`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.network as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects a non-Ergo network`, () => {
      reject((model) => {
        model.network = 'avalanche';
      }, 'Invalid signed Ergo model');
    });
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects a mismatched model ID`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.txId as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects a mismatched model ID`, () => {
      reject((model) => {
        model.txId = '00'.repeat(32);
      }, 'identity mismatch');
    });
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects reduced bytes`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.txBytes as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects reduced bytes`, () => {
      reject((model) => {
        model.txBytes = reduced().txBytes;
      });
    });
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects malformed signed bytes`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.txBytes as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects malformed signed bytes`, () => {
      reject((model) => {
        model.txBytes = Uint8Array.of(255);
      });
    });
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects a plain byte array`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.txBytes as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects a plain byte array`, () => {
      reject((model) => {
        model.txBytes = [...model.txBytes] as unknown as Uint8Array;
      });
    });
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects signed suffix %s`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare parsed, id. Change only model.txBytes as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected toBe(model.txId)
     */

    it.each(['00', 'ff', '000102'])(
      `${side}: rejects signed suffix %s`,
      (suffix) => {
        reject((model) => {
          model.txBytes = Buffer.concat([
            model.txBytes,
            Buffer.from(suffix, 'hex'),
          ]);
          const parsed = wasm.Transaction.sigma_parse_bytes(model.txBytes);
          const id = parsed.id();
          expect(id.to_str()).toBe(model.txId);
          id.free();
          parsed.free();
        }, 'identity mismatch');
      },
    );
    for (const field of ['inputBoxes', 'dataInputs'] as const) {
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects missing ${field}`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Change only model[field] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects missing ${field}`, () => {
        reject((model) => {
          model[field] = undefined as unknown as Uint8Array[];
        }, 'count mismatch');
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects shorter ${field}`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects shorter ${field}`, () => {
        reject((model) => {
          model[field].pop();
        }, 'count mismatch');
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects extra ${field}`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects extra ${field}`, () => {
        reject((model) => {
          model[field].push(model[field][0]);
        }, 'count mismatch');
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects malformed ${field} bytes`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Change only model[field][0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects malformed ${field} bytes`, () => {
        reject((model) => {
          model[field][0] = Uint8Array.of(255);
        });
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects plain-array ${field} bytes`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Change only model[field][0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects plain-array ${field} bytes`, () => {
        reject((model) => {
          model[field][0] = [...model[field][0]] as unknown as Uint8Array;
        }, 'Invalid Ergo auxiliary bytes');
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects wrong equal-count ${field}`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare the complete model fixtures. Change only model[field][0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it(`${side}: rejects wrong equal-count ${field}`, () => {
        reject((model) => {
          model[field][0] = model.inputBoxes[1];
        }, 'auxiliary identity mismatch');
      });
      /**
       * @target assertSameSignedErgoSemantics `${side}: rejects ${field} suffix %s`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare original, parsed. Change only model[field][0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
       * @expected toEqual(Buffer.from(original))
       */

      it.each(['00', 'ff', '000102'])(
        `${side}: rejects ${field} suffix %s`,
        (suffix) => {
          reject((model) => {
            const original = model[field][0];
            model[field][0] = Buffer.concat([
              original,
              Buffer.from(suffix, 'hex'),
            ]);
            const parsed = wasm.ErgoBox.sigma_parse_bytes(model[field][0]);
            expect(Buffer.from(parsed.sigma_serialize_bytes())).toEqual(
              Buffer.from(original),
            );
            parsed.free();
          }, 'auxiliary identity mismatch');
        },
      );
    }
    /**
     * @target assertSameSignedErgoSemantics `${side}: rejects reordered input auxiliaries`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side}: rejects reordered input auxiliaries`, () => {
      reject((model) => {
        model.inputBoxes.reverse();
      }, 'auxiliary identity mismatch');
    });
  }

  /**
   * @target assertSameSignedErgoSemantics 'rejects duplicates even when both %s models match'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, model, aux. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow('auxiliary identity mismatch')
   */

  it.each(['inputs', 'dataInputs'] as const)(
    'rejects duplicates even when both %s models match',
    (field) => {
      const value = body();
      value[field].push(value[field][0]);
      const model = signed(value);
      const aux = field === 'inputs' ? model.inputBoxes : model.dataInputs;
      aux.push(aux[0]);
      expect(compare(model, model)).toThrow('auxiliary identity mismatch');
    },
  );

  /**
   * @target assertSameSignedErgoSemantics 'rejects reordered complete data auxiliaries'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, captured, observed. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('auxiliary identity mismatch')
   */

  it('rejects reordered complete data auxiliaries', () => {
    const value = body();
    value.dataInputs.push({ boxId: value.inputs[0].boxId });
    const captured = signed(value);
    captured.dataInputs.push(captured.inputBoxes[0]);
    const observed = ErgoTransaction.fromJson(captured.toJson());
    expect(compare(captured, observed)).not.toThrow();
    observed.dataInputs.reverse();
    expect(compare(captured, observed)).toThrow('auxiliary identity mismatch');
  });

  /**
   * @target assertSameSignedErgoSemantics 'rejects a self-consistent changed data-input order'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, captured, observed. Change only observed.dataInputs as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it('rejects a self-consistent changed data-input order', () => {
    const value = body();
    value.dataInputs.push({ boxId: value.inputs[0].boxId });
    const captured = signed(value);
    captured.dataInputs.push(captured.inputBoxes[0]);
    value.dataInputs.reverse();
    const observed = signed(value);
    observed.dataInputs = [...captured.dataInputs].reverse();
    expect(compare(observed, observed)).not.toThrow();
    expect(compare(captured, observed)).toThrow('semantics mismatch');
  });

  /**
   * @target assertSameSignedErgoSemantics 'rejects a changed input ID with its matching complete auxiliary box'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, observed. Change only value.inputs[0].boxId, observed.inputBoxes[0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it('rejects a changed input ID with its matching complete auxiliary box', () => {
    const value = body();
    value.inputs[0].boxId = value.dataInputs[0].boxId;
    const observed = signed(value);
    observed.inputBoxes[0] = observed.dataInputs[0];
    expect(compare(observed, observed)).not.toThrow();
    expect(compare(signed(), observed)).toThrow('semantics mismatch');
  });

  /**
   * @target assertSameSignedErgoSemantics 'rejects a changed data-input ID with its matching complete auxiliary box'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, observed. Change only value.dataInputs[0].boxId, observed.dataInputs[0] as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it('rejects a changed data-input ID with its matching complete auxiliary box', () => {
    const value = body();
    value.dataInputs[0].boxId = value.inputs[0].boxId;
    const observed = signed(value);
    observed.dataInputs[0] = observed.inputBoxes[0];
    expect(compare(observed, observed)).not.toThrow();
    expect(compare(signed(), observed)).toThrow('semantics mismatch');
  });

  /**
   * @target assertSameSignedErgoSemantics 'accepts empty data inputs only when the signed body also has none'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, captured, observed. Change only value.dataInputs, captured.dataInputs, observed.dataInputs as selected by the named control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow()
   */

  it('accepts empty data inputs only when the signed body also has none', () => {
    const value = body();
    value.dataInputs = [];
    const captured = signed(value);
    captured.dataInputs = [];
    const observed = signed(value, []);
    observed.dataInputs = [];
    expect(compare(captured, observed)).not.toThrow();
  });

  /**
   * @target assertSameSignedErgoSemantics 'rejects a self-consistent changed %s body'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare value, observed. Exercise the named valid, malformed or reordered fixture control. Invoke assertSameSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it.each(mutations)(
    'rejects a self-consistent changed %s body',
    (name, mutate) => {
      const value = body();
      mutate(value);
      const observed = signed(value);
      if (name === 'input order') observed.inputBoxes.reverse();
      expect(compare(observed, observed)).not.toThrow();
      expect(compare(signed(), observed)).toThrow('semantics mismatch');
    },
  );
});
describe('assertReducedToSignedErgoSemantics', () => {
  const compareReduced =
    (captured = reduced(), observed = signed()) =>
    () =>
      assertReducedToSignedErgoSemantics(captured, observed);

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'accepts actual canonical Reduced and Signed with arbitrary proof variant %j'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare captured, observed, before. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toEqual(before)
   */

  it.each([[], [1, 2, 3], [255, 0, 1]])(
    'accepts actual canonical Reduced and Signed with arbitrary proof variant %j',
    (...proof) => {
      const captured = reduced();
      const observed = signed(undefined, proof);
      const before = [captured.toJson(), observed.toJson()];
      expect(() => assertCanonicalReducedErgo(captured)).not.toThrow();
      expect(compareReduced(captured, observed)).not.toThrow();
      expect([captured.toJson(), observed.toJson()]).toEqual(before);
    },
  );

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'leaves event/type application metadata to caller authorization'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare captured. Change only captured.eventId, captured.txType as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow()
   */

  it('leaves event/type application metadata to caller authorization', () => {
    const captured = reduced();
    captured.eventId = 'other-event';
    captured.txType = TransactionType.arbitrary;
    expect(compareReduced(captured, signed())).not.toThrow();
  });

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'rejects Signed bytes as Reduced without parser fallback'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare model. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow()
   */

  it('rejects Signed bytes as Reduced without parser fallback', () => {
    const model = signed();
    expect(() => assertCanonicalReducedErgo(model)).toThrow();
    expect(compareReduced(model, model)).toThrow();
  });

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'rejects Reduced bytes on the Signed side without parser fallback'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare model. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow()
   */

  it('rejects Reduced bytes on the Signed side without parser fallback', () => {
    const model = reduced();
    expect(compareReduced(model, model)).toThrow();
  });

  for (const side of ['reduced', 'signed'] as const) {
    const rejectReduced = (mutate: (model: ErgoTransaction) => void) => {
      const captured = reduced();
      const observed = signed();
      const model = side === 'reduced' ? captured : observed;
      mutate(model);
      expect(compareReduced(captured, observed)).toThrow();
      if (side === 'reduced')
        expect(() => assertCanonicalReducedErgo(model)).toThrow();
    };
    /**
     * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics `${side} rejects malformed model %s=%s`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it.each([
      ['network', 'avalanche'],
      ['txId', '00'.repeat(32)],
      ['txId', undefined],
      ['txBytes', Uint8Array.of(255)],
      ['txBytes', []],
      ['txBytes', undefined],
    ])(`${side} rejects malformed model %s=%s`, (field, value) => {
      rejectReduced((model) =>
        Object.assign(model, { [field as string]: value }),
      );
    });
    /**
     * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics `${side} rejects serialized suffix %s`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.txBytes as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it.each(['00', 'ff', '000102'])(
      `${side} rejects serialized suffix %s`,
      (suffix) => {
        rejectReduced((model) => {
          model.txBytes = Buffer.concat([
            model.txBytes,
            Buffer.from(suffix, 'hex'),
          ]);
        });
      },
    );
    for (const field of ['inputBoxes', 'dataInputs'] as const) {
      /**
       * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics `${side} rejects ${field} %s`
       * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
       * @scenario Prepare boxes, original, prototype. Change only model[field], boxes[0], delete boxes[0] as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
       * @expected The comparison helper refuses the named mutated model.
       */

      it.each([
        'missing',
        'shorter',
        'extra',
        'malformed',
        'plain bytes',
        'wrong ID',
        'suffix',
        'sparse',
        'inherited',
      ])(`${side} rejects ${field} %s`, (fault) => {
        rejectReduced((model) => {
          const boxes = model[field];
          if (fault === 'missing')
            model[field] = undefined as unknown as Uint8Array[];
          if (fault === 'shorter') boxes.pop();
          if (fault === 'extra') boxes.push(boxes[0]);
          if (fault === 'malformed') boxes[0] = Uint8Array.of(255);
          if (fault === 'plain bytes')
            boxes[0] = [...boxes[0]] as unknown as Uint8Array;
          if (fault === 'wrong ID') boxes[0] = model.inputBoxes[1];
          if (fault === 'suffix')
            boxes[0] = Buffer.concat([boxes[0], Uint8Array.of(0)]);
          if (fault === 'sparse' || fault === 'inherited') {
            const original = boxes[0];
            delete boxes[0];
            if (fault === 'inherited') {
              const prototype = Object.create(Object.getPrototypeOf(boxes));
              Object.defineProperty(prototype, '0', { value: original });
              Object.setPrototypeOf(boxes, prototype);
            }
          }
        });
      });
    }
    /**
     * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics `${side} rejects reordered complete input boxes`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side} rejects reordered complete input boxes`, () => {
      rejectReduced((model) => {
        model.inputBoxes.reverse();
      });
    });
    /**
     * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics `${side} rejects duplicate input boxes without changing count`
     * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
     * @scenario Prepare the complete model fixtures. Change only model.inputBoxes[1] as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
     * @expected The comparison helper refuses the named mutated model.
     */

    it(`${side} rejects duplicate input boxes without changing count`, () => {
      rejectReduced((model) => {
        model.inputBoxes[1] = model.inputBoxes[0];
      });
    });
  }

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'rejects a self-consistent Signed %s change against Reduced'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare changed, observed. Exercise the named valid, malformed or reordered fixture control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it.each(mutations)(
    'rejects a self-consistent Signed %s change against Reduced',
    (name, mutate) => {
      const changed = body();
      mutate(changed);
      const observed = signed(changed);
      if (name === 'input order') observed.inputBoxes.reverse();
      expect(compare(observed, observed)).not.toThrow();
      expect(compareReduced(reduced(), observed)).toThrow('semantics mismatch');
    },
  );

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'rejects a changed Signed %s ID with matching full auxiliary'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare changed, observed. Change only changed.inputs[0].boxId, changed.dataInputs[0].boxId, observed.inputBoxes[0], observed.dataInputs[0] as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it.each(['input', 'data input'])(
    'rejects a changed Signed %s ID with matching full auxiliary',
    (kind) => {
      const changed = body();
      if (kind === 'input')
        changed.inputs[0].boxId = changed.dataInputs[0].boxId;
      else changed.dataInputs[0].boxId = changed.inputs[0].boxId;
      const observed = signed(changed);
      if (kind === 'input') observed.inputBoxes[0] = observed.dataInputs[0];
      else observed.dataInputs[0] = observed.inputBoxes[0];
      expect(compare(observed, observed)).not.toThrow();
      expect(compareReduced(reduced(), observed)).toThrow('semantics mismatch');
    },
  );

  /**
   * @target assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics 'rejects a self-consistent changed Signed %s'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare changed, observed. Change only changed.outputs[0].assets[0].tokenId as selected by the named control. Invoke assertCanonicalReducedErgo / assertReducedToSignedErgoSemantics through the suite helper.
   * @expected toThrow(); toThrow('semantics mismatch')
   */

  it.each(['token ID', 'input count', 'data-input count', 'output count'])(
    'rejects a self-consistent changed Signed %s',
    (field) => {
      const changed = body();
      if (field === 'token ID')
        changed.outputs[0].assets[0].tokenId = 'ab'.repeat(32);
      if (field === 'input count') changed.inputs.pop();
      if (field === 'data-input count') changed.dataInputs.pop();
      if (field === 'output count') changed.outputs.pop();
      const observed = signed(changed);
      if (field === 'input count') observed.inputBoxes.pop();
      if (field === 'data-input count') observed.dataInputs.pop();
      expect(compare(observed, observed)).not.toThrow();
      expect(compareReduced(reduced(), observed)).toThrow('semantics mismatch');
    },
  );
});
describe('assertCanonicalReducedErgo', () => {
  /**
   * @target assertCanonicalReducedErgo 'frees every new Reduced WASM handle on %s'
   * @dependencies Real Ergo WASM codecs and complete Reduced/Signed transaction and auxiliary-box fixtures; arbitrary proofs.
   * @scenario Prepare model, freeReduced, freeUnsigned, freeId. Change only model.txBytes, model.txId, model.inputBoxes[0] as selected by the named control. Invoke assertCanonicalReducedErgo through the suite helper.
   * @expected toThrow(); toHaveBeenCalledTimes(1); toHaveBeenCalledTimes(fault === 'suffix' ? 0 : 1)
   */

  it.each(['valid', 'suffix', 'identity', 'auxiliary'])(
    'frees every new Reduced WASM handle on %s',
    (fault) => {
      const model = reduced();
      if (fault === 'suffix')
        model.txBytes = Buffer.concat([model.txBytes, Uint8Array.of(0)]);
      if (fault === 'identity') model.txId = '00'.repeat(32);
      if (fault === 'auxiliary') model.inputBoxes[0] = Uint8Array.of(255);
      const freeReduced = vi.spyOn(wasm.ReducedTransaction.prototype, 'free');
      const freeUnsigned = vi.spyOn(wasm.UnsignedTransaction.prototype, 'free');
      const freeId = vi.spyOn(wasm.TxId.prototype, 'free');
      try {
        if (fault === 'valid')
          expect(() => assertCanonicalReducedErgo(model)).not.toThrow();
        else expect(() => assertCanonicalReducedErgo(model)).toThrow();
        expect(freeReduced).toHaveBeenCalledTimes(1);
        expect(freeUnsigned).toHaveBeenCalledTimes(fault === 'suffix' ? 0 : 1);
        expect(freeId).toHaveBeenCalledTimes(fault === 'suffix' ? 0 : 1);
      } finally {
        freeReduced.mockRestore();
        freeUnsigned.mockRestore();
        freeId.mockRestore();
      }
    },
  );
});
