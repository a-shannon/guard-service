/** The finalized slot used by the standard read-session fixture. */
export const SLOT = 42;

/** The block height paired with the standard read-session fixture. */
export const BLOCK_HEIGHT = 37;

/** The parent hash paired with the standard read-session fixture. */
export const PARENT_HASH = 'parent-blockhash';

/** A second signature used to prove sessions keep independent transaction joins. */
export const SECOND_SIGNATURE = 'second-request-signature';

/** Full finalized block fixtures for invalid first-signature session cases. */
export const INVALID_SESSION_SIGNATURE_BLOCKS = [
  {
    name: 'missing',
    result:
      '{"blockhash":"request-blockhash","blockHeight":37,"transactions":[{"transaction":{"signatures":[]},"meta":{"fee":1,"err":null},"version":"legacy"}],"previousBlockhash":"parent-blockhash","parentSlot":41}',
  },
  {
    name: 'empty',
    result:
      '{"blockhash":"request-blockhash","blockHeight":37,"transactions":[{"transaction":{"signatures":[""]},"meta":{"fee":1,"err":null},"version":"legacy"}],"previousBlockhash":"parent-blockhash","parentSlot":41}',
  },
  {
    name: 'non-string',
    result:
      '{"blockhash":"request-blockhash","blockHeight":37,"transactions":[{"transaction":{"signatures":[7]},"meta":{"fee":1,"err":null},"version":"legacy"}],"previousBlockhash":"parent-blockhash","parentSlot":41}',
  },
] as const;
