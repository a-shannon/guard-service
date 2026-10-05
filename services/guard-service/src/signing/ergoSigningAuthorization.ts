import type { SigningAuthorizationConfig } from '@rosen-bridge/ergo-multi-sig';

import type { GuardSigningRuntime } from './signingRuntime';

/** Joins the locally captured transaction to the multisig's immutable attempt. */
export const createErgoSigningAuthorization = (
  runtime: Pick<GuardSigningRuntime, 'context' | 'ergo'>,
): SigningAuthorizationConfig => ({
  ...runtime.ergo,
  /** Checks the multisig identity against the current captured Ergo transaction and prepares authority. */
  bind: async (identity) => {
    const bound = runtime.context.current();
    const model = JSON.parse(bound.unsignedJson);
    if (
      model.network !== 'ergo' ||
      model.txId !== identity.txId ||
      model.txBytes !== identity.reducedTxBytes ||
      bound.requiredSign !== identity.requiredSign ||
      JSON.stringify(model.inputBoxes) !==
        JSON.stringify(identity.inputBoxBytes) ||
      JSON.stringify(model.dataInputs) !==
        JSON.stringify(identity.dataInputBoxBytes)
    )
      throw new Error('Ergo signing identity does not match local transaction');
    const prepared = await bound.prepareSigningAuthorization();
    return Object.freeze({
      bindingId: prepared.bindingId,
      /** Delegates the multisig phase to the prepared local signing authority. */
      withAction: async <T>(
        phase: Parameters<typeof prepared.withAction>[0],
        action: () => T | Promise<T>,
      ): Promise<T> => prepared.withAction(phase, action),
    });
  },
});
