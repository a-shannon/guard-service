/** Official-shaped getSignatureStatuses results used by offline provider tests. */
export const validSignatureStatusResult = {
  context: { slot: 100 },
  value: [
    {
      slot: 98,
      confirmations: 3,
      confirmationStatus: 'confirmed',
      err: null,
    },
  ],
};

/** An official-shaped response for a signature absent from the status cache. */
export const missingSignatureStatusResult = {
  context: { slot: 100 },
  value: [null],
};

/** An official-shaped response for a transaction that failed on chain. */
export const failedSignatureStatusResult = {
  context: { slot: 100 },
  value: [
    {
      slot: 98,
      confirmations: null,
      confirmationStatus: 'finalized',
      err: { InstructionError: [0, 'Custom'] },
    },
  ],
};
