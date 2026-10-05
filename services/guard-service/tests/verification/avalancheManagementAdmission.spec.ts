import { ChainUtils, TransactionType } from '@rosen-chains/abstract-chain';

import Configs from '../../src/configs/configs';
import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import { DatabaseAction } from '../../src/db/databaseAction';
import { getPreparedAvalancheInputs } from '../../src/jobs/initScanner';
import RequestVerifier from '../../src/verification/requestVerifier';
import TransactionVerifier from '../../src/verification/transactionVerifier';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import { contracts } from '../utils/avalancheChainTestUtils';
import { admissionFixture } from './avalancheManagementAdmissionTestUtils';

describe('native Avalanche request admission', () => {
  let f: Awaited<ReturnType<typeof admissionFixture>>;
  const originalArbitrary = Configs.isArbitraryOrderRequestActive;
  beforeEach(async () => {
    f = await admissionFixture();
    Configs.isArbitraryOrderRequestActive = true;
  });
  afterEach(() => {
    f.close();
    vi.restoreAllMocks();
    Configs.isArbitraryOrderRequestActive = originalArbitrary;
  });

  /**
   * @target TransactionVerifier.verifyColdStorageTransaction admits mainnet JOE with configured token and AVAX reserves
   * @dependencies Actual RPC-qualified balance interfaces, mapped chain, config and common request validation
   * @scenario Submit a canonical unsigned cold token transfer with selected balance above high
   * @expected The real request path accepts without a signing, live RPC or transport effect
   */
  it('admits mainnet JOE with configured token and AVAX reserves', async () => {
    f.close();
    f = await admissionFixture(true);
    expect(
      await RequestVerifier.verifyColdStorageTransactionRequest(f.payment()),
    ).toEqual(true);
    expect(f.tokenBalance).toHaveBeenCalledWith(
      contracts().addresses.lock,
      f.joe,
    );
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });

  /**
   * @target TransactionVerifier.verifyColdStorageTransaction refuses token cold %s
   * @dependencies Actual selected token request/accounting and mutable threshold/balance/reservation ports
   * @scenario Break one selected trigger, native reserve, threshold, waiting asset or retained policy
   * @expected Request admission returns false before signing or dispatch
   */
  it.each([
    'token trigger',
    'token low',
    'native gas floor',
    'waiting token',
    'missing token threshold',
    'unknown threshold',
    'late threshold',
    'late config',
  ])('refuses token cold %s', async (fault) => {
    f.close();
    f = await admissionFixture(true);
    if (fault === 'token trigger')
      f.tokenBalance.mockResolvedValue(1500000n * 1000000000n);
    if (fault === 'token low')
      f.tokenBalance.mockResolvedValue(1999999n * 1000000000n);
    if (fault === 'native gas floor')
      f.balance.mockResolvedValue(100000n * 1000000000n);
    if (fault === 'waiting token') f.forbidden.mockResolvedValue([f.joe]);
    if (fault === 'missing token threshold' || fault === 'unknown threshold') {
      const thresholds = Configs.thresholds();
      if (fault === 'missing token threshold')
        delete thresholds.avalanche.tokens[f.joe];
      if (fault === 'unknown threshold')
        thresholds.avalanche.tokens.other = { low: 1n, high: 2n };
      f.thresholds.mockReturnValue(thresholds);
    }
    if (fault === 'late threshold' || fault === 'late config')
      f.tokenBalance.mockImplementation(async () => {
        if (fault === 'late threshold') f.threshold.low += 1n;
        if (fault === 'late config')
          getPreparedAvalancheInputs()!.config.confirmations.cold += 1;
        return 2000000n * 1000000000n;
      });
    expect(
      await TransactionVerifier.verifyColdStorageTransaction(f.payment()),
    ).toEqual(false);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });

  /**
   * @target RequestVerifier.verifyArbitraryTransactionRequest admits $status JOE order and refuses changed $field
   * @dependencies Real token transaction/order extraction and existing approved order/owner DAO read ports
   * @scenario Resolve an exact token order or change only its amount, asset or recipient
   * @expected Only exact approved order bytes are admitted without signing or dispatch
   */
  it.each([
    { status: 'pending', field: 'none' },
    { status: 'in-process', field: 'none' },
    { status: 'pending', field: 'amount' },
    { status: 'pending', field: 'asset' },
    { status: 'pending', field: 'recipient' },
  ])(
    'admits $status JOE order and refuses changed $field',
    async ({ status, field }) => {
      f.close();
      f = await admissionFixture(true);
      const tx = f.payment(TransactionType.arbitrary);
      const order = f.chain.extractTransactionOrder(tx);
      if (field === 'amount') order[0].assets.tokens[0].value += 1n;
      if (field === 'asset')
        order[0].assets.tokens[0].id = '0x' + '78'.repeat(20);
      if (field === 'recipient') order[0].address = '0x' + '78'.repeat(20);
      vi.spyOn(DatabaseAction.getInstance(), 'getOrderById').mockResolvedValue({
        id: tx.eventId,
        chain: 'avalanche',
        status,
        orderJson: ChainUtils.encodeOrder(order),
      } as Awaited<ReturnType<DatabaseAction['getOrderById']>>);
      vi.spyOn(
        DatabaseAction.getInstance(),
        'getOrderValidTxs',
      ).mockResolvedValue(
        status === 'pending'
          ? []
          : ([{ txId: tx.txId }] as Awaited<
              ReturnType<DatabaseAction['getOrderValidTxs']>
            >),
      );
      expect(
        await RequestVerifier.verifyArbitraryTransactionRequest(tx),
      ).toEqual(field === 'none');
      expect(f.signer).not.toHaveBeenCalled();
    },
  );
  /**
   * @target RequestVerifier.verifyColdStorageTransactionRequest admits native cold without a transaction row using value plus maximum gas
   * @dependencies Real package common verification, order and asset accounting; synthetic RPC/DB read state.
   * @scenario Verify a native cold request without a transaction database row.
   * @expected Admit the configured recipient and 421000 reserve, with no transport or signer.
   */
  it('admits native cold without a transaction row using value plus maximum gas', async () => {
    const tx = f.payment(),
      row = vi.spyOn(DatabaseAction.getInstance(), 'getTxById');
    expect(
      (await f.chain.getTransactionAssets(tx)).inputAssets.nativeToken,
    ).toBe(421000n);
    expect(await RequestVerifier.verifyColdStorageTransactionRequest(tx)).toBe(
      true,
    );
    expect(row).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionVerifier.verifyArbitraryTransaction refuses $asset admission after $fault changes during fee validation
   * @dependencies Actual native/token chain, common validation and retained prepared-input/registry ports
   * @scenario Change exactly one registered chain, prepared-input identity or configuration during the fee await
   * @expected Return false without signing or transport
   */
  it.each(
    ['AVAX', 'JOE'].flatMap((asset) =>
      ['registry', 'prepared inputs', 'configuration'].map((fault) => ({
        asset,
        fault,
      })),
    ),
  )(
    'refuses $asset admission after $fault changes during fee validation',
    async ({ asset, fault }) => {
      f.close();
      f = await admissionFixture(asset === 'JOE');
      const tx = f.payment(TransactionType.arbitrary);
      const orderJson = ChainUtils.encodeOrder(
        f.chain.extractTransactionOrder(tx),
      );
      const inputs = getPreparedAvalancheInputs()!;
      vi.spyOn(f.chain, 'verifyTransactionFee').mockImplementation(async () => {
        if (fault === 'registry')
          f.registry.mockReturnValue(undefined as unknown as typeof f.chain);
        if (fault === 'prepared inputs')
          f.prepared.mockReturnValue({ ...inputs });
        if (fault === 'configuration')
          inputs.config.confirmations.arbitrary += 1;
        return true;
      });
      expect(
        await TransactionVerifier.verifyArbitraryTransaction(tx, orderJson),
      ).toEqual(false);
      expect(f.signer).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );
  /**
   * @target TransactionVerifier.verifyColdStorageTransaction refuses %s
   * @dependencies Real native package and shared reserve helper; isolated mutation per fixture.
   * @scenario Break one type, event, recipient, amount, chain, threshold or reserve condition.
   * @expected Refuse with no transport or signer.
   */
  it.each([
    'cold route off',
    'wrong type',
    'nonempty event',
    'boxed event',
    'wrong chain',
    'wrong recipient',
    'zero value',
    'nonnative calldata',
    'forbidden AVAX',
    'competing cold',
    'missing AVAX threshold',
    'extra threshold',
    'trigger equality',
    'low reserve including fee',
    'caller bytes drift',
  ])('refuses %s', async (fault) => {
    let tx = f.payment();
    if (fault === 'cold route off')
      f.prepared.mockReturnValue({
        config: GuardsAvalancheConfigs.read(
          reader({
            ...valid,
            'avalanche.routes': { cold: false, manual: true, arbitrary: true },
          }),
        )!,
        contracts: contracts(),
      });
    if (fault === 'wrong type') tx.txType = TransactionType.manual;
    if (fault === 'nonempty event') tx.eventId = '11'.repeat(32);
    if (fault === 'boxed event')
      tx.eventId = new String('') as unknown as string;
    if (fault === 'wrong chain')
      tx = f.payment(TransactionType.coldStorage, { chainId: 1 });
    if (fault === 'wrong recipient')
      tx = f.payment(TransactionType.coldStorage, {
        to: '0x' + '55'.repeat(20),
      });
    if (fault === 'zero value')
      tx = f.payment(TransactionType.coldStorage, { value: 0n });
    if (fault === 'nonnative calldata')
      tx = f.payment(TransactionType.coldStorage, {
        data: '0xa9059cbb' + '11'.repeat(64),
      });
    if (fault === 'forbidden AVAX') f.forbidden.mockResolvedValue(['avax']);
    if (fault === 'competing cold')
      f.active.mockResolvedValue([{ txId: '22'.repeat(32) }] as Awaited<
        ReturnType<DatabaseAction['getActiveColdStorageTxsInChain']>
      >);
    if (fault === 'missing AVAX threshold')
      f.thresholds.mockReturnValue({
        avalanche: { tokens: {}, maxNativeTransfer: 0n },
      });
    if (fault === 'extra threshold')
      f.thresholds.mockReturnValue({
        avalanche: {
          tokens: { avax: f.threshold, other: f.threshold },
          maxNativeTransfer: 0n,
        },
      });
    if (fault === 'trigger equality')
      f.balance.mockResolvedValue(f.threshold.high);
    if (fault === 'low reserve including fee') {
      f.threshold.low = 600000n;
      f.threshold.high = 999000n;
    }
    if (fault === 'caller bytes drift')
      f.balance.mockImplementation(async () => {
        tx.txBytes[0] ^= 1;
        return 1000000n;
      });
    expect(await TransactionVerifier.verifyColdStorageTransaction(tx)).toBe(
      false,
    );
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });
  /**
   * @target TransactionVerifier.verifyColdStorageTransaction admits remaining exactly %s
   * @dependencies Real package input assets and shared reserve predicate.
   * @scenario Set remaining assets to one exact allowed threshold.
   * @expected Admit each inclusive boundary.
   */
  it.each(['low', 'high'])('admits remaining exactly %s', async (bound) => {
    if (bound === 'low') {
      f.threshold.high = 500000n;
      f.balance.mockResolvedValue(521000n);
    } else f.threshold.high = 579000n;
    expect(
      await TransactionVerifier.verifyColdStorageTransaction(f.payment()),
    ).toBe(true);
  });
  /**
   * @target RequestVerifier.verifyArbitraryTransactionRequest admits %s canonical native order
   * @dependencies Actual native verifier and codec; existing order/active-owner DB read APIs.
   * @scenario Admit a canonical native arbitrary order with its exact matching transaction.
   * @expected Admit pending/unowned or in-process/self-owned states only.
   */
  it.each(['pending', 'in-process'])(
    'admits %s canonical native order',
    async (status) => {
      const tx = f.payment(TransactionType.arbitrary),
        orderJson = ChainUtils.encodeOrder(f.chain.extractTransactionOrder(tx));
      vi.spyOn(DatabaseAction.getInstance(), 'getOrderById').mockResolvedValue({
        id: tx.eventId,
        chain: 'avalanche',
        status,
        orderJson,
      } as Awaited<ReturnType<DatabaseAction['getOrderById']>>);
      vi.spyOn(
        DatabaseAction.getInstance(),
        'getOrderValidTxs',
      ).mockResolvedValue(
        status === 'pending'
          ? []
          : ([{ txId: tx.txId }] as Awaited<
              ReturnType<DatabaseAction['getOrderValidTxs']>
            >),
      );
      expect(await RequestVerifier.verifyArbitraryTransactionRequest(tx)).toBe(
        true,
      );
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.signer).not.toHaveBeenCalled();
    },
  );
  /**
   * @target RequestVerifier.verifyArbitraryTransactionRequest refuses arbitrary %s before DB
   * @dependencies Real request entry; order query spy and one isolated invalid request field.
   * @scenario Disable the route/global flag or change the type/canonical identifier.
   * @expected Refuse before querying an order.
   */
  it.each([
    'route off',
    'global off',
    'wrong type',
    'uppercase id',
    'short id',
    'boxed id',
  ])('refuses arbitrary %s before DB', async (fault) => {
    const tx = f.payment(TransactionType.arbitrary),
      query = vi.spyOn(DatabaseAction.getInstance(), 'getOrderById');
    if (fault === 'route off')
      f.prepared.mockReturnValue({
        config: GuardsAvalancheConfigs.read(
          reader({
            ...valid,
            'avalanche.routes': { cold: true, manual: true, arbitrary: false },
          }),
        )!,
        contracts: contracts(),
      });
    if (fault === 'global off') Configs.isArbitraryOrderRequestActive = false;
    if (fault === 'wrong type') tx.txType = TransactionType.payment;
    if (fault === 'uppercase id') tx.eventId = 'AA'.repeat(32);
    if (fault === 'short id') tx.eventId = '1'.repeat(63);
    if (fault === 'boxed id')
      tx.eventId = new String(tx.eventId) as unknown as string;
    expect(await RequestVerifier.verifyArbitraryTransactionRequest(tx)).toBe(
      false,
    );
    expect(query).not.toHaveBeenCalled();
  });
  /**
   * @target RequestVerifier.verifyArbitraryTransactionRequest refuses arbitrary %s
   * @dependencies Real native verifier and existing order/owner read APIs.
   * @scenario Change one DB order/status/owner or serialized envelope boundary.
   * @expected Refuse and perform no transport/signing.
   */
  it.each([
    'missing order',
    'wrong order chain',
    'completed status',
    'in-process without owner',
    'other owner',
    'second competing owner',
    'different value',
    'tokens in order',
    'multiple orders',
    'nonnative envelope',
    'caller type drift',
  ])('refuses arbitrary %s', async (fault) => {
    let tx = f.payment(TransactionType.arbitrary);
    let order = f.chain.extractTransactionOrder(tx),
      status = 'pending',
      chain = 'avalanche';
    if (fault === 'wrong order chain') chain = 'ethereum';
    if (fault === 'completed status') status = 'completed';
    if (fault === 'in-process without owner') status = 'in-process';
    if (fault === 'different value') order[0].assets.nativeToken += 1n;
    if (fault === 'tokens in order')
      order[0].assets.tokens.push({ id: '22'.repeat(32), value: 1n });
    if (fault === 'multiple orders') order.push(structuredClone(order[0]));
    if (fault === 'nonnative envelope')
      tx = f.payment(TransactionType.arbitrary, {
        data: '0xa9059cbb' + '11'.repeat(64),
      });
    const query = vi
      .spyOn(DatabaseAction.getInstance(), 'getOrderById')
      .mockResolvedValue(
        fault === 'missing order'
          ? null
          : ({
              id: tx.eventId,
              chain,
              status,
              orderJson: ChainUtils.encodeOrder(order),
            } as Awaited<ReturnType<DatabaseAction['getOrderById']>>),
      );
    const owners =
      fault === 'other owner'
        ? [{ txId: '22'.repeat(32) }]
        : fault === 'second competing owner'
          ? [{ txId: tx.txId }, { txId: '22'.repeat(32) }]
          : [];
    vi.spyOn(
      DatabaseAction.getInstance(),
      'getOrderValidTxs',
    ).mockResolvedValue(
      owners as Awaited<ReturnType<DatabaseAction['getOrderValidTxs']>>,
    );
    if (fault === 'caller type drift')
      query.mockImplementation(async () => {
        tx.txType = TransactionType.payment;
        return {
          id: tx.eventId,
          chain,
          status,
          orderJson: ChainUtils.encodeOrder(order),
        } as Awaited<ReturnType<DatabaseAction['getOrderById']>>;
      });
    expect(await RequestVerifier.verifyArbitraryTransactionRequest(tx)).toBe(
      false,
    );
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.signer).not.toHaveBeenCalled();
  });
});
