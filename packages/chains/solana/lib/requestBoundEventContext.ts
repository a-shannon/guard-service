import { SOLANA_PROJECTOR_VERSION } from '@rosen-bridge/rosen-extractor';
import type {
  SolanaRosenExtractionOutcome,
  SolanaResolvedProfile,
  SolanaRosenExtractor,
} from '@rosen-bridge/rosen-extractor';

const MAX_INPUT_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

interface JsonObjectNode {
  readonly kind: 'object';
  readonly members: ReadonlyMap<string, JsonNode>;
}

interface JsonArrayNode {
  readonly kind: 'array';
  readonly items: readonly JsonNode[];
}

interface JsonStringNode {
  readonly kind: 'string';
  readonly value: string;
}

interface JsonNumberNode {
  readonly kind: 'number';
  readonly lexeme: string;
}

interface JsonAtomNode {
  readonly kind: 'atom';
  readonly value: boolean | null;
}

type JsonNode =
  | JsonObjectNode
  | JsonArrayNode
  | JsonStringNode
  | JsonNumberNode
  | JsonAtomNode;

/** The transaction request coordinates already chosen by its caller. */
export interface SolanaEventRequest {
  readonly extractorInput: string;
  readonly requestedTxId: string;
  readonly requestedBlockhash: string;
  readonly observedSlot: number;
  readonly rosenBlockHeight: number;
}

/** An immutable, factory-issued transaction bound to one Guard request. */
export interface SolanaEventTransaction extends SolanaEventRequest {
  readonly observedSignature: string;
  readonly resolvedProfile: SolanaResolvedProfile;
}

/** The Guard block fields required by the request-bound event hook. */
export interface SolanaEventBlockInfo {
  readonly hash: string;
  readonly height: number;
}

/** Request-local methods and the exact extractor profile captured at creation. */
export interface SolanaEventContext {
  readonly extractor: SolanaRosenExtractor;
  readonly resolvedProfile: SolanaResolvedProfile;
  readonly bindRequest: (request: SolanaEventRequest) => SolanaEventTransaction;
  readonly serializeTx: (transaction: unknown) => string;
  readonly verifyLockTransactionExtraConditions: (
    transaction: unknown,
    blockInfo: SolanaEventBlockInfo,
  ) => Promise<boolean>;
}

/** Throw the shared malformed-input error from the bounded JSON parser. */
const invalidJson = (): never => {
  throw new Error('SOLANA_REQUEST_INVALID_JSON');
};

/** Parse bounded JSON while retaining integer lexemes and rejecting duplicate keys. */
const parseLosslessJson = (source: string): JsonNode => {
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES)
    throw new Error('SOLANA_REQUEST_INPUT_TOO_LARGE');

  let index = 0;
  let nodeCount = 0;
  /** Advance past JSON whitespace without allocating a normalized copy. */
  const whitespace = () => {
    while (
      source[index] === ' ' ||
      source[index] === '\t' ||
      source[index] === '\n' ||
      source[index] === '\r'
    )
      index++;
  };
  /** Enforce both recursion-depth and total-node limits. */
  const countNode = (depth: number) => {
    nodeCount++;
    if (nodeCount > MAX_JSON_NODES)
      throw new Error('SOLANA_REQUEST_JSON_NODE_LIMIT');
    if (depth > MAX_JSON_DEPTH)
      throw new Error('SOLANA_REQUEST_JSON_DEPTH_LIMIT');
  };
  /** Read and decode one JSON string token. */
  const readString = (): JsonStringNode => {
    const start = index;
    if (source[index++] !== '"') return invalidJson();
    while (index < source.length) {
      const character = source[index++];
      if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, index));
        } catch {
          return invalidJson();
        }
        if (typeof value !== 'string') return invalidJson();
        return { kind: 'string', value };
      }
      if (character === '\\') {
        const escaped = source[index++];
        if (escaped === 'u') {
          const hex = source.slice(index, index + 4);
          if (!/^[\da-fA-F]{4}$/.test(hex)) return invalidJson();
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped ?? '')) return invalidJson();
      } else if (character.charCodeAt(0) < 0x20) return invalidJson();
    }
    return invalidJson();
  };
  /** Read one JSON number and preserve its original decimal spelling. */
  const parseNumber = (): JsonNumberNode => {
    const start = index;
    if (source[index] === '-') index++;
    if (source[index] === '0') {
      index++;
      if (/[0-9]/.test(source[index] ?? '')) return invalidJson();
    } else {
      if (!/[1-9]/.test(source[index] ?? '')) return invalidJson();
      while (/[0-9]/.test(source[index] ?? '')) index++;
    }
    if (source[index] === '.') {
      index++;
      if (!/[0-9]/.test(source[index] ?? '')) return invalidJson();
      while (/[0-9]/.test(source[index] ?? '')) index++;
    }
    if (source[index] === 'e' || source[index] === 'E') {
      index++;
      if (source[index] === '+' || source[index] === '-') index++;
      if (!/[0-9]/.test(source[index] ?? '')) return invalidJson();
      while (/[0-9]/.test(source[index] ?? '')) index++;
    }
    return { kind: 'number', lexeme: source.slice(start, index) };
  };
  /** Parse one value recursively while enforcing the fixed structural limits. */
  const parseValue = (depth: number): JsonNode => {
    whitespace();
    countNode(depth);
    const token = source[index];
    if (token === '{') {
      index++;
      whitespace();
      const members = new Map<string, JsonNode>();
      if (source[index] === '}') {
        index++;
        return { kind: 'object', members };
      }
      while (true) {
        whitespace();
        const key = readString().value;
        if (members.has(key))
          throw new Error('SOLANA_REQUEST_DUPLICATE_JSON_KEY');
        whitespace();
        if (source[index++] !== ':') return invalidJson();
        members.set(key, parseValue(depth + 1));
        whitespace();
        const separator = source[index++];
        if (separator === '}') return { kind: 'object', members };
        if (separator !== ',') return invalidJson();
      }
    }
    if (token === '[') {
      index++;
      whitespace();
      const items: JsonNode[] = [];
      if (source[index] === ']') {
        index++;
        return { kind: 'array', items };
      }
      while (true) {
        items.push(parseValue(depth + 1));
        whitespace();
        const separator = source[index++];
        if (separator === ']') return { kind: 'array', items };
        if (separator !== ',') return invalidJson();
      }
    }
    if (token === '"') return readString();
    if (token === '-' || /[0-9]/.test(token ?? '')) return parseNumber();
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return { kind: 'atom', value };
      }
    }
    return invalidJson();
  };

  const root = parseValue(0);
  whitespace();
  if (index !== source.length) return invalidJson();
  return root;
};

/** Return an object member without coercing another JSON node kind. */
const member = (node: JsonNode | undefined, key: string) =>
  node?.kind === 'object' ? node.members.get(key) : undefined;

/** Require an object node and preserve the caller-selected error reason. */
const objectValue = (node: JsonNode | undefined, reason: string) => {
  if (node?.kind !== 'object') throw new Error(reason);
  return node;
};

/** Require a non-empty string node. */
const stringValue = (node: JsonNode | undefined, reason: string) => {
  if (node?.kind !== 'string' || node.value.length === 0)
    throw new Error(reason);
  return node.value;
};

/** Require a non-negative safe integer while parsing its exact token. */
const integerValue = (node: JsonNode | undefined, reason: string) => {
  if (node?.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(node.lexeme))
    throw new Error(reason);
  const value = BigInt(node.lexeme);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('SOLANA_REQUEST_UNSAFE_SLOT');
  return value;
};

/** Check the descriptor and every reachable object value for immutability. */
const isDeeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  /** Check one child value using the active cycle set. */
  const childIsFrozen = (entry: unknown) => isDeeplyFrozen(entry, seen);
  return Object.values(value).every(childIsFrozen);
};

/** Capture the production extractor's frozen, versioned network descriptor. */
const captureResolvedProfile = (extractor: SolanaRosenExtractor) => {
  const profile = extractor.getResolvedProfile();
  if (!isDeeplyFrozen(profile))
    throw new Error('SOLANA_RESOLVED_PROFILE_NOT_IMMUTABLE');
  if (profile.projectorVersion !== SOLANA_PROJECTOR_VERSION)
    throw new Error('SOLANA_PROJECTOR_VERSION_MISMATCH');
  if (
    typeof profile.genesisHash !== 'string' ||
    profile.genesisHash.length === 0 ||
    typeof profile.destinationNetwork !== 'string' ||
    profile.destinationNetwork.length === 0
  )
    throw new Error('SOLANA_RESOLVED_PROFILE_INVALID');
  return profile;
};

/** Read caller coordinates once so later mutation cannot alter this binding. */
const snapshotRequest = (request: SolanaEventRequest): SolanaEventRequest => {
  const snapshot = {
    extractorInput: request.extractorInput,
    requestedTxId: request.requestedTxId,
    requestedBlockhash: request.requestedBlockhash,
    observedSlot: request.observedSlot,
    rosenBlockHeight: request.rosenBlockHeight,
  };
  if (
    typeof snapshot.requestedTxId !== 'string' ||
    snapshot.requestedTxId.length === 0 ||
    typeof snapshot.requestedBlockhash !== 'string' ||
    snapshot.requestedBlockhash.length === 0
  )
    throw new Error('SOLANA_REQUEST_IDENTITY_MISSING');
  if (
    !Number.isSafeInteger(snapshot.observedSlot) ||
    snapshot.observedSlot < 0 ||
    !Number.isSafeInteger(snapshot.rosenBlockHeight) ||
    snapshot.rosenBlockHeight < 0
  )
    throw new Error('SOLANA_REQUEST_INVALID_COORDINATE');
  if (typeof snapshot.extractorInput !== 'string')
    throw new Error('SOLANA_REQUEST_INVALID_JSON');
  return snapshot;
};

/** Capture one real extractor profile and bind its exact input to Guard hooks. */
export const createSolanaEventContext = (
  extractor: SolanaRosenExtractor,
): SolanaEventContext => {
  const resolvedProfile = captureResolvedProfile(extractor);
  const contextTransactions = new WeakSet<object>();

  /** Bind exact enriched bytes and request coordinates to this context. */
  const bindRequest = (request: SolanaEventRequest): SolanaEventTransaction => {
    const snapshot = snapshotRequest(request);
    const root = objectValue(
      parseLosslessJson(snapshot.extractorInput),
      'SOLANA_REQUEST_ROOT_INVALID',
    );
    const transaction = objectValue(
      member(root, 'transaction'),
      'SOLANA_REQUEST_TRANSACTION_MISSING',
    );
    const signatures = member(transaction, 'signatures');
    if (signatures?.kind !== 'array' || signatures.items.length === 0)
      throw new Error('SOLANA_REQUEST_SIGNATURE_MISSING');
    const observedSignature = stringValue(
      signatures.items[0],
      'SOLANA_REQUEST_SIGNATURE_MISSING',
    );
    if (observedSignature !== snapshot.requestedTxId)
      throw new Error('SOLANA_REQUEST_SIGNATURE_MISMATCH');

    const blockhash = stringValue(
      member(root, 'blockhash'),
      'SOLANA_REQUEST_BLOCKHASH_MISSING',
    );
    if (blockhash !== snapshot.requestedBlockhash)
      throw new Error('SOLANA_REQUEST_BLOCKHASH_MISMATCH');

    const slot = integerValue(
      member(root, 'slot'),
      'SOLANA_REQUEST_SLOT_INVALID',
    );
    if (slot !== BigInt(snapshot.observedSlot))
      throw new Error('SOLANA_REQUEST_SLOT_MISMATCH');

    const genesisHash = stringValue(
      member(root, 'clusterGenesisHash'),
      'SOLANA_REQUEST_GENESIS_MISSING',
    );
    if (genesisHash !== resolvedProfile.genesisHash)
      throw new Error('SOLANA_REQUEST_GENESIS_MISMATCH');

    const destinationNetwork = stringValue(
      member(root, 'destinationNetwork'),
      'SOLANA_REQUEST_DESTINATION_NETWORK_MISSING',
    );
    if (destinationNetwork !== resolvedProfile.destinationNetwork)
      throw new Error('SOLANA_REQUEST_DESTINATION_NETWORK_MISMATCH');

    const historyNode = member(root, 'history');
    if (historyNode?.kind === 'object') {
      const historySignature = stringValue(
        member(historyNode, 'sourceTxId'),
        'SOLANA_REQUEST_HISTORY_SIGNATURE_MISSING',
      );
      if (historySignature !== observedSignature)
        throw new Error('SOLANA_REQUEST_HISTORY_SIGNATURE_MISMATCH');
      const historySlot = integerValue(
        member(historyNode, 'slot'),
        'SOLANA_REQUEST_HISTORY_SLOT_INVALID',
      );
      if (historySlot !== slot)
        throw new Error('SOLANA_REQUEST_HISTORY_SLOT_MISMATCH');
      const historyGenesis = stringValue(
        member(historyNode, 'clusterGenesisHash'),
        'SOLANA_REQUEST_HISTORY_GENESIS_MISSING',
      );
      if (historyGenesis !== genesisHash)
        throw new Error('SOLANA_REQUEST_HISTORY_GENESIS_MISMATCH');
    } else if (
      historyNode &&
      !(historyNode.kind === 'atom' && historyNode.value === null)
    ) {
      throw new Error('SOLANA_REQUEST_HISTORY_INVALID');
    }

    const bound = Object.freeze({
      extractorInput: snapshot.extractorInput,
      requestedTxId: snapshot.requestedTxId,
      requestedBlockhash: snapshot.requestedBlockhash,
      observedSlot: snapshot.observedSlot,
      rosenBlockHeight: snapshot.rosenBlockHeight,
      observedSignature,
      resolvedProfile,
    });
    contextTransactions.add(bound);
    return bound;
  };

  /** Require membership in this context's unforgeable carrier set. */
  const requireTransaction = (transaction: unknown) => {
    if (
      typeof transaction !== 'object' ||
      transaction === null ||
      !contextTransactions.has(transaction)
    )
      throw new Error('SOLANA_REQUEST_CARRIER_MISSING');
    return transaction as SolanaEventTransaction;
  };

  /** Return the original enriched input for AbstractChain extraction. */
  const serializeTx = (transaction: unknown) =>
    requireTransaction(transaction).extractorInput;

  /** Bind contextual projection to the Guard block identity before acceptance. */
  const verifyLockTransactionExtraConditions = async (
    transaction: unknown,
    blockInfo: SolanaEventBlockInfo,
  ): Promise<boolean> => {
    const bound = requireTransaction(transaction);
    if (blockInfo.hash !== bound.requestedBlockhash)
      throw new Error('SOLANA_REQUEST_BLOCKINFO_HASH_MISMATCH');
    if (blockInfo.height !== bound.rosenBlockHeight)
      throw new Error('SOLANA_REQUEST_BLOCKINFO_HEIGHT_MISMATCH');

    const outcome = extractor.getWithContext(bound.extractorInput);
    const outcomeType = (outcome as { readonly type?: unknown }).type;
    if (outcomeType === 'unavailable') {
      const unavailable = outcome as Extract<
        SolanaRosenExtractionOutcome,
        { readonly type: 'unavailable' }
      >;
      throw new Error(`SOLANA_EXTRACTION_UNAVAILABLE:${unavailable.reason}`);
    }
    if (outcomeType === 'not-deposit') return false;
    if (outcomeType !== 'deposit')
      throw new Error('SOLANA_EXTRACTION_UNAVAILABLE:UNKNOWN_OUTCOME');
    const deposit = outcome as Extract<
      SolanaRosenExtractionOutcome,
      { readonly type: 'deposit' }
    >;
    if (
      deposit.context.sourceTxId !== bound.requestedTxId ||
      deposit.context.sourceBlockhash !== bound.requestedBlockhash ||
      deposit.context.sourceSlot !== bound.observedSlot ||
      deposit.context.clusterGenesisHash !== resolvedProfile.genesisHash
    )
      throw new Error('SOLANA_REQUEST_EXTRACTOR_CONTEXT_MISMATCH');
    return true;
  };

  return Object.freeze({
    extractor,
    resolvedProfile,
    bindRequest,
    serializeTx,
    verifyLockTransactionExtraConditions,
  });
};
