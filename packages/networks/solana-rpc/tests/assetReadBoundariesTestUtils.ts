import { ACCOUNT_A } from './assetReadTestData';
import {
  balanceResult,
  genesisResponse,
  makeAssetReadNetwork,
  mintAccount,
  rpcResponse,
  tokenAccountData,
  tokenAccountItem,
} from './assetReadTestUtils';

/** Generate an initialized original-program account as the unchanged fixture baseline. */
export const validBoundaryItem = tokenAccountItem(
  ACCOUNT_A,
  tokenAccountData({ amount: 1n }),
);

/** Script one inventory response without changing its JSON field shapes. */
export const inventoryNetwork = (resultJson: string) =>
  makeAssetReadNetwork((request) => {
    if (request.method === 'getGenesisHash') return genesisResponse(request);
    if (request.method === 'getBalance')
      return rpcResponse(request, balanceResult('500', '1'));
    if (request.method === 'getTokenAccountsByOwner')
      return rpcResponse(request, resultJson);
    throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
  });

/** Script one mint response without replacing the provider or decoder. */
export const mintNetwork = (resultJson: string) =>
  makeAssetReadNetwork((request) => {
    if (request.method === 'getGenesisHash') return genesisResponse(request);
    if (request.method === 'getAccountInfo')
      return rpcResponse(request, resultJson);
    throw new Error(`UNEXPECTED_RPC_METHOD:${request.method}`);
  });

/** Replace only the selected response's finalized context, preserving its value. */
export const contextNetwork = (
  method: 'getBalance' | 'getTokenAccountsByOwner' | 'getAccountInfo',
  context: string | undefined,
) =>
  makeAssetReadNetwork((request) => {
    if (request.method === 'getGenesisHash') return genesisResponse(request);
    const value =
      request.method === 'getBalance'
        ? '1'
        : request.method === 'getTokenAccountsByOwner'
          ? '[]'
          : JSON.stringify(mintAccount());
    const selectedContext =
      request.method === method ? context : '{"slot":500}';
    const prefix =
      selectedContext === undefined ? '' : `"context":${selectedContext},`;
    return rpcResponse(request, `{${prefix}"value":${value}}`);
  });
