import { describe, expect, it } from 'vitest';

import {
  getSolanaAssetIdentityKey,
  SOLANA_TOKEN_PROGRAM_ID,
} from '@rosen-bridge/address-codec-solana';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_C,
  ASSET_NATIVE_ID as NATIVE_ID,
  ASSET_TOKEN_ID as TOKEN_ID,
  MINT,
  OTHER_MINT,
  OTHER_WALLET,
  SYSTEM_PROGRAM,
  TEST_GENESIS,
  EXTENDED_SPL_PROGRAM_ID,
  ORIGINAL_SPL_PROGRAM_ID,
  U64_MAX,
  WALLET,
  WRAPPED_SOL_MINT,
} from './assetReadTestData';
import {
  balanceResult,
  expectAssetCause,
  genesisResponse,
  makeAssetReadNetwork,
  mintAccount,
  mintData,
  mintResult,
  rpcResponse as respondTo,
  tokenAccountsResult,
  tokenAccountData,
  tokenAccountItem,
} from './assetReadTestUtils';

describe('SolanaRpcNetwork', () => {
  describe('getAddressAssets inventory', () => {
    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * preserves wide raw SOL and aggregates usable SPL accounts
     * @dependencies
     * - scripted JSON-RPC transport only; no endpoint or test helper is mocked beyond its interface
     * - synthetic finalized balance and token-account records
     * @scenario
     * - return a lamport balance above Number.MAX_SAFE_INTEGER and two accounts for one mint
     * - inspect the returned AssetBalance and the three finalized RPC requests
     * @expected
     * - preserve every amount as bigint and aggregate token accounts under the canonical cluster-bound ID
     * - request only the original Token Program and do not scale decimals in the provider
     */
    it('preserves wide raw SOL and aggregates usable SPL accounts', async () => {
      const { network, requests } = makeAssetReadNetwork((request) => {
        switch (request.method) {
          case 'getGenesisHash':
            return genesisResponse(request);
          case 'getBalance':
            return respondTo(request, balanceResult('500', '9007199254740993'));
          case 'getTokenAccountsByOwner':
            return respondTo(
              request,
              tokenAccountsResult('500', [
                tokenAccountItem(
                  ACCOUNT_A,
                  tokenAccountData({ amount: 12_345n }),
                ),
                tokenAccountItem(ACCOUNT_B, tokenAccountData({ amount: 678n })),
              ]),
            );
          default:
            throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
        }
      });

      await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
        nativeToken: 9_007_199_254_740_993n,
        tokens: [{ id: TOKEN_ID, value: 13_023n }],
      });
      expect(requests.map(({ method }) => method)).toEqual([
        'getGenesisHash',
        'getBalance',
        'getTokenAccountsByOwner',
        'getGenesisHash',
      ]);
      expect(requests[1].params).toEqual([WALLET, { commitment: 'finalized' }]);
      expect(requests[2].params).toEqual([
        WALLET,
        { programId: ORIGINAL_SPL_PROGRAM_ID },
        { commitment: 'finalized', encoding: 'base64' },
      ]);
      expect(requests.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * filters frozen accounts and wrapped SOL after validating their layouts
     * @dependencies
     * - synthetic finalized account list containing valid initialized and frozen layouts
     * - no network or validator mocks
     * @scenario
     * - return one frozen original SPL account and one initialized wrapped-SOL account
     * @expected
     * - validate both complete account layouts and return neither as a bridge-eligible SPL balance
     */
    it('filters frozen accounts and wrapped SOL after validating their layouts', async () => {
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', '7'));
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(
            request,
            tokenAccountsResult('500', [
              tokenAccountItem(
                ACCOUNT_A,
                tokenAccountData({ amount: 11n, state: 2 }),
              ),
              tokenAccountItem(
                ACCOUNT_B,
                tokenAccountData({
                  mint: WRAPPED_SOL_MINT,
                  amount: 13n,
                  nativeReserve: 2_039_280n,
                }),
              ),
            ]),
          );
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
        nativeToken: 7n,
        tokens: [],
      });
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects malformed account %s
     * @dependencies
     * - independently mutated synthetic account records
     * - mocked transport returns ordinary JSON-RPC envelopes
     * @scenario
     * - change one account owner, encoding, byte length, state or COption tag at a time
     * @expected
     * - reject the complete inventory without returning a partial balance
     * - do not retry an account decoder failure
     */
    it.each([
      [
        'wallet owner',
        tokenAccountData({ owner: OTHER_WALLET }),
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_WALLET_OWNER_MISMATCH',
      ],
      [
        'Token-2022 program owner',
        tokenAccountData(),
        EXTENDED_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_PROGRAM_OWNER_MISMATCH',
      ],
      [
        'invalid base64',
        '%%%=',
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
      ],
      [
        'truncated layout',
        Buffer.alloc(164).toString('base64'),
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
      ],
      [
        'uninitialized state',
        tokenAccountData({ state: 0 }),
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_STATE_INVALID',
      ],
      [
        'invalid delegate tag',
        tokenAccountData({ delegateTag: 2 }),
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID',
      ],
      [
        'invalid close-authority tag',
        tokenAccountData({ closeAuthorityTag: 2 }),
        ORIGINAL_SPL_PROGRAM_ID,
        'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID',
      ],
    ])('rejects malformed account %s', async (_label, data, owner, cause) => {
      let accountQueries = 0;
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', '1'));
        if (request.method === 'getTokenAccountsByOwner') {
          accountQueries++;
          return respondTo(
            request,
            tokenAccountsResult('500', [
              tokenAccountItem(ACCOUNT_A, data, owner),
            ]),
          );
        }
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(network.getAddressAssets(WALLET), cause);
      expect(accountQueries).toEqual(1);
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects duplicate token-account pubkeys
     * @dependencies
     * - two otherwise-valid synthetic SPL records with one repeated pubkey
     * - scripted JSON-RPC transport
     * @scenario
     * - return the same account address twice in one inventory
     * @expected
     * - reject the full inventory as ambiguous and do not retry it
     */
    it('rejects duplicate token-account pubkeys', async () => {
      let accountQueries = 0;
      const item = tokenAccountItem(
        ACCOUNT_A,
        tokenAccountData({ amount: 1n }),
      );
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', '1'));
        if (request.method === 'getTokenAccountsByOwner') {
          accountQueries++;
          return respondTo(request, tokenAccountsResult('500', [item, item]));
        }
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(
        network.getAddressAssets(WALLET),
        'SOLANA_ASSET_DUPLICATE_ACCOUNT',
      );
      expect(accountQueries).toEqual(1);
    });
  });
  describe('getTokenDetail metadata', () => {
    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * returns native SOL metadata without an RPC request
     * @dependencies
     * - canonical native asset ID from the Solana address codec
     * - no mocked transport is called
     * @scenario
     * - request details by both the bridge native token ID and canonical cluster-bound ID
     * @expected
     * - return nine decimals for SOL and preserve the supplied token ID
     */
    it('returns native SOL metadata without an RPC request', async () => {
      const { network, requests } = makeAssetReadNetwork(() => {
        throw new Error('NATIVE_DETAIL_MUST_NOT_CALL_RPC');
      });

      await expect(network.getTokenDetail('sol')).resolves.toEqual({
        tokenId: 'sol',
        name: 'SOL',
        decimals: 9,
      });
      await expect(network.getTokenDetail(NATIVE_ID)).resolves.toEqual({
        tokenId: NATIVE_ID,
        name: 'SOL',
        decimals: 9,
      });
      expect(requests).toEqual([]);
    });

    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * returns initialized original SPL mint details at finalized commitment
     * @dependencies
     * - finalized synthetic mint account owned by the original Token Program
     * - scripted transport with pre- and post-read cluster identity checks
     * @scenario
     * - request a canonical cluster/program/mint identity
     * @expected
     * - return the unchanged ID, deterministic mint-name fallback and raw decimals
     * - issue a finalized base64 getAccountInfo request
     */
    it('returns initialized original SPL mint details at finalized commitment', async () => {
      const { network, requests } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getAccountInfo')
          return respondTo(
            request,
            mintResult('600', mintAccount(mintData({ decimals: 9 }))),
          );
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expect(network.getTokenDetail(TOKEN_ID)).resolves.toEqual({
        tokenId: TOKEN_ID,
        name: MINT,
        decimals: 9,
      });
      expect(requests.map(({ method }) => method)).toEqual([
        'getGenesisHash',
        'getAccountInfo',
        'getGenesisHash',
      ]);
      expect(requests[1].params).toEqual([
        MINT,
        { commitment: 'finalized', encoding: 'base64' },
      ]);
    });

    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * rejects %s asset identity
     * @dependencies
     * - synthetic genesis, system-program, Token-2022 and malformed mint IDs
     * - transport that fails if called
     * @scenario
     * - request one invalid qualified ID at a time
     * @expected
     * - reject each identity with the stable token-ID cause and make no request
     */
    it.each([
      [
        'wrong cluster',
        `11111111111111111111111111111111:${ORIGINAL_SPL_PROGRAM_ID}:${MINT}`,
      ],
      ['system program as SPL', `${TEST_GENESIS}:${SYSTEM_PROGRAM}:${MINT}`],
      [
        'Token-2022 program',
        `${TEST_GENESIS}:${EXTENDED_SPL_PROGRAM_ID}:${MINT}`,
      ],
      [
        'wrapped SOL mint',
        `${TEST_GENESIS}:${ORIGINAL_SPL_PROGRAM_ID}:${WRAPPED_SOL_MINT}`,
      ],
      [
        'malformed mint key',
        `${TEST_GENESIS}:${ORIGINAL_SPL_PROGRAM_ID}:not-a-public-key`,
      ],
      [
        'noncanonical field count',
        `${TEST_GENESIS}:${ORIGINAL_SPL_PROGRAM_ID}:${MINT}:extra`,
      ],
    ])('rejects %s asset identity', async (_label, tokenId) => {
      let calls = 0;
      const { network } = makeAssetReadNetwork(() => {
        calls++;
        throw new Error('INVALID_TOKEN_ID_MUST_NOT_CALL_RPC');
      });

      await expectAssetCause(
        network.getTokenDetail(tokenId),
        'SOLANA_ASSET_TOKEN_ID_INVALID',
      );
      expect(calls).toEqual(0);
    });
  });
  describe('getAddressAssets finalized views', () => {
    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * retries mismatched finalized slots and accepts a matching pair
     * @dependencies
     * - scripted finalized RPC responses with two mismatched pairs followed by one matching pair
     * - request count and request-ID assertions
     * @scenario
     * - advance both returned context slots between the first two read pairs
     * @expected
     * - return only the matching pair and preserve one request-ID sequence
     */
    it('retries mismatched finalized slots and accepts a matching pair', async () => {
      let balanceReads = 0;
      let accountReads = 0;
      const { network, requests } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance') {
          balanceReads++;
          return respondTo(
            request,
            balanceResult(String(700 + balanceReads), '12'),
          );
        }
        if (request.method === 'getTokenAccountsByOwner') {
          accountReads++;
          const slot = accountReads < 3 ? 800 + accountReads : 703;
          return respondTo(
            request,
            tokenAccountsResult(String(slot), [
              tokenAccountItem(ACCOUNT_A, tokenAccountData({ amount: 4n })),
            ]),
          );
        }
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
        nativeToken: 12n,
        tokens: [{ id: TOKEN_ID, value: 4n }],
      });
      expect(balanceReads).toEqual(3);
      expect(accountReads).toEqual(3);
      expect(
        requests.filter(({ method }) => method === 'getGenesisHash'),
      ).toHaveLength(2);
      expect(requests.map(({ id }) => id)).toEqual(
        Array.from({ length: requests.length }, (_, index) => index + 1),
      );
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * fails closed when every finalized slot pair differs
     * @dependencies
     * - scripted valid balance and token-account results with unequal slots
     * - local counters for exact request totals
     * @scenario
     * - make every otherwise-valid slot pair disagree
     * @expected
     * - return no partial balance and stop at the configured retry bound
     */
    it('fails closed when every finalized slot pair differs', async () => {
      let balanceReads = 0;
      let accountReads = 0;
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance') {
          balanceReads++;
          return respondTo(request, balanceResult(String(balanceReads), '12'));
        }
        if (request.method === 'getTokenAccountsByOwner') {
          accountReads++;
          return respondTo(
            request,
            tokenAccountsResult(String(100 + accountReads), []),
          );
        }
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(
        network.getAddressAssets(WALLET),
        'SOLANA_ASSET_CONTEXT_SLOT_MISMATCH',
      );
      expect(balanceReads).toEqual(3);
      expect(accountReads).toEqual(3);
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects %s balance lexemes without retry
     * @dependencies
     * - raw JSON numeric lexemes outside the unsigned u64 grammar or bound
     * - request counters for the balance and inventory calls
     * @scenario
     * - replace one native balance integer with a negative, fractional, exponent or out-of-u64 token
     * @expected
     * - reject the first response pair without returning partial balances or retrying
     */
    it.each([
      ['negative', '-1', 'SOLANA_RPC_INVALID_U64'],
      ['fractional', '1.5', 'SOLANA_RPC_INVALID_U64'],
      ['exponent', '1e2', 'SOLANA_RPC_INVALID_U64'],
      ['above u64', '18446744073709551616', 'SOLANA_RPC_U64_OUT_OF_RANGE'],
    ])(
      'rejects %s balance lexemes without retry',
      async (_label, raw, cause) => {
        let balanceReads = 0;
        let accountReads = 0;
        const { network } = makeAssetReadNetwork((request) => {
          if (request.method === 'getGenesisHash')
            return genesisResponse(request);
          if (request.method === 'getBalance') {
            balanceReads++;
            return respondTo(request, balanceResult('500', raw));
          }
          if (request.method === 'getTokenAccountsByOwner') {
            accountReads++;
            return respondTo(request, tokenAccountsResult('500', []));
          }
          throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
        });

        await expectAssetCause(network.getAddressAssets(WALLET), cause);
        expect(balanceReads).toEqual(1);
        expect(accountReads).toEqual(1);
      },
    );

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects a missing RPC genesis value before reading assets
     * @dependencies
     * - a captured valid profile genesis and one null or wrong-kind RPC result
     * - mocked transport with call counts
     * @scenario
     * - return null instead of a genesis string before an asset read
     * @expected
     * - reject with the genesis-missing cause before requesting balances or mint data
     */
    it('rejects a missing RPC genesis value before reading assets', async () => {
      let assetReads = 0;
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return respondTo(request, 'null');
        assetReads++;
        throw new Error('MISSING_GENESIS_MUST_STOP_ASSET_READ');
      });

      await expectAssetCause(
        network.getAddressAssets(WALLET),
        'SOLANA_RPC_GENESIS_MISSING',
      );
      expect(assetReads).toEqual(0);
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects cluster drift after the finalized balance pair
     * @dependencies
     * - one valid balance and inventory pair followed by a changed genesis hash
     * - captured profile genesis hash
     * @scenario
     * - return the expected genesis before reads and a different genesis afterward
     * @expected
     * - reject instead of returning assets from a changed endpoint cluster
     */
    it('rejects cluster drift after the finalized balance pair', async () => {
      let genesisReads = 0;
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash') {
          genesisReads++;
          return genesisResponse(
            request,
            genesisReads === 1 ? TEST_GENESIS : OTHER_MINT,
          );
        }
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('900', '12'));
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(request, tokenAccountsResult('900', []));
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(
        network.getAddressAssets(WALLET),
        'SOLANA_RPC_GENESIS_MISMATCH',
      );
      expect(genesisReads).toEqual(2);
    });
  });
  describe('getTokenDetail failures', () => {
    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * rejects cluster drift after a mint account read
     * @dependencies
     * - one initialized original-program mint and a changed post-read genesis
     * - captured profile cluster identity
     * @scenario
     * - return the expected genesis before mint lookup and another valid genesis afterward
     * @expected
     * - do not return metadata from an endpoint that changed clusters mid-read
     */
    it('rejects cluster drift after a mint account read', async () => {
      let genesisReads = 0;
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash') {
          genesisReads++;
          return genesisResponse(
            request,
            genesisReads === 1 ? TEST_GENESIS : OTHER_MINT,
          );
        }
        if (request.method === 'getAccountInfo')
          return respondTo(request, mintResult('600', mintAccount()));
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(
        network.getTokenDetail(TOKEN_ID),
        'SOLANA_RPC_GENESIS_MISMATCH',
      );
      expect(genesisReads).toEqual(2);
    });

    /**
     * @target SolanaRpcNetwork.getTokenDetail
     * rejects %s mint data
     * @dependencies
     * - independently varied mint owner, encoding, byte length and initialized flag
     * - canonical original-SPL identity
     * @scenario
     * - query one malformed mint record at a time
     * @expected
     * - reject each record and do not expose a partial or unauthenticated token detail
     */
    it.each([
      [
        'Token-2022 owner',
        mintAccount(mintData(), EXTENDED_SPL_PROGRAM_ID),
        'SOLANA_ASSET_ACCOUNT_PROGRAM_OWNER_MISMATCH',
      ],
      [
        'uninitialized mint',
        mintAccount(mintData({ initialized: 0 })),
        'SOLANA_ASSET_MINT_UNINITIALIZED',
      ],
      [
        'invalid mint option',
        mintAccount(mintData({ mintOptionTag: 2 })),
        'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID',
      ],
      [
        'invalid base64',
        { ...mintAccount(), data: ['%%%=', 'base64'] },
        'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
      ],
      [
        'wrong byte length',
        {
          ...mintAccount(),
          data: [Buffer.alloc(81).toString('base64'), 'base64'],
        },
        'SOLANA_ASSET_ACCOUNT_DATA_INVALID',
      ],
    ])('rejects %s mint data', async (_label, account, cause) => {
      const { network, requests } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getAccountInfo')
          return respondTo(request, mintResult('600', account));
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(network.getTokenDetail(TOKEN_ID), cause);
      expect(requests.map(({ method }) => method)).toEqual([
        'getGenesisHash',
        'getAccountInfo',
      ]);
    });
  });
  describe('getAddressAssets amount boundaries', () => {
    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * preserves the maximum u64 and rejects the next value
     * @dependencies
     * - exact raw JSON numeric lexemes and finalized slot fixtures
     * - no JavaScript Number conversion in the assertion path
     * @scenario
     * - query the maximum representable native balance, then one above it
     * @expected
     * - preserve the maximum as bigint and reject the overflow
     */
    it('preserves the maximum u64 and rejects the next value', async () => {
      const maximum = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', U64_MAX.toString()));
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(request, tokenAccountsResult('500', []));
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });
      await expect(maximum.network.getAddressAssets(WALLET)).resolves.toEqual({
        nativeToken: U64_MAX,
        tokens: [],
      });

      const overflow = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(
            request,
            balanceResult('500', '18446744073709551616'),
          );
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(request, tokenAccountsResult('500', []));
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });
      await expectAssetCause(
        overflow.network.getAddressAssets(WALLET),
        'SOLANA_RPC_U64_OUT_OF_RANGE',
      );
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * rejects an aggregate SPL balance above u64
     * @dependencies
     * - two complete original-program accounts for the same mint
     * - one account at u64 maximum and a second account with one unit
     * @scenario
     * - return a valid matching finalized slot pair with an overflowing aggregate
     * @expected
     * - reject the inventory instead of wrapping the accumulated token balance
     */
    it('rejects an aggregate SPL balance above u64', async () => {
      const { network, requests } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', '1'));
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(
            request,
            tokenAccountsResult('500', [
              tokenAccountItem(
                ACCOUNT_A,
                tokenAccountData({ amount: U64_MAX }),
              ),
              tokenAccountItem(ACCOUNT_B, tokenAccountData({ amount: 1n })),
            ]),
          );
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expectAssetCause(
        network.getAddressAssets(WALLET),
        'SOLANA_ASSET_BALANCE_OUT_OF_RANGE',
      );
      expect(requests).toHaveLength(3);
    });

    /**
     * @target SolanaRpcNetwork.getAddressAssets
     * binds each returned token ID to its decoded mint and original program
     * @dependencies
     * - account data with a different canonical mint key and original account owner
     * - no token-map or endpoint calls beyond the mocked provider boundary
     * @scenario
     * - place a valid account record under an unrelated mint and confirm the returned identity is that mint
     * @expected
     * - preserve the mint-specific canonical ID so Guard cannot attribute it to another configured token
     */
    it('binds each returned token ID to its decoded mint and original program', async () => {
      const otherTokenId = getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash: TEST_GENESIS,
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint: OTHER_MINT,
      });
      const { network } = makeAssetReadNetwork((request) => {
        if (request.method === 'getGenesisHash')
          return genesisResponse(request);
        if (request.method === 'getBalance')
          return respondTo(request, balanceResult('500', '1'));
        if (request.method === 'getTokenAccountsByOwner')
          return respondTo(
            request,
            tokenAccountsResult('500', [
              tokenAccountItem(
                ACCOUNT_C,
                tokenAccountData({ mint: OTHER_MINT, amount: 19n }),
              ),
            ]),
          );
        throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
      });

      await expect(network.getAddressAssets(WALLET)).resolves.toEqual({
        nativeToken: 1n,
        tokens: [{ id: otherTokenId, value: 19n }],
      });
    });
  });
});
