import { BLOCKHASH, GENESIS, SIGNATURE } from './testData';

/** Build the transaction result as source text to retain wide JSON integers. */
export const transactionResult = (
  edits: {
    readonly slot?: string;
    readonly signature?: string;
    readonly fee?: string;
    readonly version?: string;
    readonly meta?: string;
    readonly transactionIndex?: string;
  } = {},
) => {
  const meta =
    edits.meta ?? `{"fee":${edits.fee ?? '18446744073709551615'},"err":null}`;
  const transactionIndex =
    edits.transactionIndex === undefined
      ? ''
      : `,"transactionIndex":${edits.transactionIndex}`;
  return `{"slot":${edits.slot ?? '42'}${transactionIndex},"transaction":{"signatures":["${edits.signature ?? SIGNATURE}"],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":${meta},"version":${edits.version ?? '"legacy"'}}`;
};

/** Return a successful JSON-RPC response without parsing its result text. */
export const rpcResponse = (id: number, result: string) =>
  `{"jsonrpc":"2.0","id":${id},"result":${result}}`;

/** Build the full containing block with the same transaction and metadata. */
export const blockResult = (
  overrides: {
    readonly blockhash?: string;
    readonly blockHeight?: string;
    readonly signature?: string;
    readonly fee?: string;
    readonly copies?: number;
    readonly version?: string;
    readonly meta?: string;
    readonly prefixSignatures?: readonly string[];
    readonly includeTransactions?: boolean;
    readonly extraFields?: string;
  } = {},
) => {
  const signature = overrides.signature ?? SIGNATURE;
  const fee = overrides.fee ?? '18446744073709551615';
  const count = overrides.copies ?? 1;
  const meta = overrides.meta ?? `{"fee":${fee},"err":null}`;
  const version = overrides.version ?? '"legacy"';
  /** Build one block entry for the supplied first signature. */
  const entry = (entrySignature: string) =>
    `{"transaction":{"signatures":["${entrySignature}"],"message":{"accountKeys":["payer"],"instructions":[]}},"meta":${meta},"version":${version}}`;
  const entries = [
    ...(overrides.prefixSignatures ?? []).map(entry),
    ...Array.from({ length: count }, () => entry(signature)),
  ];
  const transactions =
    overrides.includeTransactions === false
      ? ''
      : `,"transactions":[${entries.join(',')}]`;
  return `{"blockhash":"${overrides.blockhash ?? BLOCKHASH}","blockHeight":${overrides.blockHeight ?? '37'}${transactions}${overrides.extraFields ? `,${overrides.extraFields}` : ''}}`;
};

/** Produce the three regular RPC replies for the standard fixture. */
export const defaultReplies = () => [
  rpcResponse(1, JSON.stringify(GENESIS)),
  rpcResponse(2, transactionResult()),
  rpcResponse(3, blockResult()),
];
