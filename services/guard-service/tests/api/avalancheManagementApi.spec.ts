import { FastifyWithZod, makeFastify } from '@rosen-bridge/fastify-enhanced';
import {
  ChainUtils,
  AbstractChain,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { arbitraryOrderRoute } from '../../src/api/arbitrary';
import { signRoute } from '../../src/api/signTx';
import Configs from '../../src/configs/configs';
import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import DatabaseHandler from '../../src/db/databaseHandler';
import ChainHandler from '../../src/handlers/chainHandler';
import * as ScannerStartup from '../../src/jobs/initScanner';
import { mockPaymentTransaction } from '../agreement/testData';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import { routePolicies } from '../configs/avalancheManagementRoutesTestData';
import { chainHandlerInstance } from '../handlers/chainHandler.mock';
import { contracts } from '../utils/avalancheChainTestUtils';

describe('Avalanche management HTTP gates', () => {
  let server: FastifyWithZod;
  const previousManual = Configs.isManualTxRequestActive,
    previousArbitrary = Configs.isArbitraryOrderRequestActive;
  const nativeOrder = () => [
    {
      address: '0x' + '33'.repeat(20),
      assets: { nativeToken: 123n, tokens: [] },
    },
  ];
  const prepare = (routes: {
    cold: boolean;
    manual: boolean;
    arbitrary: boolean;
  }) => {
    const config = GuardsAvalancheConfigs.read(
      reader({ ...valid, 'avalanche.routes': routes }),
    )!;
    vi.spyOn(ScannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
      config,
      contracts: contracts(),
    });
  };
  const sign = (requiredSign: unknown = 3, key: string | null = 'hello') =>
    server.inject({
      method: 'POST',
      url: '/sign',
      headers: key === null ? {} : { 'Api-Key': key },
      body: {
        chain: 'avalanche',
        txJson: 'synthetic native envelope',
        requiredSign,
      },
    });
  const order = (
    orderJson = ChainUtils.encodeOrder(nativeOrder()),
    id = '11'.repeat(32),
    key: string | null = 'hello',
  ) =>
    server.inject({
      method: 'POST',
      url: '/order',
      headers: key === null ? {} : { 'Api-Key': key },
      body: { chain: 'avalanche', orderJson, id },
    });
  beforeEach(async () => {
    vi.spyOn(ChainHandler, 'getInstance').mockReturnValue(
      chainHandlerInstance as unknown as ChainHandler,
    );
    Configs.isManualTxRequestActive = true;
    Configs.isArbitraryOrderRequestActive = true;
    server = await makeFastify();
    await server.register(signRoute);
    await server.register(arbitraryOrderRoute);
  });
  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
    Configs.isManualTxRequestActive = previousManual;
    Configs.isArbitraryOrderRequestActive = previousArbitrary;
  });
  /**
   * @target signRoute manual gate cold=$cold manual=$manual arbitrary=$arbitrary
   * @dependencies Real HTTP/schema/auth gates; inert native decoder and DB insertion port.
   * @scenario Exercise all route combinations using an authenticated request.
   * @expected Only manual=true reaches the chain decoder and transaction insertion.
   */
  it.each(routePolicies)(
    'manual gate cold=$cold manual=$manual arbitrary=$arbitrary',
    async (routes) => {
      prepare(routes);
      const tx = mockPaymentTransaction(
        TransactionType.manual,
        'avalanche',
        '',
      );
      const decode = vi.fn().mockResolvedValue(tx);
      vi.spyOn(chainHandlerInstance, 'getChain').mockReturnValue({
        rawTxToPaymentTransaction: decode,
      } as unknown as AbstractChain<unknown>);
      const insert = vi
        .spyOn(DatabaseHandler, 'insertTx')
        .mockResolvedValue(undefined);
      const result = await sign();
      expect(result.statusCode).toBe(routes.manual ? 200 : 400);
      expect(decode).toHaveBeenCalledTimes(routes.manual ? 1 : 0);
      expect(insert).toHaveBeenCalledTimes(routes.manual ? 1 : 0);
      if (routes.manual) {
        expect(decode).toHaveBeenCalledWith('synthetic native envelope');
        expect(insert).toHaveBeenCalledWith(tx, 3, undefined);
      }
    },
  );
  /**
   * @target arbitraryOrderRoute arbitrary gate cold=$cold manual=$manual arbitrary=$arbitrary
   * @dependencies Real HTTP/schema/auth and order codec; inert DB insertion port.
   * @scenario Exercise every independent route combination with a native order.
   * @expected Only arbitrary=true inserts canonical native order bytes.
   */
  it.each(routePolicies)(
    'arbitrary gate cold=$cold manual=$manual arbitrary=$arbitrary',
    async (routes) => {
      prepare(routes);
      const insert = vi
        .spyOn(DatabaseHandler, 'insertOrder')
        .mockResolvedValue(undefined);
      const result = await order();
      expect(result.statusCode).toBe(routes.arbitrary ? 200 : 400);
      expect(insert).toHaveBeenCalledTimes(routes.arbitrary ? 1 : 0);
      if (routes.arbitrary)
        expect(insert).toHaveBeenCalledWith(
          '11'.repeat(32),
          'avalanche',
          ChainUtils.encodeOrder(nativeOrder()),
        );
    },
  );
  /**
   * @target arbitraryOrderRoute normalizes a valid checksum recipient to the native extractor spelling
   * @dependencies Actual order codec and HTTP validation; insertion spy.
   * @scenario Supply a valid checksum EVM recipient.
   * @expected Store its lowercase spelling to match the native extractor.
   */
  it('normalizes a valid checksum recipient to the native extractor spelling', async () => {
    prepare({ cold: false, manual: false, arbitrary: true });
    const input = nativeOrder();
    input[0].address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
    const insert = vi
      .spyOn(DatabaseHandler, 'insertOrder')
      .mockResolvedValue(undefined);
    const result = await order(ChainUtils.encodeOrder(input));
    input[0].address = input[0].address.toLowerCase();
    expect(result.statusCode).toBe(200);
    expect(insert).toHaveBeenCalledExactlyOnceWith(
      '11'.repeat(32),
      'avalanche',
      ChainUtils.encodeOrder(input),
    );
  });
  /**
   * @target signRoute, arbitraryOrderRoute refuses unauthorized API key %s
   * @dependencies Real API-key prehandler; transaction/order insertion spies.
   * @scenario Omit or falsify the API key for both endpoints.
   * @expected Return 403 without decoding or DB writes.
   */
  it.each([null, '', 'incorrect'])(
    'refuses unauthorized API key %s',
    async (key) => {
      prepare({ cold: true, manual: true, arbitrary: true });
      const tx = vi.spyOn(DatabaseHandler, 'insertTx'),
        orders = vi.spyOn(DatabaseHandler, 'insertOrder');
      const chain = vi.spyOn(chainHandlerInstance, 'getChain');
      expect((await sign(3, key)).statusCode).toBe(403);
      expect((await order(undefined, undefined, key)).statusCode).toBe(403);
      expect(tx).not.toHaveBeenCalled();
      expect(orders).not.toHaveBeenCalled();
      expect(chain).not.toHaveBeenCalled();
    },
  );
  /**
   * @target signRoute refuses requiredSign %s
   * @dependencies Real schema and route; chain/DB spies.
   * @scenario Change only requiredSign to an invalid numeric boundary.
   * @expected Refuse before chain decoding or DB insertion.
   */
  it.each([-1, 0, 1.1, 6, Number.MAX_SAFE_INTEGER + 1, 'NaN', 'Infinity'])(
    'refuses requiredSign %s',
    async (requiredSign) => {
      prepare({ cold: false, manual: true, arbitrary: false });
      const chain = vi.spyOn(chainHandlerInstance, 'getChain'),
        insert = vi.spyOn(DatabaseHandler, 'insertTx');
      expect((await sign(requiredSign)).statusCode).toBe(400);
      expect(chain).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );
  /**
   * @target signRoute preserves allowed requiredSign %s
   * @dependencies Real schema and route; inert validated-native decoder and insertion port.
   * @scenario Request each exact guard-count boundary.
   * @expected Insert the decoder result with the exact supplied count.
   */
  it.each([1, 5])('preserves allowed requiredSign %s', async (requiredSign) => {
    prepare({ cold: false, manual: true, arbitrary: false });
    const tx = mockPaymentTransaction(TransactionType.manual, 'avalanche', '');
    vi.spyOn(chainHandlerInstance, 'getChain').mockReturnValue({
      rawTxToPaymentTransaction: vi.fn().mockResolvedValue(tx),
    } as unknown as AbstractChain<unknown>);
    const insert = vi
      .spyOn(DatabaseHandler, 'insertTx')
      .mockResolvedValue(undefined);
    expect((await sign(requiredSign)).statusCode).toBe(200);
    expect(insert).toHaveBeenCalledWith(tx, requiredSign, undefined);
  });
  /**
   * @target signRoute does not insert when chain decoding refuses a nonnative envelope
   * @dependencies Real route; refusing chain decoder and insertion spy.
   * @scenario Pass a synthetic nonnative envelope to a refusing decoder.
   * @expected Return 400 and do not insert any transaction.
   */
  it('does not insert when chain decoding refuses a nonnative envelope', async () => {
    prepare({ cold: false, manual: true, arbitrary: false });
    vi.spyOn(chainHandlerInstance, 'getChain').mockReturnValue({
      rawTxToPaymentTransaction: vi
        .fn()
        .mockRejectedValue(new Error('Invalid native Avalanche envelope')),
    } as unknown as AbstractChain<unknown>);
    const insert = vi.spyOn(DatabaseHandler, 'insertTx');
    expect((await sign()).statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
  /**
   * @target arbitraryOrderRoute refuses $name order
   * @dependencies Real HTTP route and order decoder; insertion spy.
   * @scenario Change exactly one native order boundary.
   * @expected Refuse without DB insertion.
   */
  it.each([
    { name: 'empty', order: [] },
    { name: 'multiple', order: [...nativeOrder(), ...nativeOrder()] },
    {
      name: 'zero recipient',
      order: [{ ...nativeOrder()[0], address: '0x' + '00'.repeat(20) }],
    },
    {
      name: 'short recipient',
      order: [{ ...nativeOrder()[0], address: '0x1234' }],
    },
    {
      name: 'other-network recipient',
      order: [{ ...nativeOrder()[0], address: 'synthetic-ergo-address' }],
    },
    {
      name: 'zero native',
      order: [{ ...nativeOrder()[0], assets: { nativeToken: 0n, tokens: [] } }],
    },
    {
      name: 'negative native',
      order: [
        { ...nativeOrder()[0], assets: { nativeToken: -1n, tokens: [] } },
      ],
    },
    {
      name: 'token transfer',
      order: [
        {
          ...nativeOrder()[0],
          assets: {
            nativeToken: 123n,
            tokens: [{ id: '22'.repeat(32), value: 1n }],
          },
        },
      ],
    },
  ])('refuses $name order', async ({ order: invalid }) => {
    prepare({ cold: false, manual: false, arbitrary: true });
    const insert = vi.spyOn(DatabaseHandler, 'insertOrder');
    expect((await order(ChainUtils.encodeOrder(invalid))).statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
  /**
   * @target arbitraryOrderRoute refuses noncanonical id %s
   * @dependencies Real HTTP route and insertion spy.
   * @scenario Change only the identifier spelling or width.
   * @expected Refuse before DB insertion.
   */
  it.each(['AA'.repeat(32), '1'.repeat(63), 'g'.repeat(64)])(
    'refuses noncanonical id %s',
    async (id) => {
      prepare({ cold: false, manual: false, arbitrary: true });
      const insert = vi.spyOn(DatabaseHandler, 'insertOrder');
      expect((await order(undefined, id)).statusCode).toBe(400);
      expect(insert).not.toHaveBeenCalled();
    },
  );
});
