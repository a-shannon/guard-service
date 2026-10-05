import { Interface, Transaction } from 'ethers';

import {
  NotEnoughAssetsError,
  SigningStatus,
  TransactionFormatError,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { transferABI } from '@rosen-chains/evm';

import { joe, recipient } from './avalancheErc20TestData';
import {
  closeErc20Fixtures,
  createErc20Fixture,
  tokenOrder,
  tokenPayment,
} from './avalancheErc20TestUtils';
import { eventId } from './avalancheTestData';
import { transferEvidence } from './avalancheTransferProofTestUtils';
import { mockSubmission } from './mocked/avalancheChain.mock';

const routes = [
  TransactionType.coldStorage,
  TransactionType.manual,
  TransactionType.arbitrary,
];
describe('AvalancheChain', () => {
  afterEach(() => {
    closeErc20Fixtures();
    vi.restoreAllMocks();
  });
  describe('generateMultipleTransactions', () => {
    /**
     * @target AvalancheChain.generateMultipleTransactions preserves mapped %s through signing and authorized transport
     * @dependencies Actual mainnet TokenMap/chain/mediator; SDK and RPC boundary doubles
     * @scenario Generate one JOE management transfer under the proper event and cold-recipient policy
     * @expected Exact raw units, one token order and one authorized send; legacy management send refuses
     */
    it.each(routes)(
      'preserves mapped %s through signing and authorized transport',
      async (route) => {
        const f = await createErc20Fixture(undefined, 1, recipient);
        const event = route === TransactionType.arbitrary ? eventId : '';
        const payments = await f.chain.generateMultipleTransactions(
          event,
          route,
          tokenOrder(),
          [],
          [],
        );
        expect(payments).toHaveLength(1);
        const payment = payments[0];
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        expect(payment.txType).toEqual(route);
        expect(payment.eventId).toEqual(event);
        expect(tx.to!.toLowerCase()).toEqual(joe);
        expect(tx.value).toEqual(0n);
        expect(tx.data).toEqual(
          new Interface(transferABI).encodeFunctionData('transfer', [
            recipient,
            10n ** 10n,
          ]) + event,
        );
        expect(f.chain.extractTransactionOrder(payment)).toEqual(tokenOrder());
        expect(
          (await f.chain.getTransactionAssets(payment)).inputAssets.tokens,
        ).toEqual([{ id: joe, value: 10n }]);
        const signed = await f.chain.signTransaction(payment, 1);
        expect(
          f.chain.verifyTransactionExtraConditions(
            signed,
            SigningStatus.Signed,
          ),
        ).toEqual(true);
        await expect(f.chain.submitTransaction(signed)).rejects.toThrow(
          'requires authorized submission',
        );
        const submit = mockSubmission(f.network);
        await f.chain.submitAuthorizedTransaction(signed, async (start) =>
          start(),
        );
        expect(submit.submit).toHaveBeenCalledTimes(1);
        expect(submit.start).toHaveBeenCalledTimes(1);
      },
    );
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses mapped %s without %s funding
     * @dependencies Actual separate raw AVAX reserve and mapped token budget
     * @scenario Reduce only one required asset balance
     * @expected No generated management transaction escapes its reserve check
     */
    it.each(
      routes.flatMap((route) =>
        ['AVAX gas', 'JOE'].map((asset) => [route, asset] as const),
      ),
    )('refuses mapped %s without %s funding', async (route, asset) => {
      const f = await createErc20Fixture(undefined, 1, recipient);
      if (asset === 'AVAX gas') f.native.mockResolvedValue(0n);
      else f.token.mockResolvedValue(10n ** 10n - 1n);
      await expect(
        f.chain.generateMultipleTransactions(
          route === TransactionType.arbitrary ? eventId : '',
          route,
          tokenOrder(),
          [],
          [],
        ),
      ).rejects.toThrow(NotEnoughAssetsError);
    });
    /**
     * @target AvalancheChain.generateMultipleTransactions reserves the nonce of an already signed manual token transfer
     * @dependencies Actual signed pending-envelope decoder and configured parallel limit
     * @scenario A no-event token manual transfer already occupies nonce zero
     * @expected The next mapped transfer uses nonce one
     */
    it('reserves the nonce of an already signed manual token transfer', async () => {
      const f = await createErc20Fixture();
      const manual = tokenPayment({}, TransactionType.manual, '');
      const signed = await f.chain.signTransaction(manual, 1);
      const next = await f.chain.generateMultipleTransactions(
        '',
        TransactionType.manual,
        tokenOrder(),
        [],
        [Buffer.from(signed.txBytes).toString('hex')],
      );
      expect(
        Transaction.from('0x' + Buffer.from(next[0].txBytes).toString('hex'))
          .nonce,
      ).toEqual(1);
    });
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses a token cold transfer to another recipient
     * @dependencies Captured cold destination and exact mapped recipient
     * @scenario The order recipient differs from the configured cold address
     * @expected Refusal occurs before network qualification
     */
    it('refuses a token cold transfer to another recipient', async () => {
      const f = await createErc20Fixture(undefined, 1, `0x${'77'.repeat(20)}`);
      await expect(
        f.chain.generateMultipleTransactions(
          '',
          TransactionType.coldStorage,
          tokenOrder(),
          [],
          [],
        ),
      ).rejects.toThrow(TransactionFormatError);
      expect(f.qualify).not.toHaveBeenCalled();
    });
  });
  describe('rawTxToPaymentTransaction', () => {
    /**
     * @target AvalancheChain.rawTxToPaymentTransaction converts a canonical unsigned mapped manual transfer
     * @dependencies Actual raw JSON parser and mapped manual-envelope policy
     * @scenario Supply transfer calldata without payment metadata
     * @expected The exact unsigned body becomes a manual PaymentTransaction with an empty event
     */
    it('converts a canonical unsigned mapped manual transfer', async () => {
      const f = await createErc20Fixture();
      const manual = tokenPayment({}, TransactionType.manual, '');
      const tx = Transaction.from(
        '0x' + Buffer.from(manual.txBytes).toString('hex'),
      );
      const parsed = await f.chain.rawTxToPaymentTransaction(
        JSON.stringify(tx.toJSON()),
      );
      expect(parsed.toJson()).toEqual(manual.toJson());
    });
  });
  describe('submitAuthorizedTransaction', () => {
    /**
     * @target AvalancheChain.submitAuthorizedTransaction refuses mapped %s after loss of %s funding
     * @dependencies Actual mapped signing, separate final asset checks and SDK dispatch double
     * @scenario Funds suffice during construction/signing but one balance falls before dispatch
     * @expected Neither the final authorization callback nor transport starts
     */
    it.each(
      routes.flatMap((route) =>
        ['AVAX gas', 'JOE'].map((asset) => [route, asset] as const),
      ),
    )('refuses mapped %s after loss of %s funding', async (route, asset) => {
      const f = await createErc20Fixture(undefined, 1, recipient);
      const event = route === TransactionType.arbitrary ? eventId : '';
      const payment = (
        await f.chain.generateMultipleTransactions(
          event,
          route,
          tokenOrder(),
          [],
          [],
        )
      )[0];
      const signed = await f.chain.signTransaction(payment, 1);
      const submit = mockSubmission(f.network);
      const authorize = vi.fn(async (start: () => void) => start());
      if (asset === 'AVAX gas') f.native.mockResolvedValue(0n);
      else f.token.mockResolvedValue(10n ** 10n - 1n);
      await expect(
        f.chain.submitAuthorizedTransaction(signed, authorize),
      ).rejects.toThrow('Insufficient authorized C-Chain');
      expect(authorize).not.toHaveBeenCalled();
      expect(submit.submit).not.toHaveBeenCalled();
      expect(submit.start).not.toHaveBeenCalled();
    });
  });
  describe('verifySettledTokenEvidence', () => {
    /**
     * @target AvalancheChain.verifySettledTokenEvidence qualifies mapped %s while preserving the payment-only gate
     * @dependencies Actual signed mapped route and standard Transfer proof
     * @scenario Management execution has its exact sender, recipient and raw amount
     * @expected Management proof is valid; payment-only proof refuses; missing movement refuses
     */
    it.each(routes)(
      'qualifies mapped %s while preserving the payment-only gate',
      async (route) => {
        const f = await createErc20Fixture(undefined, 1, recipient);
        const manual = tokenPayment(
          {},
          route,
          route === TransactionType.arbitrary ? eventId : '',
        );
        const signed = await f.chain.signTransaction(manual, 1);
        const tx = Transaction.from(
          '0x' + Buffer.from(signed.txBytes).toString('hex'),
        );
        const evidence = transferEvidence(tx);
        expect(f.chain.verifySettledTokenEvidence(signed, evidence)).toEqual(
          true,
        );
        expect(f.chain.verifySettledPaymentEvidence(signed, evidence)).toEqual(
          false,
        );
        evidence.receipt.logs = [];
        expect(f.chain.verifySettledTokenEvidence(signed, evidence)).toEqual(
          false,
        );
      },
    );
  });
  describe('getColdAddressAssets', () => {
    /**
     * @target AvalancheChain.getColdAddressAssets reads qualified mapped cold funds and conservatively excludes dust
     * @dependencies Actual mapped reader and finalized balance boundary doubles
     * @scenario Cold custody holds a raw JOE amount one unit below ten shared units
     * @expected The selected cold balance is nine shared JOE units; unsupported filters do not query RPC
     */
    it('reads qualified mapped cold funds and conservatively excludes dust', async () => {
      const f = await createErc20Fixture(undefined, 1, recipient);
      f.token.mockResolvedValue(10n ** 10n - 1n);
      expect((await f.chain.getColdAddressAssets([joe])).tokens).toEqual([
        { id: joe, value: 9n },
      ]);
      expect(f.token).toHaveBeenCalledWith(recipient, joe);
      const count = f.qualify.mock.calls.length;
      await expect(f.chain.getColdAddressAssets(['unmapped'])).rejects.toThrow(
        'Unsupported Avalanche cold balance asset',
      );
      expect(f.qualify).toHaveBeenCalledTimes(count);
    });
    /**
     * @target AvalancheChain.getColdAddressAssets refuses %s drift during mapped cold reads
     * @dependencies Actual captured cold configuration, token filter and reader identity
     * @scenario One input changes while the ERC20 balance awaits
     * @expected The returned cold funds are discarded
     */
    it.each(['cold address', 'filter', 'reader'])(
      'refuses %s drift during mapped cold reads',
      async (fault) => {
        const f = await createErc20Fixture(undefined, 1, recipient);
        const selected = [joe];
        f.token.mockImplementation(async () => {
          if (fault === 'cold address')
            f.chain.getChainConfigs().addresses.cold = `0x${'77'.repeat(20)}`;
          if (fault === 'filter') selected[0] = 'avax';
          if (fault === 'reader')
            f.network.getAddressBalanceForERC20Asset = vi.fn(async () => 0n);
          return 10n ** 20n;
        });
        await expect(f.chain.getColdAddressAssets(selected)).rejects.toThrow(
          'Avalanche read configuration changed',
        );
      },
    );
  });
});
