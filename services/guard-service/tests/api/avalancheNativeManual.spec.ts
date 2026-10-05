import { JsonRpcProvider } from 'ethers';

import { DataSource } from '@rosen-bridge/extended-typeorm';
import { FastifyWithZod, makeFastify } from '@rosen-bridge/fastify-enhanced';
import { TokenMap } from '@rosen-bridge/tokens';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import { AvalancheRpcNetwork } from '@rosen-chains/avalanche-rpc';

import { signRoute } from '../../src/api/signTx';
import Configs from '../../src/configs/configs';
import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import DatabaseHandler from '../../src/db/databaseHandler';
import ChainHandler from '../../src/handlers/chainHandler';
import * as ScannerStartup from '../../src/jobs/initScanner';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import { chainHandlerInstance } from '../handlers/chainHandler.mock';
import { config, contracts } from '../utils/avalancheChainTestUtils';

/** Unsigned native fixture, passed through the installed package's actual parser. */
const envelope = () => ({
  type: 2,
  chainId: 43113,
  nonce: 0,
  to: '0x' + '44'.repeat(20),
  value: '1000',
  gasLimit: '21000',
  maxFeePerGas: '20',
  maxPriorityFeePerGas: '2',
  data: '0x',
  accessList: [],
});
describe('installed native Avalanche manual API decoder', () => {
  let server: FastifyWithZod,
    network: AvalancheRpcNetwork,
    chain: AvalancheChain;
  const originalManual = Configs.isManualTxRequestActive;
  beforeEach(async () => {
    const captured = GuardsAvalancheConfigs.read(
      reader({
        ...valid,
        'avalanche.routes': { cold: false, manual: true, arbitrary: false },
      }),
    )!;
    vi.spyOn(ScannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
      config: captured,
      contracts: contracts(),
    });
    Configs.isManualTxRequestActive = true;
    vi.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(
      new Error('Unexpected live RPC'),
    );
    network = new AvalancheRpcNetwork(
      'http://127.0.0.1:1',
      { getRepository: () => ({ find: vi.fn() }) } as unknown as DataSource,
      contracts().addresses.lock,
      43113n,
      'synthetic-lock-extractor',
      1000,
    );
    vi.spyOn(network, 'assertNetwork').mockResolvedValue();
    chain = new AvalancheChain(
      network,
      GuardsAvalancheConfigs.createChainConfigs(config(), contracts()),
      new TokenMap(),
      {
        sign: vi.fn().mockRejectedValue(new Error('Unexpected signer')),
        isInSign: vi.fn(),
      },
    );
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue(
      chainHandlerInstance as unknown as ChainHandler,
    );
    vi.spyOn(chainHandlerInstance, 'getChain').mockReturnValue(chain);
    server = await makeFastify();
    await server.register(signRoute);
  });
  afterEach(async () => {
    await server.close();
    network['provider'].destroy();
    vi.restoreAllMocks();
    Configs.isManualTxRequestActive = originalManual;
  });
  const request = (txJson: string) =>
    server.inject({
      method: 'POST',
      url: '/sign',
      body: { chain: 'avalanche', txJson, requiredSign: 3 },
      headers: { 'Api-Key': 'hello' },
    });
  /**
   * @target signRoute accepts the actual unsigned native envelope
   * @dependencies Actual public chain/network constructors and parser, inert network identity and insertion port.
   * @scenario Submit one unsigned native type-2 envelope on the captured chain.
   * @expected Insert its exact manual payment object after identity check, with no signing or transport.
   */
  it('accepts the actual unsigned native envelope', async () => {
    const insert = vi
      .spyOn(DatabaseHandler, 'insertTx')
      .mockResolvedValue(undefined);
    const result = await request(JSON.stringify(envelope()));
    expect(result.statusCode).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    const payment = insert.mock.calls[0][0];
    expect(payment.network).toBe('avalanche');
    expect(payment.txType).toBe(TransactionType.manual);
    expect(payment.eventId).toBe('');
    expect(chain.verifyTransactionExtraConditions(payment)).toBe(true);
    expect(network.assertNetwork).toHaveBeenCalledTimes(1);
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
  /**
   * @target signRoute refuses $name
   * @dependencies Actual installed native decoder and real HTTP route with insertion/transport spies.
   * @scenario Change exactly one envelope field or serialized shape.
   * @expected Return 400 with no insertion, signing or transport.
   */
  it.each([
    { name: 'wrong chain', patch: { chainId: 1 } },
    { name: 'wrong type', patch: { type: 1 } },
    { name: 'token calldata', patch: { data: '0xa9059cbb' + '11'.repeat(64) } },
    { name: 'zero recipient', patch: { to: '0x' + '00'.repeat(20) } },
    { name: 'contract creation', patch: { to: null } },
    { name: 'zero value', patch: { value: '0' } },
    { name: 'negative value', patch: { value: '-1' } },
    { name: 'gas above cap', patch: { gasLimit: '100001' } },
    {
      name: 'nonempty access list',
      patch: {
        accessList: [{ address: '0x' + '55'.repeat(20), storageKeys: [] }],
      },
    },
    {
      name: 'signed envelope',
      patch: {
        signature: {
          r: '0x' + '11'.repeat(32),
          s: '0x' + '22'.repeat(32),
          v: 27,
        },
      },
    },
  ])('refuses $name', async ({ patch }) => {
    const insert = vi.spyOn(DatabaseHandler, 'insertTx');
    const result = await request(JSON.stringify({ ...envelope(), ...patch }));
    expect(result.statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
  /**
   * @target signRoute refuses malformed serialized input
   * @dependencies Installed native parser, actual route and insertion spy.
   * @scenario Supply one malformed JSON input.
   * @expected Return 400 before inserting a transaction.
   */
  it('refuses malformed serialized input', async () => {
    const insert = vi.spyOn(DatabaseHandler, 'insertTx');
    expect((await request('{')).statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
    expect(JsonRpcProvider.prototype.send).not.toHaveBeenCalled();
  });
});
