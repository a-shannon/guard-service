import { FeeData, FetchRequest, Transaction } from 'ethers';
import { createServer } from 'node:http';

import {
  AvalancheRpcNetwork as ScannerNetwork,
  AvalancheRpcScanner,
} from '@rosen-bridge/evm-scanner';
import { TransactionType } from '@rosen-chains/abstract-chain';

import ChainHandler from '../../src/handlers/chainHandler';
import { NotificationHandler } from '../../src/handlers/notificationHandler';
import PublicStatusHandler from '../../src/handlers/publicStatusHandler';
import * as scannerStartup from '../../src/jobs/initScanner';
import { createGuardSigningRuntime } from '../../src/signing/signingRuntime';
import TransactionProcessor from '../../src/transaction/transactionProcessor';
import { chainHandlerInstance } from '../handlers/chainHandler.mock';
import { contracts } from '../utils/avalancheChainTestUtils';
import { createManagementExecutionFixture } from '../verification/avalancheManagementExecutionAuthorizationTestUtils';

/** Joins the actual Guard runtime, scanner, DAO and qualified loopback transport. */
export const createManagementProcessorFixture = async (
  type = TransactionType.coldStorage,
  unsigned = false,
  token = false,
) => {
  const f = await createManagementExecutionFixture(type, unsigned, token);
  f.fee.mockRestore();
  vi.spyOn(f.network, 'assertNetwork').mockResolvedValue(undefined);
  vi.spyOn(f.network, 'getGasRequired').mockResolvedValue(21000n);
  vi.spyOn(f.network, 'getFeeData').mockResolvedValue(
    new FeeData(null, 20000000000n, 2000000000n),
  );
  vi.spyOn(f.network, 'getAddressBalanceForNativeToken').mockImplementation(
    async () => f.cold.locked.nativeToken * 1000000000n,
  );
  vi.spyOn(f.network, 'getAddressBalanceForERC20Asset').mockImplementation(
    async (_address, id) =>
      (f.cold.locked.tokens.find((asset) => asset.id === id)?.value ?? 0n) *
      1000000000n,
  );
  const scannerNetwork = new ScannerNetwork(
    'http://127.0.0.1:1',
    f.chain.CHAIN_ID,
  );
  vi.spyOn(scannerNetwork, 'getCurrentHeight').mockResolvedValue(2);
  vi.spyOn(scannerNetwork, 'getBlockAtHeight').mockImplementation(
    async (height) => ({
      hash: '0x' + height.toString(16).padStart(64, '0'),
      height,
      parentHash: '0x' + (height - 1).toString(16).padStart(64, '0'),
      timestamp: 100 + height,
      txCount: 0,
    }),
  );
  vi.spyOn(scannerNetwork, 'getBlockTxs').mockResolvedValue([]);
  const scanner = new AvalancheRpcScanner({
    network: scannerNetwork,
    dataSource: f.database.dataSource,
    sourceId: 'synthetic-processor-source',
    initialHeight: 0,
    blockCleanupConfig: {
      blockCleanupThresholdDuration: 86400,
      blockTrimCountInRound: 0,
    },
  });
  await scanner.update();
  const runtime = createGuardSigningRuntime({
    getEvent: async () => null,
    getTx: (id) => f.database.getTxById(id),
    decode: (json) => f.chain.PaymentTransactionFromJson(json),
    getScanner: () => scanner,
    management: f.policy,
    curveTimeoutSeconds: 1,
    edwardTimeoutSeconds: 1,
    ergoTimeoutSeconds: 1,
    maxPending: 2,
  });
  TransactionProcessor.initSigning(runtime.context, runtime.processor);
  vi.spyOn(ChainHandler, 'getInstance').mockReturnValue(
    chainHandlerInstance as unknown as ChainHandler,
  );
  vi.spyOn(chainHandlerInstance, 'getChain').mockImplementation((network) => {
    if (network !== 'avalanche') throw new Error('Unexpected processor route');
    return f.chain;
  });
  vi.spyOn(scannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
    contracts: contracts(),
    config: {
      ...f.getPolicy().config,
      rpc: { ...f.getPolicy().config.rpc, timeout: 1 },
    },
  });
  vi.spyOn(
    PublicStatusHandler.getInstance(),
    'updatePublicTxStatus',
  ).mockResolvedValue(undefined);
  const notify = vi
    .spyOn(NotificationHandler.setup(), 'notify')
    .mockResolvedValue(undefined);
  const legacy = vi.spyOn(f.chain, 'submitTransaction');
  const requests: { method: string; params: string[] }[] = [];
  const exclusion: Promise<void>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body);
      requests.push(message);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: Transaction.from(message.params[0]).hash,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing synthetic listener');
  const connection = new FetchRequest(`http://127.0.0.1:${address.port}/rpc`);
  connection.timeout = 1000;
  const dispatch = connection.getUrlFunc;
  connection.getUrlFunc = (request, signal) => {
    const check = scanner.update().then(
      () => {
        throw new Error('Transport started without scanner exclusion');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('already running');
      },
    );
    void check.catch(() => undefined);
    exclusion.push(check);
    return dispatch(request, signal);
  };
  vi.spyOn(f.network['provider'], '_getConnection').mockImplementation(() =>
    connection.clone(),
  );
  return {
    ...f,
    scanner,
    runtime,
    legacy,
    requests,
    notify,
    close: async () => {
      await Promise.all(exclusion);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      scannerNetwork['provider'].destroy();
      f.close();
    },
  };
};
