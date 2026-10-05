import { AbstractChain, TransactionType } from '@rosen-chains/abstract-chain';

import TxAgreement from '../../src/agreement/txAgreement';
import ColdStorage from '../../src/coldStorage/coldStorage';
import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import { DatabaseAction } from '../../src/db/databaseAction';
import * as ScannerStartup from '../../src/jobs/initScanner';
import { COLD_STORAGE_CHAINS } from '../../src/utils/constants';
import GuardTurn from '../../src/utils/guardTurn';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import { routePolicies } from '../configs/avalancheManagementRoutesTestData';
import TestConfigs from '../testUtils/testConfigs';
import { contracts } from '../utils/avalancheChainTestUtils';

describe('Avalanche cold storage route gate', () => {
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
  afterEach(() => vi.restoreAllMocks());
  /**
   * @target ColdStorage.processLockAddressAssets schedules by captured cold=$cold manual=$manual arbitrary=$arbitrary
   * @dependencies Actual scheduler, prepared policy and inert per-chain processor spy.
   * @scenario Exercise all independent route combinations.
   * @expected Cold alone controls Avalanche scheduling; every legacy chain remains scheduled.
   */
  it.each(routePolicies)(
    'schedules by captured cold=$cold manual=$manual arbitrary=$arbitrary',
    async (routes) => {
      prepare(routes);
      const process = vi
        .spyOn(ColdStorage, 'chainColdStorageProcess')
        .mockResolvedValue(undefined);
      await ColdStorage.processLockAddressAssets();
      expect(process.mock.calls.map(([chain]) => chain)).toEqual(
        COLD_STORAGE_CHAINS.filter(
          (chain) => chain !== 'avalanche' || routes.cold,
        ),
      );
    },
  );
  /**
   * @target ColdStorage.chainColdStorageProcess processes only cold=$cold manual=$manual arbitrary=$arbitrary
   * @dependencies Real processor, captured policy and active-transaction query spy.
   * @scenario Invoke each route combination with an existing synthetic cold operation.
   * @expected Only cold=true reaches guard state and the query; no new operation is generated.
   */
  it.each(routePolicies)(
    'processes only cold=$cold manual=$manual arbitrary=$arbitrary',
    async (routes) => {
      prepare(routes);
      const turn = vi
        .spyOn(GuardTurn, 'guardTurn')
        .mockReturnValue(TestConfigs.guardIndex);
      const active = vi
        .spyOn(DatabaseAction.getInstance(), 'getActiveColdStorageTxsInChain')
        .mockResolvedValue([{}] as Awaited<
          ReturnType<DatabaseAction['getActiveColdStorageTxsInChain']>
        >);
      const generate = vi
        .spyOn(ColdStorage, 'generateColdStorageTransaction')
        .mockResolvedValue(undefined);
      await ColdStorage.chainColdStorageProcess('avalanche');
      expect(turn).toHaveBeenCalledTimes(routes.cold ? 1 : 0);
      expect(active).toHaveBeenCalledTimes(routes.cold ? 1 : 0);
      expect(generate).not.toHaveBeenCalled();
    },
  );
  /**
   * @target ColdStorage.generateColdStorageTransaction refuses direct generation when only other routes are enabled
   * @dependencies Real generator, disabled cold policy and throwing address getter.
   * @scenario Enable the other two routes and request a cold operation.
   * @expected Refuse without reading any chain address or transaction state.
   */
  it('refuses direct generation when only other routes are enabled', async () => {
    prepare({ cold: false, manual: true, arbitrary: true });
    const address = vi.fn(() => {
      throw new Error('unexpected address read');
    });
    const unsigned = vi.spyOn(
      DatabaseAction.getInstance(),
      'getUnsignedActiveTxsInChain',
    );
    await expect(
      ColdStorage.generateColdStorageTransaction(
        { nativeToken: 1n, tokens: [] },
        { getChainConfigs: address } as unknown as AbstractChain<unknown>,
        'avalanche',
      ),
    ).rejects.toThrow('not supported or enabled');
    expect(address).not.toHaveBeenCalled();
    expect(unsigned).not.toHaveBeenCalled();
  });
  /**
   * @target ColdStorage.generateColdStorageTransaction generates the explicit native cold order when opted in
   * @dependencies Real generator with inert synthetic chain, DB read spies and agreement port.
   * @scenario Request native AVAX cold generation with cold=true and no pending transactions.
   * @expected Generate the cold order with the configured address; no broadcast or signing is invoked.
   */
  it('generates the explicit native cold order when opted in', async () => {
    prepare({ cold: true, manual: false, arbitrary: false });
    vi.spyOn(GuardTurn, 'guardTurn').mockReturnValue(TestConfigs.guardIndex);
    vi.spyOn(
      DatabaseAction.getInstance(),
      'getUnsignedActiveTxsInChain',
    ).mockResolvedValue([]);
    vi.spyOn(
      DatabaseAction.getInstance(),
      'getSignedActiveTxsInChain',
    ).mockResolvedValue([]);
    const agreement = {
      getChainPendingTransactions: vi.fn(() => []),
      addTransactionToQueue: vi.fn(),
    };
    vi.spyOn(TxAgreement, 'getInstance').mockResolvedValue(
      agreement as unknown as TxAgreement,
    );
    const generated = vi.fn().mockResolvedValue([]),
      assets = { nativeToken: 123n, tokens: [] };
    const cold = contracts().addresses.cold;
    const chain = {
      getChainConfigs: () => ({ addresses: { cold } }),
      generateMultipleTransactions: generated,
    } as unknown as AbstractChain<unknown>;
    await ColdStorage.generateColdStorageTransaction(
      assets,
      chain,
      'avalanche',
    );
    expect(generated).toHaveBeenCalledExactlyOnceWith(
      '',
      TransactionType.coldStorage,
      [{ address: cold, assets }],
      [],
      [],
    );
    expect(agreement.addTransactionToQueue).not.toHaveBeenCalled();
  });
});
