import { Transaction } from 'ergo-lib-wasm-nodejs';
import { createServer, Server } from 'node:http';

import ErgoExplorerNetwork from '../../lib/ergoExplorerNetwork';
import { testTransactionBytes } from '../testData';

/**
 * Creates an explorer network over the fixture endpoint.
 */
export const getNetwork = () =>
  new ErgoExplorerNetwork({
    explorerBaseUrl: 'https://test.explorer',
  });

/**
 * Creates transaction and loopback-response builders for one describe fixture scope.
 * The caller receives every server immediately and retains its afterEach custody.
 */
export const createAuthorizedSubmissionFixtures = (
  onServer: (server: Server) => void,
) => {
  /**
   * Capture loopback POST bodies, paths and authorization headers for one server.
   */
  const listen = async (status = 200) => {
    const bodies: string[] = [],
      paths: string[] = [],
      auth: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      auth.push(req.headers.authorization);
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{"id":"txid"}');
      });
    });
    onServer(server);
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    return {
      url: `http://fixture:password@127.0.0.1:${address.port}/prefix`,
      bodies,
      paths,
      auth,
    };
  };
  /**
   * Decode a fresh signed transaction from the pinned explorer fixture bytes.
   */
  const tx = () =>
    Transaction.sigma_parse_bytes(Buffer.from(testTransactionBytes, 'hex'));
  return { listen, tx };
};
