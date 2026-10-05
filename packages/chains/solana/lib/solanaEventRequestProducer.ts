import type {
  SolanaEventContext,
  SolanaEventTransaction,
} from './requestBoundEventContext';

const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const TX_OPTIONS = Object.freeze({
  commitment: 'finalized',
  encoding: 'json',
  maxSupportedTransactionVersion: 0,
});
const BLOCK_OPTIONS = Object.freeze({
  commitment: 'finalized',
  encoding: 'json',
  transactionDetails: 'full',
  rewards: true,
  maxSupportedTransactionVersion: 0,
});
const RESERVED_FIELDS = new Set([
  'clusterGenesisHash',
  'destinationNetwork',
  'commitment',
  'blockhash',
  'history',
]);

/** One JSON-RPC request sent through the caller-owned transport. */
export interface SolanaRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** Consistency coordinates returned alongside extractor history text. */
export interface SolanaHistoryRequestContext {
  readonly signature: string;
  readonly slot: number;
  readonly blockhash: string;
  readonly blockHeight: number;
  readonly transactionIndex: number;
  readonly genesis: string;
}

/** Configure the captured extractor context and exact-text RPC/history inputs. */
export interface SolanaEventRequestProducerOptions {
  readonly context: SolanaEventContext;
  readonly transport: (request: SolanaRpcRequest) => Promise<string>;
  readonly getHistory?: (expected: Readonly<SolanaHistoryRequestContext>) =>
    | {
        readonly requestContext: SolanaHistoryRequestContext;
        readonly extractorHistory: string;
      }
    | undefined
    | Promise<
        | {
            readonly requestContext: SolanaHistoryRequestContext;
            readonly extractorHistory: string;
          }
        | undefined
      >;
}

/** Candidate coordinates from the configured block locator, not a finality proof. */
export interface SolanaEventBlockLocation {
  readonly genesisHash: string;
  readonly blockhash: string;
  readonly slot: number;
  readonly blockHeight: number;
  readonly parentHash: string;
}

/** Supply a locator without coupling the event reader to a database or provider. */
export interface SolanaEventReadSessionOptions
  extends SolanaEventRequestProducerOptions {
  readonly locateBlock: (
    blockhash: string,
  ) =>
    | SolanaEventBlockLocation
    | undefined
    | Promise<SolanaEventBlockLocation | undefined>;
}

interface BaseNode {
  readonly start: number;
  readonly end: number;
}
interface ObjectNode extends BaseNode {
  readonly kind: 'object';
  readonly members: ReadonlyMap<string, JsonNode>;
  readonly interiorStart: number;
  readonly interiorEnd: number;
}
interface ArrayNode extends BaseNode {
  readonly kind: 'array';
  readonly items: readonly JsonNode[];
}
interface StringNode extends BaseNode {
  readonly kind: 'string';
  readonly value: string;
}
interface NumberNode extends BaseNode {
  readonly kind: 'number';
  readonly lexeme: string;
}
interface AtomNode extends BaseNode {
  readonly kind: 'atom';
  readonly value: boolean | null;
}
type JsonNode = ObjectNode | ArrayNode | StringNode | NumberNode | AtomNode;

/** Throw a parser error with the supplied stable failure code. */
const failJson = (reason = 'SOLANA_RPC_INVALID_JSON'): never => {
  throw new Error(reason);
};

/** Parse bounded JSON while preserving raw slices and number spellings. */
const parseJson = (source: string): JsonNode => {
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES)
    throw new Error('SOLANA_RPC_RESPONSE_TOO_LARGE');
  let index = 0;
  let count = 0;
  /** Skip JSON whitespace at the active source cursor. */
  const whitespace = () => {
    while (' \t\r\n'.includes(source[index] ?? '\0')) index++;
  };
  /** Read one quoted token while retaining its source bounds. */
  const parseString = (): StringNode => {
    const start = index;
    if (source[index++] !== '"') return failJson();
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') {
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, index));
        } catch {
          return failJson();
        }
        if (typeof value !== 'string') return failJson();
        return { kind: 'string', start, end: index, value };
      }
      if (char === '\\') {
        const escaped = source[index++];
        if (escaped === 'u') {
          if (!/^[\da-fA-F]{4}$/.test(source.slice(index, index + 4)))
            return failJson();
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped ?? '')) return failJson();
      } else if (char.charCodeAt(0) < 0x20) return failJson();
    }
    return failJson();
  };
  /** Parse one bounded JSON value and retain exact object interiors. */
  const parseValue = (depth: number): JsonNode => {
    whitespace();
    count++;
    if (count > MAX_NODES) return failJson('SOLANA_RPC_NODE_LIMIT');
    if (depth > MAX_DEPTH) return failJson('SOLANA_RPC_DEPTH_LIMIT');
    const start = index;
    const token = source[index];
    if (token === '{') {
      index++;
      whitespace();
      const members = new Map<string, JsonNode>();
      if (source[index] === '}') {
        index++;
        return {
          kind: 'object',
          start,
          end: index,
          interiorStart: start + 1,
          interiorEnd: index - 1,
          members,
        };
      }
      while (true) {
        whitespace();
        const key = parseString().value;
        if (members.has(key)) return failJson('SOLANA_RPC_DUPLICATE_JSON_KEY');
        whitespace();
        if (source[index++] !== ':') return failJson();
        members.set(key, parseValue(depth + 1));
        whitespace();
        const delimiter = source[index++];
        if (delimiter === '}')
          return {
            kind: 'object',
            start,
            end: index,
            interiorStart: start + 1,
            interiorEnd: index - 1,
            members,
          };
        if (delimiter !== ',') return failJson();
      }
    }
    if (token === '[') {
      index++;
      whitespace();
      const items: JsonNode[] = [];
      if (source[index] === ']') {
        index++;
        return { kind: 'array', start, end: index, items };
      }
      while (true) {
        items.push(parseValue(depth + 1));
        whitespace();
        const delimiter = source[index++];
        if (delimiter === ']')
          return { kind: 'array', start, end: index, items };
        if (delimiter !== ',') return failJson();
      }
    }
    if (token === '"') return parseString();
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(index),
    );
    if (number) {
      index += number[0].length;
      return { kind: 'number', start, end: index, lexeme: number[0] };
    }
    for (const [text, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(text, index)) {
        index += text.length;
        return { kind: 'atom', start, end: index, value };
      }
    }
    return failJson();
  };
  const root = parseValue(0);
  whitespace();
  if (index !== source.length) return failJson();
  return root;
};

/** Read one object member without coercing other JSON node types. */
const member = (node: JsonNode | undefined, key: string) =>
  node?.kind === 'object' ? node.members.get(key) : undefined;
/** Return a decoded string only for an actual JSON string node. */
const stringValue = (node: JsonNode | undefined) =>
  node?.kind === 'string' ? node.value : undefined;
/** Read a non-negative safe integer from its preserved decimal token. */
const integerValue = (node: JsonNode | undefined, field: string): number => {
  if (node?.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(node.lexeme))
    throw new Error(`SOLANA_RPC_INVALID_${field.toUpperCase()}`);
  const value = BigInt(node.lexeme);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`SOLANA_RPC_UNSAFE_${field.toUpperCase()}`);
  return Number(value);
};
/** Compare parsed values while preserving number-token distinctions. */
const equal = (
  left: JsonNode | undefined,
  right: JsonNode | undefined,
): boolean => {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'object' && right.kind === 'object')
    return (
      left.members.size === right.members.size &&
      [...left.members].every(([key, value]) =>
        equal(value, right.members.get(key)),
      )
    );
  if (left.kind === 'array' && right.kind === 'array')
    return (
      left.items.length === right.items.length &&
      left.items.every((value, i) => equal(value, right.items[i]))
    );
  if (left.kind === 'string' && right.kind === 'string')
    return left.value === right.value;
  if (left.kind === 'number' && right.kind === 'number')
    return left.lexeme === right.lexeme;
  return (
    left.kind === 'atom' && right.kind === 'atom' && left.value === right.value
  );
};

/** Validate a successful response envelope and return its exact parsed result. */
const response = (
  raw: string,
  expectedId: number,
): { raw: string; result: JsonNode } => {
  const root = parseJson(raw);
  if (root.kind !== 'object') throw new Error('SOLANA_RPC_INVALID_ENVELOPE');
  const id = member(root, 'id');
  if (id?.kind !== 'number' || id.lexeme !== String(expectedId))
    throw new Error('SOLANA_RPC_ID_MISMATCH');
  if (stringValue(member(root, 'jsonrpc')) !== '2.0')
    throw new Error('SOLANA_RPC_VERSION_MISMATCH');
  if (root.members.has('error')) throw new Error('SOLANA_RPC_ERROR_RESPONSE');
  const result = member(root, 'result');
  if (
    !result ||
    [...root.members.keys()].sort().join(',') !== 'id,jsonrpc,result'
  )
    throw new Error('SOLANA_RPC_INVALID_ENVELOPE');
  return { raw, result };
};
/** Require an object node and report the caller's field-specific failure. */
const object = (node: JsonNode | undefined, reason: string): ObjectNode => {
  if (node?.kind !== 'object') throw new Error(reason);
  return node;
};
/** Read the first signature in a transaction object when present. */
const firstSignature = (node: JsonNode | undefined) => {
  const signatures = member(node, 'signatures');
  return signatures?.kind === 'array'
    ? stringValue(signatures.items[0])
    : undefined;
};
/** Compare history coordinates without claiming that the port authenticates them. */
const historyEquals = (
  actual: SolanaHistoryRequestContext,
  expected: SolanaHistoryRequestContext,
) =>
  actual.signature === expected.signature &&
  actual.slot === expected.slot &&
  actual.blockhash === expected.blockhash &&
  actual.blockHeight === expected.blockHeight &&
  actual.transactionIndex === expected.transactionIndex &&
  actual.genesis === expected.genesis;

/** Allocate correlated immutable requests for one producer or read session. */
const createRpcCaller = (
  transport: SolanaEventRequestProducerOptions['transport'],
) => {
  let nextId = 0;
  /** Send one immutable JSON-RPC request and validate its matching response. */
  const call = async (method: string, params: readonly unknown[]) => {
    if (nextId >= Number.MAX_SAFE_INTEGER)
      throw new Error('SOLANA_RPC_REQUEST_ID_EXHAUSTED');
    const id = ++nextId;
    const request: SolanaRpcRequest = Object.freeze({
      jsonrpc: '2.0',
      id,
      method,
      params: Object.freeze([...params]),
    });
    return response(await transport(request), id);
  };
  return call;
};

/** Build carriers using fresh block reads or a private session-owned snapshot. */
const createRequestProducer = (
  options: SolanaEventRequestProducerOptions,
  call = createRpcCaller(options.transport),
  capturedBlock?: {
    readonly slot: number;
    readonly response: ReturnType<typeof response>;
  },
) => {
  const context = options.context;
  const getHistory = options.getHistory;
  const profile = context.resolvedProfile;
  return Object.freeze({
    /** Build one immutable carrier after independent transaction and block reads agree. */
    getTransaction: async (
      signature: string,
      containingBlockhash: string,
    ): Promise<SolanaEventTransaction> => {
      try {
        if (
          typeof signature !== 'string' ||
          signature.length === 0 ||
          typeof containingBlockhash !== 'string' ||
          containingBlockhash.length === 0
        )
          throw new Error('SOLANA_REQUEST_IDENTITY_MISSING');
        const genesisResponse = await call('getGenesisHash', []);
        const genesis = stringValue(genesisResponse.result);
        if (genesis === undefined)
          throw new Error('SOLANA_RPC_GENESIS_MISSING');
        if (genesis !== profile.genesisHash)
          throw new Error('SOLANA_RPC_GENESIS_MISMATCH');
        const txResponse = await call('getTransaction', [
          signature,
          TX_OPTIONS,
        ]);
        const tx = object(txResponse.result, 'SOLANA_RPC_INVALID_TRANSACTION');
        const slot = integerValue(member(tx, 'slot'), 'slot');
        if (capturedBlock && slot !== capturedBlock.slot)
          throw new Error('SOLANA_SESSION_TRANSACTION_SLOT_MISMATCH');
        const transaction = object(
          member(tx, 'transaction'),
          'SOLANA_RPC_INVALID_TRANSACTION',
        );
        const meta = member(tx, 'meta');
        if (
          meta?.kind !== 'object' &&
          !(meta?.kind === 'atom' && meta.value === null)
        )
          throw new Error('SOLANA_RPC_INVALID_META');
        const version = member(tx, 'version');
        if (
          !(
            stringValue(version) === 'legacy' ||
            (version?.kind === 'number' && version.lexeme === '0')
          )
        )
          throw new Error('SOLANA_RPC_UNSUPPORTED_VERSION');
        if (firstSignature(transaction) !== signature)
          throw new Error('SOLANA_RPC_TRANSACTION_SIGNATURE_MISMATCH');

        const blockResponse =
          capturedBlock?.response ??
          (await call('getBlock', [slot, BLOCK_OPTIONS]));
        const block = object(blockResponse.result, 'SOLANA_RPC_INVALID_BLOCK');
        const blockhash = stringValue(member(block, 'blockhash'));
        if (blockhash !== containingBlockhash)
          throw new Error('SOLANA_RPC_CONTAINING_BLOCKHASH_MISMATCH');
        const blockHeight = integerValue(
          member(block, 'blockHeight'),
          'blockHeight',
        );
        const entries = member(block, 'transactions');
        if (entries?.kind !== 'array')
          throw new Error('SOLANA_RPC_BLOCK_TRANSACTIONS_MISSING');
        const matches = entries.items
          .map((entry, transactionIndex) => ({ entry, transactionIndex }))
          .filter(
            ({ entry }) =>
              firstSignature(member(entry, 'transaction')) === signature,
          );
        if (matches.length !== 1)
          throw new Error('SOLANA_RPC_BLOCK_MEMBERSHIP_CARDINALITY');
        const { entry, transactionIndex } = matches[0];
        const txIndex = member(tx, 'transactionIndex');
        if (
          txIndex &&
          integerValue(txIndex, 'transactionIndex') !== transactionIndex
        )
          throw new Error('SOLANA_RPC_TRANSACTION_INDEX_MISMATCH');
        if (
          !equal(member(tx, 'transaction'), member(entry, 'transaction')) ||
          !equal(meta, member(entry, 'meta')) ||
          !equal(version, member(entry, 'version'))
        )
          throw new Error('SOLANA_RPC_READS_DISAGREE');
        if (
          member(entry, 'meta')?.kind !== 'object' &&
          !(
            member(entry, 'meta')?.kind === 'atom' &&
            (member(entry, 'meta') as AtomNode).value === null
          )
        )
          throw new Error('SOLANA_RPC_INVALID_META');
        for (const field of RESERVED_FIELDS)
          if (tx.members.has(field))
            throw new Error(`SOLANA_RPC_RESERVED_FIELD:${field}`);

        let historyRaw: string | undefined;
        if (getHistory) {
          const expected = Object.freeze({
            signature,
            slot,
            blockhash,
            blockHeight,
            transactionIndex,
            genesis,
          });
          const history = await getHistory(expected);
          if (history !== undefined) {
            const returnedContext = history.requestContext;
            const extractorHistory = history.extractorHistory;
            const coordinates = returnedContext && {
              signature: returnedContext.signature,
              slot: returnedContext.slot,
              blockhash: returnedContext.blockhash,
              blockHeight: returnedContext.blockHeight,
              transactionIndex: returnedContext.transactionIndex,
              genesis: returnedContext.genesis,
            };
            if (
              !coordinates ||
              typeof extractorHistory !== 'string' ||
              !historyEquals(coordinates, expected)
            )
              throw new Error('SOLANA_RPC_HISTORY_CONTEXT_MISMATCH');
            const historyNode = parseJson(extractorHistory);
            if (historyNode.kind !== 'object')
              throw new Error('SOLANA_RPC_INVALID_HISTORY');
            historyRaw = extractorHistory;
          }
        }
        const added = [
          `"clusterGenesisHash":${JSON.stringify(genesis)}`,
          `"destinationNetwork":${JSON.stringify(profile.destinationNetwork)}`,
          '"commitment":"finalized"',
          `"blockhash":${JSON.stringify(blockhash)}`,
          ...(historyRaw === undefined ? [] : [`"history":${historyRaw}`]),
        ];
        const extractorInput = `{${txResponse.raw.slice(tx.interiorStart, tx.interiorEnd)},${added.join(',')}}`;
        return context.bindRequest({
          extractorInput,
          requestedTxId: signature,
          requestedBlockhash: containingBlockhash,
          observedSlot: slot,
          rosenBlockHeight: blockHeight,
        });
      } catch (error) {
        throw new Error('SOLANA_REQUEST_UNAVAILABLE', { cause: error });
      }
    },
  });
};

/** Join finalized RPC observations to the captured request-bound extractor context. */
export const createSolanaEventRequestProducer = (
  options: SolanaEventRequestProducerOptions,
) => createRequestProducer(options);

/** Validate one located block and retain it for one event's three network reads. */
export const createSolanaEventReadSession = async (
  options: SolanaEventReadSessionOptions,
  requestedBlockhash: string,
) => {
  try {
    const context = options.context;
    const transport = options.transport;
    const getHistory = options.getHistory;
    const locateBlock = options.locateBlock;
    const profile = context.resolvedProfile;
    if (
      typeof requestedBlockhash !== 'string' ||
      requestedBlockhash.length === 0
    )
      throw new Error('SOLANA_REQUEST_IDENTITY_MISSING');
    const located = await locateBlock(requestedBlockhash);
    if (!located || typeof located !== 'object' || Array.isArray(located))
      throw new Error('SOLANA_SESSION_BLOCK_LOCATION_MISSING');
    const location = Object.freeze({
      genesisHash: located.genesisHash,
      blockhash: located.blockhash,
      slot: located.slot,
      blockHeight: located.blockHeight,
      parentHash: located.parentHash,
    });
    for (const field of ['genesisHash', 'blockhash', 'parentHash'] as const)
      if (typeof location[field] !== 'string' || location[field].length === 0)
        throw new Error(`SOLANA_SESSION_INVALID_LOCATION:${field}`);
    for (const field of ['slot', 'blockHeight'] as const)
      if (!Number.isSafeInteger(location[field]) || location[field] < 0)
        throw new Error(`SOLANA_SESSION_INVALID_LOCATION:${field}`);
    if (location.slot === 0)
      throw new Error('SOLANA_SESSION_GENESIS_SLOT_UNSUPPORTED');
    if (location.blockhash !== requestedBlockhash)
      throw new Error('SOLANA_SESSION_LOCATION_HASH_MISMATCH');
    if (location.genesisHash !== profile.genesisHash)
      throw new Error('SOLANA_SESSION_LOCATION_GENESIS_MISMATCH');
    const call = createRpcCaller(transport);
    const genesis = stringValue((await call('getGenesisHash', [])).result);
    if (genesis !== profile.genesisHash)
      throw new Error('SOLANA_RPC_GENESIS_MISMATCH');
    const blockResponse = await call('getBlock', [
      location.slot,
      BLOCK_OPTIONS,
    ]);
    const block = object(blockResponse.result, 'SOLANA_RPC_INVALID_BLOCK');
    if (stringValue(member(block, 'blockhash')) !== location.blockhash)
      throw new Error('SOLANA_RPC_CONTAINING_BLOCKHASH_MISMATCH');
    const height = integerValue(member(block, 'blockHeight'), 'blockHeight');
    if (height !== location.blockHeight)
      throw new Error('SOLANA_SESSION_BLOCK_HEIGHT_MISMATCH');
    if (stringValue(member(block, 'previousBlockhash')) !== location.parentHash)
      throw new Error('SOLANA_SESSION_PARENT_HASH_MISMATCH');
    const parentSlot = integerValue(member(block, 'parentSlot'), 'parentSlot');
    if (parentSlot >= location.slot)
      throw new Error('SOLANA_SESSION_PARENT_SLOT_ORDER');
    const entries = member(block, 'transactions');
    if (entries?.kind !== 'array')
      throw new Error('SOLANA_RPC_BLOCK_TRANSACTIONS_MISSING');
    const signatures = entries.items.map((entry) => {
      const signature = firstSignature(member(entry, 'transaction'));
      if (signature === undefined || signature.length === 0)
        throw new Error('SOLANA_SESSION_BLOCK_SIGNATURE_MISSING');
      return signature;
    });
    if (new Set(signatures).size !== signatures.length)
      throw new Error('SOLANA_SESSION_DUPLICATE_SIGNATURE');
    const producer = createRequestProducer(
      { context, transport, getHistory },
      call,
      { slot: location.slot, response: blockResponse },
    );
    /** Refuse another block before issuing any additional RPC request. */
    const requireBlock = (blockhash: string) => {
      if (blockhash !== location.blockhash)
        throw new Error('SOLANA_REQUEST_UNAVAILABLE', {
          cause: new Error('SOLANA_SESSION_FOREIGN_BLOCK'),
        });
    };
    return Object.freeze({
      /** Return an independent copy of the captured block's transaction IDs. */
      getBlockTransactionIds: async (blockhash: string): Promise<string[]> => {
        requireBlock(blockhash);
        return [...signatures];
      },
      /** Return the same validated hash, parent and height for every session read. */
      getBlockInfo: async (blockhash: string) => {
        requireBlock(blockhash);
        return Object.freeze({
          hash: location.blockhash,
          parentHash: location.parentHash,
          height: location.blockHeight,
        });
      },
      /** Bind a fresh transaction observation to this session's captured block. */
      getTransaction: async (signature: string, blockhash: string) => {
        requireBlock(blockhash);
        return producer.getTransaction(signature, blockhash);
      },
    });
  } catch (error) {
    throw new Error('SOLANA_REQUEST_UNAVAILABLE', { cause: error });
  }
};
