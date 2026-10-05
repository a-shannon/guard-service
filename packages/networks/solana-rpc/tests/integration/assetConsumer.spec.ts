import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_A, OTHER_MINT, WALLET } from '../assetReadTestData';
import { tokenAccountData, tokenAccountItem } from '../assetReadTestUtils';
import {
  CONSUMER_TOKEN_ID,
  createAssetConsumer,
} from './assetConsumerTestUtils';

describe('AbstractChain', () => {
  describe('getLockAddressAssets', () => {
    /**
     * @target AbstractChain.getLockAddressAssets
     * wraps raw provider balances exactly once at the Guard consumer
     * @dependencies loopback HTTP, original SPL bytes and real TokenMap
     * @scenario read SOL and two SPL accounts with different source/Ergo precisions
     * @expected preserve raw provider totals and wrap each selected asset once
     */
    it('wraps raw provider balances exactly once at the Guard consumer', async () => {
      const fixture = await createAssetConsumer();
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(fixture.chain.getLockAddressAssets()).resolves.toEqual({
          nativeToken: 10_000_001n,
          tokens: [{ id: CONSUMER_TOKEN_ID, value: 14n }],
        });
        expect(wrap.mock.calls).toEqual([
          ['sol', 1_000_000_001n, 'solana'],
          [CONSUMER_TOKEN_ID, 13_023n, 'solana'],
        ]);
        await expect(fixture.network.getAddressAssets(WALLET)).resolves.toEqual(
          {
            nativeToken: 1_000_000_001n,
            tokens: [{ id: CONSUMER_TOKEN_ID, value: 13_023n }],
          },
        );
        expect(fixture.requests[1].params[0]).toEqual(WALLET);
      } finally {
        await fixture.close();
      }
    });

    /**
     * @target AbstractChain.getLockAddressAssets
     * filters tokens before wrapping selected Guard balances
     * @dependencies real provider and TokenMap over loopback HTTP
     * @scenario request an empty SPL selection
     * @expected wrap native SOL and omit all unselected SPL units
     */
    it('filters tokens before wrapping selected Guard balances', async () => {
      const fixture = await createAssetConsumer();
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(fixture.chain.getLockAddressAssets([])).resolves.toEqual({
          nativeToken: 10_000_001n,
          tokens: [],
        });
        expect(wrap.mock.calls).toEqual([['sol', 1_000_000_001n, 'solana']]);
      } finally {
        await fixture.close();
      }
    });

    /**
     * @target AbstractChain.getLockAddressAssets
     * propagates endpoint identity failure before Guard wraps assets
     * @dependencies loopback endpoint and unchanged expected profile
     * @scenario report another valid cluster before reading balances
     * @expected propagate rejection before wrapping or returning a fallback
     */
    it('propagates endpoint identity failure before Guard wraps assets', async () => {
      const fixture = await createAssetConsumer({ genesis: OTHER_MINT });
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(
          fixture.chain.getLockAddressAssets(),
        ).rejects.toMatchObject({
          message: 'SOLANA_REQUEST_UNAVAILABLE',
          cause: { message: 'SOLANA_RPC_GENESIS_MISMATCH' },
        });
        expect(wrap).not.toHaveBeenCalled();
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          'getGenesisHash',
        ]);
      } finally {
        await fixture.close();
      }
    });

    /**
     * @target AbstractChain.getLockAddressAssets
     * rejects malformed frozen inventory without returning a partial Guard balance
     * @dependencies frozen original-SPL record with one invalid delegate tag
     * @scenario read an ordinary SOL balance and the malformed excluded account
     * @expected reject the full inventory before wrapping any asset
     */
    it('rejects malformed frozen inventory without returning a partial Guard balance', async () => {
      const fixture = await createAssetConsumer({
        accounts: [
          tokenAccountItem(
            ACCOUNT_A,
            tokenAccountData({ state: 2, delegateTag: 2 }),
          ),
        ],
      });
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(
          fixture.chain.getLockAddressAssets(),
        ).rejects.toMatchObject({
          message: 'SOLANA_REQUEST_UNAVAILABLE',
          cause: { message: 'SOLANA_ASSET_ACCOUNT_OPTION_TAG_INVALID' },
        });
        expect(wrap).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });
  });
  describe('hasLockAddressEnoughAssets', () => {
    /**
     * @target AbstractChain.hasLockAddressEnoughAssets
     * decides payment coverage for %s
     * @dependencies
     * - default HTTP provider, real TokenMap and AbstractChain subtraction
     * - synthetic native and original SPL account records
     * @scenario
     * - require exact SPL with one native unit left, then reach or exceed each bound
     * - require an absent token without changing the native requirement
     * @expected
     * - require a positive native remainder under Guard's existing subtraction contract
     * - accept exact SPL equality and reject each independently insufficient asset
     * - pass raw provider totals through the real wrapping function once
     */
    it.each([
      [
        'exact SPL with native remainder',
        10_000_000n,
        CONSUMER_TOKEN_ID,
        14n,
        true,
      ],
      ['no native remainder', 10_000_001n, CONSUMER_TOKEN_ID, 14n, false],
      ['one extra native unit', 10_000_002n, CONSUMER_TOKEN_ID, 14n, false],
      ['one extra token unit', 10_000_000n, CONSUMER_TOKEN_ID, 15n, false],
      ['absent token', 10_000_000n, 'fixture-absent-token', 1n, false],
    ] as const)(
      'decides payment coverage for %s',
      async (_label, nativeToken, tokenId, tokenValue, enough) => {
        const fixture = await createAssetConsumer();
        try {
          const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
          await expect(
            fixture.chain.hasLockAddressEnoughAssets({
              nativeToken,
              tokens: [{ id: tokenId, value: tokenValue }],
            }),
          ).resolves.toEqual(enough);
          expect(wrap.mock.calls).toEqual(
            tokenId === CONSUMER_TOKEN_ID
              ? [
                  ['sol', 1_000_000_001n, 'solana'],
                  [CONSUMER_TOKEN_ID, 13_023n, 'solana'],
                ]
              : [['sol', 1_000_000_001n, 'solana']],
          );
        } finally {
          await fixture.close();
        }
      },
    );

    /**
     * @target AbstractChain.hasLockAddressEnoughAssets
     * propagates provider failure from the payment coverage predicate
     * @dependencies
     * - default HTTP provider and real Guard asset predicate
     * - endpoint reporting a different cluster
     * @scenario
     * - ask whether a zero-value payment is covered by the lock address
     * @expected
     * - reject before wrapping; never report an available inventory or false balance
     */
    it('propagates provider failure from the payment coverage predicate', async () => {
      const fixture = await createAssetConsumer({ genesis: OTHER_MINT });
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(
          fixture.chain.hasLockAddressEnoughAssets({
            nativeToken: 0n,
            tokens: [],
          }),
        ).rejects.toMatchObject({
          message: 'SOLANA_REQUEST_UNAVAILABLE',
          cause: { message: 'SOLANA_RPC_GENESIS_MISMATCH' },
        });
        expect(wrap).not.toHaveBeenCalled();
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });

    /**
     * @target AbstractChain.hasLockAddressEnoughAssets
     * does not count valid frozen tokens toward payment coverage
     * @dependencies
     * - fully valid frozen original SPL account holding a positive amount
     * - default provider, real TokenMap and Guard subtraction
     * @scenario
     * - require one wrapped unit of the frozen token
     * @expected
     * - report insufficient inventory and never wrap the frozen amount
     */
    it('does not count valid frozen tokens toward payment coverage', async () => {
      const fixture = await createAssetConsumer({
        accounts: [
          tokenAccountItem(
            ACCOUNT_A,
            tokenAccountData({ state: 2, amount: 13_023n }),
          ),
        ],
      });
      try {
        const wrap = vi.spyOn(fixture.tokens, 'wrapAmount');
        await expect(
          fixture.chain.hasLockAddressEnoughAssets({
            nativeToken: 0n,
            tokens: [{ id: CONSUMER_TOKEN_ID, value: 1n }],
          }),
        ).resolves.toEqual(false);
        expect(wrap.mock.calls).toEqual([['sol', 1_000_000_001n, 'solana']]);
      } finally {
        await fixture.close();
      }
    });
  });
});
