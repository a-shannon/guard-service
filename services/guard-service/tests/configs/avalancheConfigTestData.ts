/** Complete synthetic Fuji configuration with inactive management routes. */
export const valid: Record<string, unknown> = {
  'avalanche.enabled': true,
  'avalanche.chainId': 43113,
  'avalanche.sourceId': 'synthetic-fuji',
  'avalanche.rpc.url': 'http://127.0.0.1:1/ext/bc/C/rpc',
  'avalanche.rpc.timeout': 8,
  'avalanche.rpc.scannerInterval': 20,
  'avalanche.rpc.initialHeight': -1,
  'avalanche.healthCheck.blockTime': 0.5,
  'avalanche.maxParallelTx': 2,
  'avalanche.gasPriceSlippage': 0,
  'avalanche.gasLimitSlippage': 0,
  'avalanche.gasLimitMultiplier': 1,
  'avalanche.gasLimitCap': '80000',
  'avalanche.confirmation.observation': 1,
  'avalanche.confirmation.payment': 1,
  'avalanche.confirmation.cold': 3,
  'avalanche.confirmation.manual': 4,
  'avalanche.confirmation.arbitrary': 5,
  'avalanche.tssChainCode': 'SyntheticChainCode',
  'avalanche.derivationPath': [44, 60, 0, 0],
};

/** Single-field factory faults for each required inactive-operation confirmation count. */
export const managementConfirmationFaults = [
  'cold',
  'manual',
  'arbitrary',
].flatMap((route) =>
  [
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 0.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
  ].map(([label, value]) => [route, label, value] as const),
);

/** Independent invalid field/value pairs covering strict raw configuration boundaries. */
export const faults: Array<[string, unknown]> = [
  ...['true', 'false', 1, 0, null].map((value): [string, unknown] => [
    'enabled',
    value,
  ]),
  ...[1, 43112, '43113', 43113n, null].map((value): [string, unknown] => [
    'chainId',
    value,
  ]),
  ...['', ' invalid', '-invalid', 'source/url', 'a'.repeat(129), 1].map(
    (value): [string, unknown] => ['sourceId', value],
  ),
  ...[
    '',
    ' https://example.invalid',
    'ftp://example.invalid',
    'not-a-url',
    1,
  ].map((value): [string, unknown] => ['rpc.url', value]),
  ['rpc.authToken', 1],
  ...['rpc.timeout', 'rpc.scannerInterval'].flatMap((field) =>
    [0, -1, Infinity, NaN, '1', 2147483.648].map((value): [string, unknown] => [
      field,
      value,
    ]),
  ),
  ...[-2, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'].map(
    (value): [string, unknown] => ['rpc.initialHeight', value],
  ),
  ...[0, -1, Infinity, NaN, '0.5'].map((value): [string, unknown] => [
    'healthCheck.blockTime',
    value,
  ]),
  ...[
    'maxParallelTx',
    'gasLimitMultiplier',
    'confirmation.observation',
    'confirmation.payment',
    'confirmation.cold',
    'confirmation.manual',
    'confirmation.arbitrary',
  ].flatMap((field) =>
    [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(
      (value): [string, unknown] => [field, value],
    ),
  ),
  ...['gasPriceSlippage', 'gasLimitSlippage'].flatMap((field) =>
    [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0'].map(
      (value): [string, unknown] => [field, value],
    ),
  ),
  ...[
    'confirmation.cold',
    'confirmation.manual',
    'confirmation.arbitrary',
  ].flatMap((field) =>
    [undefined, null, false, NaN, Infinity].map((value): [string, unknown] => [
      field,
      value,
    ]),
  ),
  ...[
    0,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    '01',
    '+1',
    ' 1',
    '1.0',
    '1e3',
    '0x10',
    1n,
    (1n << 256n).toString(),
  ].map((value): [string, unknown] => ['gasLimitCap', value]),
  ...['', ' leading', 'trailing ', 123].map((value): [string, unknown] => [
    'tssChainCode',
    value,
  ]),
  ...[
    [],
    [0, -1],
    [0, 0.5],
    [0, 2 ** 31],
    [0, '1'],
    [0, NaN],
    new Array(1),
    new Array(256).fill(0),
    '44/60/0/0',
    null,
  ].map((value): [string, unknown] => ['derivationPath', value]),
];

export const realRouteFaults: Array<[string, unknown]> = [
  ['unknown field', { extra: false }],
  ['string flag', { cold: 'false' }],
  ['numeric flag', { manual: 1 }],
  ['null flag', { arbitrary: null }],
  ['array', [false]],
  ['null', null],
];
