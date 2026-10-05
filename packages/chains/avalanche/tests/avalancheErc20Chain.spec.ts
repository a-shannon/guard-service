import { Interface, Transaction } from 'ethers';

import {
  NotEnoughAssetsError,
  TransactionFormatError,
  TransactionType,
  SigningStatus,
} from '@rosen-chains/abstract-chain';
import { transferABI } from '@rosen-chains/evm';

import { joe, recipient } from './avalancheErc20TestData';
import {
  closeErc20Fixtures,
  createErc20Fixture,
  tokenOrder,
  tokenPayment,
} from './avalancheErc20TestUtils';
import { eventId, address } from './avalancheTestData';
import {
  signedToken,
  transferEvidence,
} from './avalancheTransferProofTestUtils';
import { mockSubmission } from './mocked/avalancheChain.mock';

describe('AvalancheChain', () => {
  describe('verifySettledPaymentEvidence', () => {
    /**
     * @target AvalancheChain.verifySettledPaymentEvidence qualifies exact signed mapped settlement
     * @dependencies Actual mapped policy and synthetic qualified receipt
     * @scenario The signed mainnet JOE payment has exact Transfer units and sufficient canonical confirmations
     * @expected True; no status-only proof is accepted
     */
    it('qualifies exact signed mapped settlement', async () => {
      const f = await createErc20Fixture(undefined, 2);
      const tx = signedToken();
      const payment = tokenPayment();
      payment.txBytes = Buffer.from(tx.serialized.slice(2), 'hex');
      expect(
        f.chain.verifySettledPaymentEvidence(payment, transferEvidence(tx)),
      ).toEqual(true);
    });
    /**
     * @target AvalancheChain.verifySettledPaymentEvidence refuses isolated %s
     * @dependencies Actual mapped signed envelope and finality policy
     * @scenario One required execution or confirmation input becomes invalid
     * @expected False even when the other signed and receipt fields remain valid
     */
    it.each([
      'missing movement',
      'insufficient confirmations',
      'confirmation arithmetic',
      'invalid frontier',
      'invalid required confirmations',
    ])('refuses isolated %s', async (fault) => {
      const f = await createErc20Fixture(undefined, 2);
      const tx = signedToken();
      const payment = tokenPayment();
      payment.txBytes = Buffer.from(tx.serialized.slice(2), 'hex');
      const evidence = transferEvidence(tx);
      if (fault === 'missing movement') evidence.receipt.logs = [];
      if (fault === 'insufficient confirmations') {
        evidence.finalizedBlockNumber = 10;
        evidence.confirmations = 1;
      }
      if (fault === 'confirmation arithmetic') evidence.confirmations += 1;
      if (fault === 'invalid frontier') evidence.finalizedBlockHash = '0x00';
      if (fault === 'invalid required confirmations')
        f.chain.getTxRequiredConfirmation = vi.fn(() => 0);
      expect(f.chain.verifySettledPaymentEvidence(payment, evidence)).toEqual(
        false,
      );
    });
  });
  describe('verifyLockTransactionExtraConditions', () => {
    /**
     * @target AvalancheChain.verifyLockTransactionExtraConditions requires exact token movement to custody
     * @dependencies Actual chain/map and qualified RPC receipt method; synthetic signed token envelope.
     * @scenario Supply a canonical mainnet transfer to the captured lock and its standard Transfer.
     * @expected True only after reading execution at the required block; no status-only token admission.
     */
    it('requires exact token movement to custody', async () => {
      const f = await createErc20Fixture();
      const transaction = signedToken({
        data:
          new Interface(transferABI).encodeFunctionData('transfer', [
            address,
            10000000000n,
          ]) + eventId,
      });
      const evidence = transferEvidence(transaction, address.toLowerCase());
      const read = vi
        .spyOn(f.network, 'getSettledTransactionReceiptEvidence')
        .mockResolvedValue(evidence);
      expect(
        await f.chain.verifyLockTransactionExtraConditions(transaction, {
          hash: evidence.blockHash,
          height: 10,
          parentHash: '0x' + 'dd'.repeat(32),
        }),
      ).toEqual(true);
      expect(read).toHaveBeenCalledWith(transaction.hash, evidence.blockHash);
    });
    /**
     * @target AvalancheChain.verifyLockTransactionExtraConditions refuses missing movement or changed admission policy %s
     * @dependencies Actual mapped chain and an otherwise qualified mainnet receipt reply.
     * @scenario Apply one receipt, input, map or adapter mutation during the evidence read.
     * @expected False; none of these changes reaches the generic event extractor as admitted token movement.
     */
    it.each([
      'missing Transfer',
      'raw mismatch',
      'changed block',
      'changed source',
      'map drift',
      'method drift',
      'finality drift',
    ])(
      'refuses missing movement or changed admission policy %s',
      async (kind) => {
        const f = await createErc20Fixture();
        const transaction = signedToken({
          data:
            new Interface(transferABI).encodeFunctionData('transfer', [
              address,
              10000000000n,
            ]) + eventId,
        });
        const evidence = transferEvidence(transaction, address.toLowerCase());
        const block = {
          hash: evidence.blockHash,
          height: 10,
          parentHash: '0x' + 'dd'.repeat(32),
        };
        vi.spyOn(
          f.network,
          'getSettledTransactionReceiptEvidence',
        ).mockImplementation(async () => {
          if (kind === 'missing Transfer') evidence.receipt.logs = [];
          if (kind === 'raw mismatch')
            evidence.receipt.logs[0].data = '0x' + '00'.repeat(32);
          if (kind === 'changed block') block.height += 1;
          if (kind === 'changed source')
            Object.defineProperty(f.network, 'expectedChainId', {
              value: 43113n,
            });
          if (kind === 'map drift') {
            const map = f.tokens.getRawConfig();
            map[1].avalanche.decimals = 17;
            await f.tokens.updateConfigByJson(map);
          }
          if (kind === 'method drift')
            f.network.getSettledTransactionReceiptEvidence = vi.fn();
          if (kind === 'finality drift') evidence.confirmations += 1;
          return evidence;
        });
        expect(
          await f.chain.verifyLockTransactionExtraConditions(
            transaction,
            block,
          ),
        ).toEqual(false);
      },
    );
  });
  afterEach(() => {
    closeErc20Fixtures();
    vi.restoreAllMocks();
  });
  describe('ERC20 payment generation', () => {
    /**
     * @target AvalancheChain.generateMultipleTransactions accepts valid pending token payments %s with parallel limit %s
     * @dependencies Real token chain, canonical serialized envelopes and synthetic signer.
     * @scenario Supply a signed or unsigned JOE payment at nonce zero while generating another payment.
     * @expected Preserve event and accounting identity and select the next nonce without rejecting ABI calldata.
     */
    it.each([
      ['signed', 1],
      ['signed', 2],
      ['unsigned', 1],
      ['unsigned', 2],
    ] as const)(
      'accepts valid pending token payments %s with parallel limit %s',
      async (status, parallel) => {
        const f = await createErc20Fixture();
        f.chain['configs'].maxParallelTx = parallel;
        const pending = tokenPayment();
        const signed =
          status === 'signed'
            ? await f.chain.signTransaction(pending, 1)
            : undefined;
        const raw = signed
          ? Transaction.from(
              '0x' + Buffer.from(signed.txBytes).toString('hex'),
            ).serialized.slice(2)
          : undefined;
        const generated = await f.chain.generateMultipleTransactions(
          eventId,
          TransactionType.payment,
          tokenOrder(),
          status === 'unsigned' ? [pending] : [],
          raw ? [raw] : [],
        );
        expect(generated).toHaveLength(1);
        expect(
          Transaction.from(
            '0x' + Buffer.from(generated[0].txBytes).toString('hex'),
          ).nonce,
        ).toEqual(parallel === 1 ? 1 : 0);
        expect(generated[0].eventId).toEqual(eventId);
        expect(f.chain.extractTransactionOrder(generated[0])).toEqual(
          tokenOrder(),
        );
      },
    );
    /**
     * @target AvalancheChain.generateMultipleTransactions enforces generated-payment reserves with signed pending tokens %s
     * @dependencies Real signed pending envelope and independent native and token balance ports.
     * @scenario Supply valid signed pending JOE bytes while one new-payment reserve is one raw unit short.
     * @expected NotEnoughAssetsError after pending validation; pending liveness cannot bypass either reserve.
     */
    it.each(['native', 'token'])(
      'enforces generated-payment reserves with signed pending tokens %s',
      async (kind) => {
        const f = await createErc20Fixture();
        const signed = await f.chain.signTransaction(tokenPayment(), 1);
        const raw = Transaction.from(
          '0x' + Buffer.from(signed.txBytes).toString('hex'),
        ).serialized.slice(2);
        if (kind === 'native') f.native.mockResolvedValue(80000n * 20n - 1n);
        else f.token.mockResolvedValue(10n ** 10n - 1n);
        await expect(
          f.chain.generateMultipleTransactions(
            eventId,
            TransactionType.payment,
            tokenOrder(),
            [],
            [raw],
          ),
        ).rejects.toThrow(NotEnoughAssetsError);
        expect(f.qualify).toHaveBeenCalled();
      },
    );
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses invalid token amounts %s
     * @dependencies Real mapped uint256 amount policy and mocked network boundaries.
     * @scenario Set one zero, negative, overflowing or non-bigint order amount.
     * @expected TransactionFormatError before qualification or gas estimation.
     */
    it.each([0n, -1n, 1n << 256n, 1])(
      'refuses invalid token amounts %s',
      async (value) => {
        const f = await createErc20Fixture();
        const order = tokenOrder();
        order[0].assets.tokens[0].value = value as bigint;
        await expect(
          f.chain.generateMultipleTransactions(
            eventId,
            TransactionType.payment,
            order,
            [],
            [],
          ),
        ).rejects.toThrow(TransactionFormatError);
        expect(f.qualify).not.toHaveBeenCalled();
        expect(f.gas).not.toHaveBeenCalled();
      },
    );
    /**
     * @target AvalancheChain.generateMultipleTransactions preserves JOE asset, recipient, units and event identity
     * @dependencies Real mainnet chain and TokenMap; mocked RPC and synthetic signer.
     * @scenario Generate, extract, sign and authorize one mapped token payment.
     * @expected One canonical type-2 token payment; exact units, gas reserve and single dispatch.
     */
    it('preserves JOE asset, recipient, units and event identity', async () => {
      const f = await createErc20Fixture();
      const payments = await f.chain.generateMultipleTransactions(
        eventId,
        TransactionType.payment,
        tokenOrder(),
        [],
        [],
      );
      expect(payments).toHaveLength(1);
      const tx = Transaction.from(
        '0x' + Buffer.from(payments[0].txBytes).toString('hex'),
      );
      expect(tx.chainId).toEqual(43114n);
      expect(tx.value).toEqual(0n);
      expect(tx.to?.toLowerCase()).toEqual(joe);
      expect(tx.data).toEqual(
        new Interface(transferABI).encodeFunctionData('transfer', [
          recipient,
          10n ** 10n,
        ]) + eventId,
      );
      expect(f.chain.extractTransactionOrder(payments[0])).toEqual(
        tokenOrder(),
      );
      expect(f.native).toHaveBeenCalledWith(address);
      expect(f.token).toHaveBeenCalledWith(address, joe);
      const signed = await f.chain.signTransaction(payments[0], 1);
      expect(
        f.chain.verifyTransactionExtraConditions(signed, SigningStatus.Signed),
      ).toEqual(true);
      const submission = mockSubmission(f.network);
      await f.chain.submitAuthorizedTransaction(signed, async (start) =>
        start(),
      );
      expect(submission.start).toHaveBeenCalledTimes(1);
    });
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses one insufficient reserve %s
     * @dependencies Real token accounting; independent mocked native and ERC20 balance reads.
     * @scenario Leave one reserve one raw unit short with the other sufficient.
     * @expected NotEnoughAssetsError before a generated payment is returned.
     */
    it.each(['native', 'token'])(
      'refuses one insufficient reserve %s',
      async (kind) => {
        const f = await createErc20Fixture();
        if (kind === 'native') f.native.mockResolvedValue(80000n * 20n - 1n);
        else f.token.mockResolvedValue(10n ** 10n - 1n);
        await expect(
          f.chain.generateMultipleTransactions(
            eventId,
            TransactionType.payment,
            tokenOrder(),
            [],
            [],
          ),
        ).rejects.toThrow(NotEnoughAssetsError);
      },
    );
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses unsupported tokens despite mapper fallback
     * @dependencies Real chain with mocked token wrapping and unwrapping functions.
     * @scenario Replace order token identity while mocked converters accept every input.
     * @expected TransactionFormatError before network qualification.
     */
    it('refuses unsupported tokens despite mapper fallback', async () => {
      const f = await createErc20Fixture();
      vi.spyOn(f.tokens, 'wrapAmount').mockReturnValue({
        amount: 1n,
        decimals: 0,
      });
      vi.spyOn(f.tokens, 'unwrapAmount').mockReturnValue({
        amount: 1n,
        decimals: 0,
      });
      const orders = tokenOrder();
      orders[0].assets.tokens[0].id = '0x' + '33'.repeat(20);
      await expect(
        f.chain.generateMultipleTransactions(
          eventId,
          TransactionType.payment,
          orders,
          [],
          [],
        ),
      ).rejects.toThrow(TransactionFormatError);
      expect(f.qualify).not.toHaveBeenCalled();
    });
  });
  describe('ERC20 envelope verification', () => {
    /**
     * @target AvalancheChain.extractTransactionOrder, AvalancheChain.getTransactionAssets rejects an unmapped accounting envelope
     * @dependencies Real accounting methods and configured mainnet TokenMap.
     * @scenario Decode an unsupported contract without invoking a separate verification method.
     * @expected Both public accounting methods refuse the unknown ERC20 rather than use mapper fallback.
     */
    it('rejects an unmapped accounting envelope', async () => {
      const f = await createErc20Fixture();
      const payment = tokenPayment({ to: '0x' + '33'.repeat(20) });
      expect(() => f.chain.extractTransactionOrder(payment)).toThrow(
        TransactionFormatError,
      );
      await expect(f.chain.getTransactionAssets(payment)).rejects.toThrow(
        TransactionFormatError,
      );
    });
    /**
     * @target AvalancheChain.verifyTransactionExtraConditions refuses malformed token envelopes %s
     * @dependencies Real configured chain and canonical ABI encoding.
     * @scenario Change one recipient, amount, selector, event, chain or contract field.
     * @expected False for each independently invalid envelope.
     */
    it.each([
      'contract',
      'chain',
      'value',
      'recipient',
      'amount',
      'selector',
      'event',
      'trailing',
      'padding',
    ])('refuses malformed token envelopes %s', async (kind) => {
      const f = await createErc20Fixture();
      let data =
        new Interface(transferABI).encodeFunctionData('transfer', [
          kind === 'recipient' ? '0x' + '00'.repeat(20) : recipient,
          kind === 'amount' ? 0n : 10n ** 10n,
        ]) + eventId;
      if (kind === 'selector') data = '0xffffffff' + data.slice(10);
      if (kind === 'event') data = data.slice(0, -2) + '00';
      if (kind === 'trailing') data += '00';
      if (kind === 'padding') data = data.slice(0, 10) + '01' + data.slice(12);
      const payment = tokenPayment({
        data,
        ...(kind === 'contract' ? { to: '0x' + '33'.repeat(20) } : {}),
        ...(kind === 'chain' ? { chainId: 43113n } : {}),
        ...(kind === 'value' ? { value: 1n } : {}),
      });
      expect(f.chain.verifyTransactionExtraConditions(payment)).toEqual(false);
    });
    /**
     * @target AvalancheChain.verifyTransactionExtraConditions refuses payment metadata on token manual routes
     * @dependencies Real chain and canonical mapped token payment.
     * @scenario Put a payment event suffix on the manual route, which requires an empty event.
     * @expected False; route-specific metadata is preserved for mapped management.
     */
    it('refuses payment metadata on token manual routes', async () => {
      const f = await createErc20Fixture();
      expect(
        f.chain.verifyTransactionExtraConditions(
          tokenPayment({}, TransactionType.manual),
        ),
      ).toEqual(false);
    });
  });
  describe('ERC20 balance and policy freshness', () => {
    /**
     * @target AvalancheChain.getAddressAssets, AvalancheChain.getColdAddressAssets floors available AVAX for raw balance %s
     * @dependencies Real mainnet chain, captured native mapping and synthetic raw balance port
     * @scenario Read each raw balance at the lock and cold addresses across significant-unit boundaries
     * @expected Both consumers return the downward integer conversion and never invent transferable wei
     */
    it.each([0n, 1n, 999999999n, 1000000000n, 1000000001n, 9007199254740993n])(
      'floors available AVAX for raw balance %s',
      async (balance) => {
        const f = await createErc20Fixture(
          undefined,
          undefined,
          '0x' + '22'.repeat(20),
        );
        f.native.mockResolvedValue(balance);
        expect(
          (await f.chain.getAddressAssets(address, ['avax'])).nativeToken,
        ).toEqual(balance / 1000000000n);
        expect(
          (await f.chain.getColdAddressAssets(['avax'])).nativeToken,
        ).toEqual(balance / 1000000000n);
      },
    );
    /**
     * @target AvalancheChain.getAddressAssets returns conservative token balances and rejects unknown filters
     * @dependencies Real mapped unit conversion and mocked finalized balance port.
     * @scenario Read a fractional token balance then request an unknown token.
     * @expected Nine wrapped JOE units; unknown filter rejected before another read.
     */
    it('returns conservative token balances and rejects unknown filters', async () => {
      const f = await createErc20Fixture();
      f.token.mockResolvedValue(10n ** 10n - 1n);
      expect((await f.chain.getAddressAssets(address, [joe])).tokens).toEqual([
        { id: joe, value: 9n },
      ]);
      await expect(
        f.chain.getAddressAssets(address, ['unknown']),
      ).rejects.toThrow(TransactionFormatError);
      expect(f.token).toHaveBeenCalledTimes(1);
    });
    /**
     * @target AvalancheChain.hasLockAddressEnoughAssets refuses policy drift during token reads %s
     * @dependencies Real chain policy and mocked awaited ERC20 read.
     * @scenario Mutate mapping, supported IDs or the read method during its response.
     * @expected TransactionFormatError; no changed response authorizes an asset requirement.
     */
    it.each(['mapping', 'supported', 'method'])(
      'refuses policy drift during token reads %s',
      async (kind) => {
        const f = await createErc20Fixture();
        f.token.mockImplementation(async () => {
          if (kind === 'mapping') {
            const updated = f.tokens.getRawConfig();
            updated[1].avalanche.decimals = 17;
            await f.tokens.updateConfigByJson(updated);
          }
          if (kind === 'supported') f.chain.supportedTokens.push('unknown');
          if (kind === 'method')
            f.network.getAddressBalanceForERC20Asset = vi.fn();
          return 10n ** 20n;
        });
        await expect(
          f.chain.hasLockAddressEnoughAssets({
            nativeToken: 0n,
            tokens: [{ id: joe, value: 10n }],
          }),
        ).rejects.toThrow(TransactionFormatError);
      },
    );
  });
});
