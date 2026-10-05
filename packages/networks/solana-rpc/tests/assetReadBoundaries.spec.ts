import { describe, expect, it } from 'vitest';

import type { SolanaEventContext } from '@rosen-chains/solana';

import { SolanaRpcNetwork } from '../lib/solanaRpcNetwork';
import {
  BOUNDARY_TOKEN_ID as TOKEN_ID,
  boundaryContexts as contexts,
} from './assetReadBoundariesTestData';
import {
  contextNetwork,
  inventoryNetwork,
  mintNetwork,
  validBoundaryItem as validItem,
} from './assetReadBoundariesTestUtils';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  MINT,
  OTHER_MINT,
  TEST_GENESIS,
  U64_MAX,
  WALLET,
  WRAPPED_SOL_MINT,
} from './assetReadTestData';
import {
  balanceResult,
  genesisResponse,
  makeAssetReadNetwork,
  mintAccount,
  mintData,
  mintResult,
  rpcResponse,
  tokenAccountData,
  tokenAccountItem,
  tokenAccountsResult,
} from './assetReadTestUtils';

describe('Solana asset read authority boundaries', () => {
  /**
   * @target SolanaRpcNetwork.getAddressAssets
   * rejects an invalid wallet before RPC
   * @dependencies scripted transport and an invalid wallet literal
   * @scenario query a wallet that is not a canonical 32-byte public key
   * @expected reject the wallet before making any RPC request
   */
  it('rejects an invalid wallet before RPC', async () => {
    const { network, requests } = inventoryNetwork(
      tokenAccountsResult('500', []),
    );
    await expect(
      network.getAddressAssets('not-a-public-key'),
    ).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_ASSET_WALLET_INVALID' },
    });
    expect(requests).toEqual([]);
  });

  /**
   * @target SolanaRpcNetwork asset profile capture
   * rejects a malformed captured genesis before RPC
   * @dependencies scripted transport and malformed captured genesis configuration
   * @scenario construct the provider with a noncanonical genesis and request assets
   * @expected reject the captured configuration without contacting the endpoint
   */
  it('rejects a malformed captured genesis before RPC', async () => {
    const { network, requests } = makeAssetReadNetwork(() => {
      throw new Error('INVALID_PROFILE_MUST_NOT_CALL_RPC');
    }, 'not-a-genesis-hash');
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_ASSET_EXPECTED_GENESIS_INVALID' },
    });
    expect(requests).toEqual([]);
  });

  /**
   * @target SolanaRpcNetwork constructor and lazy asset API
   * captures genesis at construction rather than first asset use
   * @dependencies mutable caller profile and an endpoint reporting its replacement genesis
   * @scenario change the profile after construction but before the first asset query
   * @expected retain the original identity and reject the replacement before account reads
   */
  it('captures genesis at construction rather than first asset use', async () => {
    const profile = { genesisHash: TEST_GENESIS, assets: [] };
    const methods: string[] = [];
    const network = new SolanaRpcNetwork({
      context: { resolvedProfile: profile } as unknown as SolanaEventContext,
      locateBlock: async () => undefined,
      transport: async (request) => {
        methods.push(request.method);
        if (request.method === 'getGenesisHash')
          return genesisResponse(request, OTHER_MINT);
        throw new Error('CHANGED_PROFILE_MUST_STOP_ACCOUNT_READS');
      },
    });
    profile.genesisHash = OTHER_MINT;
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_RPC_GENESIS_MISMATCH' },
    });
    expect(methods).toEqual(['getGenesisHash']);
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets inventory carriers
   * rejects %s inventory carrier
   * @dependencies one independently malformed inventory field per row
   * @scenario replace the list, entry, public key or account carrier while retaining valid context
   * @expected reject the complete read with its field-specific cause and no retry
   */
  it.each([
    [
      'missing value',
      '{"context":{"slot":500}}',
      'SOLANA_ASSET_RESPONSE_FIELD_MISSING:value',
    ],
    [
      'non-array value',
      '{"context":{"slot":500},"value":{}}',
      'SOLANA_ASSET_ACCOUNT_LIST_INVALID',
    ],
    [
      'non-object entry',
      tokenAccountsResult('500', [null]),
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
    [
      'invalid pubkey',
      tokenAccountsResult('500', [{ ...validItem, pubkey: 'invalid' }]),
      'SOLANA_ASSET_ACCOUNT_ADDRESS_INVALID',
    ],
    [
      'missing pubkey',
      tokenAccountsResult('500', [{ account: validItem.account }]),
      'SOLANA_ASSET_ACCOUNT_ADDRESS_INVALID',
    ],
    [
      'missing account',
      tokenAccountsResult('500', [{ pubkey: ACCOUNT_A }]),
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
    [
      'non-object account',
      tokenAccountsResult('500', [{ ...validItem, account: null }]),
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
  ])('rejects %s inventory carrier', async (_label, resultJson, cause) => {
    const { network, requests } = inventoryNetwork(resultJson);
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: cause },
    });
    expect(requests.map(({ method }) => method)).toEqual([
      'getGenesisHash',
      'getBalance',
      'getTokenAccountsByOwner',
    ]);
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets account envelope
   * rejects %s envelope
   * @dependencies one independently varied executable, encoding or layout field per row
   * @scenario replace one field in an otherwise valid original-program account
   * @expected reject the whole inventory before post-read genesis or retry
   */
  it.each([
    [
      'executable account',
      { ...validItem.account, executable: true },
      'SOLANA_ASSET_ACCOUNT_EXECUTABLE',
    ],
    [
      'missing executable',
      { ...validItem.account, executable: undefined },
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
    [
      'non-boolean executable',
      { ...validItem.account, executable: 'false' },
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
    [
      'wrong encoding',
      { ...validItem.account, data: [tokenAccountData(), 'base58'] },
      'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
    ],
    [
      'extra data item',
      { ...validItem.account, data: [tokenAccountData(), 'base64', 'extra'] },
      'SOLANA_ASSET_ACCOUNT_INVALID',
    ],
    [
      'extended account',
      {
        ...validItem.account,
        data: [Buffer.alloc(166).toString('base64'), 'base64'],
      },
      'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
    ],
  ])('rejects %s envelope', async (_label, account, cause) => {
    const { network, requests } = inventoryNetwork(
      tokenAccountsResult('500', [{ pubkey: ACCOUNT_A, account }]),
    );
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: cause },
    });
    expect(requests).toHaveLength(3);
  });

  /**
   * @target decodeSolanaAssetTokenAccount through the provider
   * rejects %s binary field
   * @dependencies exact legacy account bytes with one state or native-option mutation
   * @scenario set an unknown state, invalid native tag or native reserve on an ordinary mint
   * @expected reject with the binary field's cause without retry or partial assets
   */
  it.each([
    [
      'unknown state',
      tokenAccountData({ state: 3 }),
      'SOLANA_ASSET_ACCOUNT_STATE_INVALID',
    ],
    [
      'invalid native option',
      tokenAccountData({ nativeTag: 2 }),
      'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID',
    ],
    [
      'native reserve for ordinary mint',
      tokenAccountData({ nativeReserve: 1n }),
      'SOLANA_ASSET_NATIVE_RESERVE_MINT_MISMATCH',
    ],
  ])('rejects %s binary field', async (_label, data, cause) => {
    const { network, requests } = inventoryNetwork(
      tokenAccountsResult('500', [tokenAccountItem(ACCOUNT_A, data)]),
    );
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: cause },
    });
    expect(requests).toHaveLength(3);
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets excluded-account validation
   * validates excluded WSOL %s
   * @dependencies valid preceding inventory plus a wrapped-SOL account with one invalid option
   * @scenario corrupt the native or close-authority tag of a subsequently excluded WSOL account
   * @expected decode every account before exclusion and reject without returning the valid prefix
   */
  it.each([
    [
      'native option',
      tokenAccountData({ mint: WRAPPED_SOL_MINT, nativeTag: 2 }),
    ],
    [
      'close authority',
      tokenAccountData({ mint: WRAPPED_SOL_MINT, closeAuthorityTag: 2 }),
    ],
  ])('validates excluded WSOL %s', async (_label, data) => {
    const { network, requests } = inventoryNetwork(
      tokenAccountsResult('500', [
        validItem,
        tokenAccountItem(ACCOUNT_B, data),
      ]),
    );
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID' },
    });
    expect(requests).toHaveLength(3);
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets retry ordering
   * does not retry a malformed account on unequal slots
   * @dependencies unequal valid context slots and one invalid account option
   * @scenario return a malformed account in the first mismatched response pair
   * @expected preserve its decoder error and stop instead of retrying the unequal slots
   */
  it('does not retry a malformed account on unequal slots', async () => {
    const { network, requests } = inventoryNetwork(
      tokenAccountsResult('501', [
        tokenAccountItem(ACCOUNT_A, tokenAccountData({ nativeTag: 2 })),
      ]),
    );
    await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: 'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID' },
    });
    expect(requests).toHaveLength(3);
  });

  describe.each(['getBalance', 'getTokenAccountsByOwner'] as const)(
    '%s finalized context',
    (method) => {
      /**
       * @target SolanaRpcNetwork.getAddressAssets
       * rejects %s
       * @dependencies one response method and one independently malformed context per row
       * @scenario replace only the selected response's context while preserving its value
       * @expected reject the context before returning assets or mint details and do not retry
       */
      it.each(contexts)('rejects %s', async (_label, context, cause) => {
        const { network, requests } = contextNetwork(method, context);
        await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
          message: 'SOLANA_REQUEST_UNAVAILABLE',
          cause: { message: cause },
        });
        expect(requests.map(({ method: called }) => called)).toEqual([
          'getGenesisHash',
          'getBalance',
          'getTokenAccountsByOwner',
        ]);
      });
    },
  );

  describe('SolanaRpcNetwork.getTokenDetail finalized context', () => {
    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * rejects %s
     * @dependencies one independently malformed mint-response context per row
     * @scenario replace only the mint context while preserving the initialized mint account
     * @expected reject before returning details or requesting post-read genesis
     */
    it.each(contexts)('rejects %s', async (_label, context, cause) => {
      const { network, requests } = contextNetwork('getAccountInfo', context);
      await expect(network.getTokenDetail(TOKEN_ID)).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause: { message: cause },
      });
      expect(requests.map(({ method }) => method)).toEqual([
        'getGenesisHash',
        'getAccountInfo',
      ]);
    });
  });

  /**
   * @target SolanaRpcNetwork finalized slot parsing
   * accepts matching finalized slots above the safe Number range
   * @dependencies matching u64 slot lexemes above Number.MAX_SAFE_INTEGER
   * @scenario return the same wide slot in native and token inventory contexts
   * @expected preserve exact comparison and accept the matched finalized view
   */
  it('accepts matching finalized slots above the safe Number range', async () => {
    const { network } = makeAssetReadNetwork((request) => {
      if (request.method === 'getGenesisHash') return genesisResponse(request);
      if (request.method === 'getBalance')
        return rpcResponse(request, balanceResult('9007199254740993', '1'));
      if (request.method === 'getTokenAccountsByOwner')
        return rpcResponse(
          request,
          tokenAccountsResult('9007199254740993', []),
        );
      throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
    });
    await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
      nativeToken: 1n,
      tokens: [],
    });
  });

  /**
   * @target SolanaRpcNetwork.getTokenDetail mint authority
   * rejects %s authority
   * @dependencies one independently malformed mint presence, binary option or account field per row
   * @scenario replace only that field in a finalized original-program mint response
   * @expected reject without exposing metadata or running post-read genesis
   */
  it.each([
    [
      'null mint',
      '{"context":{"slot":500},"value":null}',
      'SOLANA_ASSET_MINT_NOT_FOUND',
    ],
    ['missing mint', '{"context":{"slot":500}}', 'SOLANA_ASSET_MINT_NOT_FOUND'],
    [
      'invalid initialized flag',
      mintResult('500', mintAccount(mintData({ initialized: 2 }))),
      'SOLANA_ASSET_MINT_UNINITIALIZED',
    ],
    [
      'invalid freeze authority',
      mintResult('500', mintAccount(mintData({ freezeAuthorityTag: 2 }))),
      'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID',
    ],
    [
      'executable mint',
      mintResult('500', { ...mintAccount(), executable: true }),
      'SOLANA_ASSET_ACCOUNT_EXECUTABLE',
    ],
    [
      'extended mint',
      mintResult('500', mintAccount(Buffer.alloc(83).toString('base64'))),
      'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
    ],
    [
      'noncanonical base64 tail',
      mintResult(
        '500',
        mintAccount(`${Buffer.alloc(82).toString('base64').slice(0, -4)}AB==`),
      ),
      'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
    ],
  ])('rejects %s authority', async (_label, resultJson, cause) => {
    const { network, requests } = mintNetwork(resultJson);
    await expect(network.getTokenDetail(TOKEN_ID)).rejects.toMatchObject({
      message: 'SOLANA_REQUEST_UNAVAILABLE',
      cause: { message: cause },
    });
    expect(requests.map(({ method }) => method)).toEqual([
      'getGenesisHash',
      'getAccountInfo',
    ]);
  });

  /**
   * @target SolanaRpcNetwork.getTokenDetail decimal precision
   * preserves mint decimals %s
   * @dependencies initialized mint fixtures at zero, ordinary SPL and u8 maximum precision
   * @scenario query each decimal byte without token-map scaling or metadata services
   * @expected return that exact byte and the mint address name rather than native SOL precision
   */
  it.each([0, 6, 255])('preserves mint decimals %s', async (decimals) => {
    const { network, requests } = mintNetwork(
      mintResult('500', mintAccount(mintData({ decimals }))),
    );
    await expect(network.getTokenDetail(TOKEN_ID)).resolves.toEqual({
      tokenId: TOKEN_ID,
      name: MINT,
      decimals,
    });
    expect(requests.map(({ method }) => method)).toEqual([
      'getGenesisHash',
      'getAccountInfo',
      'getGenesisHash',
    ]);
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets exact SPL amounts
   * preserves %s
   * @dependencies legacy binary amounts at the u64 boundary, individually and as an aggregate
   * @scenario return one maximum account or two accounts summing to the maximum
   * @expected retain the maximum bigint without rejecting, truncating or wrapping its raw units
   */
  it.each([
    [
      'one maximum account',
      [tokenAccountItem(ACCOUNT_A, tokenAccountData({ amount: U64_MAX }))],
    ],
    [
      'maximum aggregate',
      [
        tokenAccountItem(ACCOUNT_A, tokenAccountData({ amount: U64_MAX - 1n })),
        tokenAccountItem(ACCOUNT_B, tokenAccountData({ amount: 1n })),
      ],
    ],
  ])('preserves %s', async (_label, accounts) => {
    const { network } = inventoryNetwork(tokenAccountsResult('500', accounts));
    await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
      nativeToken: 1n,
      tokens: [{ id: TOKEN_ID, value: U64_MAX }],
    });
  });

  /**
   * @target SolanaRpcNetwork.getAddressAssets failure custody
   * preserves %s transport failure
   * @dependencies one transport failure at inventory or the post-read genesis checkpoint
   * @scenario throw after the native balance or after the complete matched read pair
   * @expected retain the transport cause, return no partial balances and perform no retry
   */
  it.each(['inventory', 'post-read genesis'] as const)(
    'preserves %s transport failure',
    async (failure) => {
      let genesisReads = 0;
      const cause = new Error('FIXTURE_ASSET_TRANSPORT_FAILED');
      const { network, requests } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash') {
          genesisReads++;
          if (failure === 'post-read genesis' && genesisReads === 2)
            throw cause;
          return genesisResponse(request);
        }
        if (request.method === 'getBalance')
          return rpcResponse(request, balanceResult('500', '1'));
        if (request.method === 'getTokenAccountsByOwner') {
          if (failure === 'inventory') throw cause;
          return rpcResponse(request, tokenAccountsResult('500', [validItem]));
        }
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });
      await expect(network.getAddressAssets(WALLET)).rejects.toMatchObject({
        message: 'SOLANA_REQUEST_UNAVAILABLE',
        cause,
      });
      expect(requests).toHaveLength(failure === 'inventory' ? 3 : 4);
    },
  );
});
