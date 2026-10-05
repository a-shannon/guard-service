import { TokenMap } from '@rosen-bridge/tokens';
import { TransactionFormatError } from '@rosen-chains/abstract-chain';

import { captureAvalancheAssets } from '../lib/avalancheAssets';
import {
  erc20Mapping,
  joe,
  assetMappingFaults,
  applyAssetMappingFault,
} from './avalancheErc20TestData';

describe('captureAvalancheAssets', () => {
  describe('mapping validation', () => {
    /**
     * @target captureAvalancheAssets rejects an isolated ownership fault %s
     * @dependencies Real TokenMap and reusable synthetic authority fixtures.
     * @scenario Change one counterpart type, residency, origin count or individual identity.
     * @expected TransactionFormatError before any balance, signing or payment consumer.
     */
    it.each(assetMappingFaults)(
      'rejects an isolated ownership fault %s',
      async (fault) => {
        const mapping = structuredClone(erc20Mapping);
        applyAssetMappingFault(mapping, fault);
        const tokens = new TokenMap();
        await tokens.updateConfigByJson(mapping);
        expect(() => captureAvalancheAssets(tokens)).toThrow(
          TransactionFormatError,
        );
      },
    );
    /**
     * @target captureAvalancheAssets rejects malformed or ambiguous token mappings %s
     * @dependencies Real TokenMap with synthetic bridge mappings.
     * @scenario Change one mapping field, capture the authoritative policy.
     * @expected Reject with TransactionFormatError before token payment use.
     */
    it.each([
      'address',
      'zero',
      'type',
      'residency',
      'ergo',
      'decimals',
      'duplicate',
      'collision',
    ])('rejects malformed or ambiguous token mappings %s', async (kind) => {
      const mapping = structuredClone(erc20Mapping);
      const token = mapping[1].avalanche;
      if (kind === 'address') token.tokenId = 'unsupported';
      if (kind === 'zero') token.tokenId = '0x' + '00'.repeat(20);
      if (kind === 'type') token.type = 'native';
      if (kind === 'residency')
        token.residency = 'invalid' as typeof token.residency;
      if (kind === 'ergo') mapping[1].ergo.tokenId = '00'.repeat(32);
      if (kind === 'decimals') token.decimals = 256;
      if (kind === 'duplicate') mapping.push(structuredClone(mapping[1]));
      if (kind === 'collision') mapping[0].ergo.tokenId = joe;
      const tokens = new TokenMap();
      await tokens.updateConfigByJson(mapping);
      expect(() => captureAvalancheAssets(tokens)).toThrow(
        TransactionFormatError,
      );
    });
  });
  describe('unit conversion', () => {
    /**
     * @target captureAvalancheAssets accepts declared historical token type aliases
     * @dependencies Real TokenMap; canonical fixture mapping with both token labels changed.
     * @scenario Replace ERC-20 and EIP-004 with their supported historical token alias.
     * @expected Preserve the same validated contract and decimal scale.
     */
    it('accepts declared historical token type aliases', async () => {
      const source = structuredClone(erc20Mapping);
      source[1].avalanche.type = 'token';
      source[1].ergo.type = 'token';
      source[0].ergo.type = 'token';
      const tokens = new TokenMap();
      await tokens.updateConfigByJson(source);
      expect(captureAvalancheAssets(tokens).unwrap(joe, 10n)).toEqual(
        10n ** 10n,
      );
    });
    /**
     * @target captureAvalancheAssets preserves exact mapped units and rejects unknown identities
     * @dependencies Real TokenMap and frozen nine-decimal mappings.
     * @scenario Convert JOE requirements and fractional available balances; attempt an unknown ID.
     * @expected Exact uint256 arithmetic, downward availability rounding and fail-closed unknown ID.
     */
    it('preserves exact mapped units and rejects unknown identities', async () => {
      const tokens = new TokenMap();
      await tokens.updateConfigByJson(structuredClone(erc20Mapping));
      const policy = captureAvalancheAssets(tokens);
      expect(policy.unwrap(joe, 10n)).toEqual(10n ** 10n);
      expect(policy.available(joe, 10n ** 10n - 1n)).toEqual(9n);
      expect(() => policy.unwrap('unknown', 1n)).toThrow(
        TransactionFormatError,
      );
      expect(() => policy.unwrap(joe, 1n << 256n)).toThrow(
        TransactionFormatError,
      );
    });
  });
});
