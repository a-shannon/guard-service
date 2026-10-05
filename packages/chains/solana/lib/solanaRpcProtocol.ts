const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

/** One JSON-RPC request sent through the caller-owned transport. */
export interface SolanaRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export type SolanaRpcTransport = (request: SolanaRpcRequest) => Promise<string>;
interface BaseNode {
  readonly start: number;
  readonly end: number;
}
export interface ObjectNode extends BaseNode {
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
export interface AtomNode extends BaseNode {
  readonly kind: 'atom';
  readonly value: boolean | null;
}
export type JsonNode =
  | ObjectNode
  | ArrayNode
  | StringNode
  | NumberNode
  | AtomNode;

/** Throw a parser error with the supplied stable failure code. */
const failJson = (reason = 'SOLANA_RPC_INVALID_JSON'): never => {
  throw new Error(reason);
};

/** Parse bounded JSON while preserving raw slices and number spellings. */
export const parseJson = (source: string): JsonNode => {
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
export const member = (node: JsonNode | undefined, key: string) =>
  node?.kind === 'object' ? node.members.get(key) : undefined;
/** Return a decoded string only for an actual JSON string node. */
export const stringValue = (node: JsonNode | undefined) =>
  node?.kind === 'string' ? node.value : undefined;
/** Read a non-negative safe integer from its preserved decimal token. */
export const integerValue = (
  node: JsonNode | undefined,
  field: string,
): number => {
  if (node?.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(node.lexeme))
    throw new Error(`SOLANA_RPC_INVALID_${field.toUpperCase()}`);
  const value = BigInt(node.lexeme);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`SOLANA_RPC_UNSAFE_${field.toUpperCase()}`);
  return Number(value);
};
/** Validate a successful response envelope and return its exact parsed result. */
export const response = (
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
/** Allocate correlated immutable requests for one producer or read session. */
export const createRpcCaller = (transport: SolanaRpcTransport) => {
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

/** Read an exact non-negative u64 from a preserved JSON integer token. */
export const readU64Value = (node: JsonNode | undefined): bigint => {
  if (node?.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(node.lexeme))
    throw new Error('SOLANA_RPC_INVALID_U64');
  const value = BigInt(node.lexeme);
  if (value > 18_446_744_073_709_551_615n)
    throw new Error('SOLANA_RPC_U64_OUT_OF_RANGE');
  return value;
};
