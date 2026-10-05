import { FeeData, Transaction } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import {
  coldAddress,
  createManagementFixture,
  createMappedManagementFixture,
  createManagementPayment,
} from './avalancheManagementTestUtils';
import { address, eventId } from './avalancheTestData';
import { closeChainFixtures, key } from './avalancheTestUtils';

describe('AvalancheChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeChainFixtures();
  });

  describe('constructor', () => {
    /**
     * @target AvalancheChain.constructor bounds multiplied gas policy at offset %s from uint256
     * @dependencies
     * - Real chain constructor with synthetic gas policy.
     * @scenario
     * - Choose maximum uint256 cap with multiplier one, or cap 2^255 with multiplier two.
     * @expected
     * - Exact uint256 maximum remains valid; overflowing product rejects before RPC.
     */
    it.each([-1n, 0n])(
      'bounds multiplied gas policy at offset %s from uint256',
      (offset) => {
        const create = () =>
          createManagementFixture(10000000n, 21000n, 43113n, {
            gasLimitCap: offset < 0n ? (1n << 256n) - 1n : 1n << 255n,
            gasLimitMultiplier: offset < 0n ? 1n : 2n,
          });
        if (offset === 0n)
          expect(create).toThrow('Invalid C-Chain gas limit configuration');
        else
          expect(
            create().chain.verifyTransactionExtraConditions(
              createManagementPayment(TransactionType.manual),
            ),
          ).toEqual(true);
      },
    );
  });

  describe('verifyTransactionExtraConditions', () => {
    /**
     * @target AvalancheChain.verifyTransactionExtraConditions admits the minimum positive gas envelope on %s
     * @dependencies
     * - Real native chain and type-2 envelope with gas limit one.
     * @scenario
     * - Structurally verify each route at the positive lower gas boundary without estimating execution.
     * @expected
     * - Gas one is a valid structural envelope; execution gas remains a separate fee/signing check.
     */
    it.each([
      TransactionType.payment,
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('admits the minimum positive gas envelope on %s', (type) => {
      const { chain, networkCheck } = createManagementFixture();
      expect(
        chain.verifyTransactionExtraConditions(
          createManagementPayment(type, 43113n, false, 1n),
        ),
      ).toEqual(true);
      expect(networkCheck).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions binds $type signed=$signed to the gas ceiling at offset $offset
     * @dependencies
     * - Real native chain and self-consistent unsigned or synthetic signed envelope.
     * @scenario
     * - Change only the gas limit between the exact multiplied ceiling and one above it.
     * @expected
     * - Equality passes and excess refuses for every native route without RPC or signing.
     */
    it.each(
      [
        TransactionType.payment,
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        [false, true].flatMap((signed) =>
          [0n, 1n].map((offset) => ({ type, signed, offset })),
        ),
      ),
    )(
      'binds $type signed=$signed to the gas ceiling at offset $offset',
      ({ type, signed, offset }) => {
        const { chain, networkCheck, sign } = createManagementFixture(
          10000000n,
          21000n,
          43113n,
          { gasLimitCap: 50000n, gasLimitMultiplier: 2n },
        );
        const payment = createManagementPayment(
          type,
          43113n,
          signed,
          100000n + offset,
        );
        expect(
          chain.verifyTransactionExtraConditions(
            payment,
            signed ? SigningStatus.Signed : SigningStatus.UnSigned,
          ),
        ).toEqual(offset === 0n);
        expect(networkCheck).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions admits native $type with signed=$signed
     * @dependencies
     * - Real native chain and self-consistent synthetic type-2 envelope.
     * @scenario
     * - Verify each native route with its exact event and recipient, unsigned and signed.
     * @expected
     * - The configured chain and signer admit the native envelope.
     */
    it.each(
      [
        TransactionType.payment,
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) => [false, true].map((signed) => ({ type, signed }))),
    )('admits native $type with signed=$signed', ({ type, signed }) => {
      const { chain } = createManagementFixture();
      expect(
        chain.verifyTransactionExtraConditions(
          createManagementPayment(type, 43113n, signed),
          signed ? SigningStatus.Signed : SigningStatus.UnSigned,
        ),
      ).toEqual(true);
    });

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions rejects malformed $kind on $type
     * @dependencies
     * - Real chain and one self-consistent mutated native envelope.
     * @scenario
     * - Change one value, destination, chain, data or management access-list field.
     * @expected
     * - Structural rejection occurs without signer or RPC calls.
     */
    it.each(
      [
        TransactionType.payment,
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        [
          'zero value',
          'zero gas',
          'zero recipient',
          'wrong chain',
          'extra data',
          'access list',
          ...(type === TransactionType.coldStorage ? ['wrong cold'] : []),
        ].map((kind) => ({ type, kind })),
      ),
    )('rejects malformed $kind on $type', ({ type, kind }) => {
      const { chain, networkCheck, sign } = createManagementFixture();
      const p = createManagementPayment(type);
      const tx = Transaction.from(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
      if (kind === 'zero value') tx.value = 0n;
      if (kind === 'zero gas') tx.gasLimit = 0n;
      if (kind === 'zero recipient') tx.to = '0x' + '00'.repeat(20);
      if (kind === 'wrong chain') tx.chainId = 43114n;
      if (kind === 'extra data') tx.data += '00';
      if (kind === 'access list')
        tx.accessList = [{ address, storageKeys: [] }];
      if (kind === 'wrong cold') tx.to = address;
      p.txId = tx.unsignedHash;
      p.txBytes = Buffer.from(tx.unsignedSerialized.slice(2), 'hex');
      expect(chain.verifyTransactionExtraConditions(p)).toEqual(false);
      expect(networkCheck).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions rejects malformed event $kind on $type
     * @dependencies
     * - Real chain and native route metadata.
     * @scenario
     * - Replace the primitive empty or lowercase event ID with one invalid representation.
     * @expected
     * - The native route rejects before signing or network access.
     */
    it.each(
      [
        TransactionType.payment,
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        ['wrong length', 'boxed string', 'wrong case'].map((kind) => ({
          type,
          kind,
        })),
      ),
    )('rejects malformed event $kind on $type', ({ type, kind }) => {
      const { chain, networkCheck } = createManagementFixture();
      const p = createManagementPayment(type);
      const expected = p.eventId;
      Reflect.set(
        p,
        'eventId',
        kind === 'boxed string'
          ? new String(expected)
          : kind === 'wrong case'
            ? eventId.toUpperCase()
            : type === TransactionType.manual ||
                type === TransactionType.coldStorage
              ? eventId
              : '',
      );
      expect(chain.verifyTransactionExtraConditions(p)).toEqual(false);
      expect(networkCheck).not.toHaveBeenCalled();
    });
  });

  describe('hasLockAddressEnoughAssets', () => {
    /**
     * @target AvalancheChain.hasLockAddressEnoughAssets compares raw AVAX availability with a wrapped requirement at wei offset %s
     * @dependencies
     * - Real TokenMap eighteen-to-nine decimal conversion and qualified native balance producer.
     * @scenario
     * - Require one thousand wrapped units; raw balance is exactly one thousand billion wei or one wei less.
     * @expected
     * - Equality passes; rounding an available balance up cannot admit a one-wei deficit.
     */
    it.each([-1n, 0n])(
      'compares raw AVAX availability with a wrapped requirement at wei offset %s',
      async (offset) => {
        const { chain } = await createMappedManagementFixture(
          1000n * 1000000000n + offset,
        );
        expect(
          await chain.hasLockAddressEnoughAssets({
            nativeToken: 1000n,
            tokens: [],
          }),
        ).toEqual(offset === 0n);
      },
    );

    /**
     * @target AvalancheChain.hasLockAddressEnoughAssets compares the native balance at offset %s
     * @dependencies
     * - Real native lock consumer with selected network and native TokenMap.
     * @scenario
     * - Compare an isolated requirement with one short, exact and one excess balance.
     * @expected
     * - Equality and excess fit; one short refuses without an ERC20 read.
     */
    it.each([-1n, 0n, 1n])(
      'compares the native balance at offset %s',
      async (offset) => {
        const { chain, network, networkCheck, balance } =
          createManagementFixture(1000n + offset);
        const erc20 = vi.spyOn(network, 'getAddressBalanceForERC20Asset');
        expect(
          await chain.hasLockAddressEnoughAssets({
            nativeToken: 1000n,
            tokens: [],
          }),
        ).toEqual(offset >= 0n);
        expect(networkCheck).toHaveBeenCalledTimes(1);
        expect(balance).toHaveBeenCalledWith(address);
        expect(erc20).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.hasLockAddressEnoughAssets refuses malformed native requirement %s before RPC
     * @dependencies
     * - Real native lock consumer and one malformed input field.
     * @scenario
     * - Supply negative, non-bigint, overflow or token-bearing requirements.
     * @expected
     * - No qualification or balance producer is reached.
     */
    it.each(['negative', 'number', 'overflow', 'ERC20'])(
      'refuses malformed native requirement %s before RPC',
      async (kind) => {
        const { chain, networkCheck, balance } = createManagementFixture();
        const required = {
          nativeToken: 1000n,
          tokens: [] as { id: string; value: bigint }[],
        };
        if (kind === 'negative') required.nativeToken = -1n;
        if (kind === 'number') Reflect.set(required, 'nativeToken', 1000);
        if (kind === 'overflow') required.nativeToken = 1n << 256n;
        if (kind === 'ERC20') required.tokens.push({ id: address, value: 1n });
        await expect(
          chain.hasLockAddressEnoughAssets(required),
        ).rejects.toThrow('Invalid Avalanche native asset requirement');
        expect(networkCheck).not.toHaveBeenCalled();
        expect(balance).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.hasLockAddressEnoughAssets refuses $kind mutation during $stage
     * @dependencies
     * - Real native lock consumer and one isolated mutation in an awaited mock.
     * @scenario
     * - Change the requirement, lock, selected chain, adapter or wrapper at one wait boundary.
     * @expected
     * - No successful asset admission survives the changed lease.
     */
    it.each(
      ['qualification', 'balance'].flatMap((stage) =>
        [
          'amount',
          'token request',
          'lock',
          'network',
          'chainId',
          'expected chain',
          'qualifier',
          'balance method',
          'TokenMap',
          'wrapper',
        ].map((kind) => ({ stage, kind })),
      ),
    )('refuses $kind mutation during $stage', async ({ kind, stage }) => {
      const { chain, network, networkCheck, balance } =
        createManagementFixture();
      const required = {
        nativeToken: 1000n,
        tokens: [] as { id: string; value: bigint }[],
      };
      /** Apply exactly the selected lease mutation at this case's await boundary. */
      const mutate = () => {
        if (kind === 'amount') required.nativeToken = 1001n;
        if (kind === 'token request')
          required.tokens.push({ id: address, value: 1n });
        if (kind === 'lock') chain.configs.addresses.lock = coldAddress;
        if (kind === 'network') Reflect.set(chain, 'network', {});
        if (kind === 'chainId') Reflect.set(chain, 'CHAIN_ID', 43114n);
        if (kind === 'expected chain')
          Reflect.set(network, 'expectedChainId', 43114n);
        if (kind === 'qualifier') network.assertNetwork = vi.fn(async () => {});
        if (kind === 'balance method')
          network.getAddressBalanceForNativeToken = vi.fn(
            async () => 10000000n,
          );
        if (kind === 'TokenMap') Reflect.set(chain, 'tokenMap', {});
        if (kind === 'wrapper') chain['tokenMap'].wrapAmount = vi.fn();
      };
      if (stage === 'qualification')
        networkCheck.mockImplementation(async () => {
          mutate();
        });
      else
        balance.mockImplementation(async () => {
          mutate();
          return 10000000n;
        });
      await expect(chain.hasLockAddressEnoughAssets(required)).rejects.toThrow(
        'Avalanche native asset requirement changed',
      );
      if (stage === 'qualification') expect(balance).not.toHaveBeenCalled();
    });
  });

  describe('generateMultipleTransactions', () => {
    /**
     * @target AvalancheChain.generateMultipleTransactions compares exact nonaligned AVAX reserve at wei offset %s
     * @dependencies
     * - Real native builder, eighteen-to-nine TokenMap and deterministic fractional-unit gas price.
     * @scenario
     * - Generate value 1000 wrapped units plus 42000 gas at 10000000003 wei; balance equals the raw sum or is one wei less.
     * @expected
     * - Literal raw equality generates; the one-wei deficit rejects even when both wrapped values round to the same integer.
     */
    it.each([-1n, 0n])(
      'compares exact nonaligned AVAX reserve at wei offset %s',
      async (offset) => {
        const requiredWei = 1000n * 1000000000n + 42000n * 10000000003n;
        const { chain, fees, balance, sign } =
          await createMappedManagementFixture(requiredWei + offset);
        fees.mockResolvedValue(new FeeData(null, 10000000003n, 1n));
        const generated = chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          [],
          [],
        );
        if (offset < 0n)
          await expect(generated).rejects.toThrow(
            'native value plus maximum fee',
          );
        else {
          const [payment] = await generated;
          const tx = Transaction.from(
            '0x' + Buffer.from(payment.txBytes).toString('hex'),
          );
          expect(tx.value + tx.gasLimit * tx.maxFeePerGas!).toEqual(
            requiredWei,
          );
          expect(
            (await chain.getTransactionAssets(payment)).inputAssets.nativeToken,
          ).toEqual(421001n);
          expect(
            await chain.hasLockAddressEnoughAssets({
              nativeToken: 421001n,
              tokens: [],
            }),
          ).toEqual(false);
        }
        expect(balance).toHaveBeenCalledWith(address);
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects invalid parallel capacity %s before RPC
     * @dependencies
     * - Real native constructor and generation method with one invalid parallel capacity.
     * @scenario
     * - Set zero, negative, fractional or unsafe capacity before chain creation.
     * @expected
     * - Generation refuses before network qualification, nonce, gas or balance reads.
     */
    it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid parallel capacity %s before RPC',
      async (maxParallelTx) => {
        const { chain, networkCheck, nonce, gas, balance } =
          createManagementFixture(10000000n, 21000n, 43113n, { maxParallelTx });
        await expect(
          chain.generateMultipleTransactions(
            '',
            TransactionType.manual,
            [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
            [],
            [],
          ),
        ).rejects.toThrow('Invalid Avalanche pending transaction policy');
        for (const mock of [networkCheck, nonce, gas, balance])
          expect(mock).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects exhausted safe nonce for %s
     * @dependencies
     * - Real native generator with maximum safe integer returned by the nonce producer.
     * @scenario
     * - Occupy that nonce with a pending owner, or request a second output after using it.
     * @expected
     * - The unsafe successor nonce is never serialized and no balance or signer admission follows.
     */
    it.each(['pending owner', 'second output'])(
      'rejects exhausted safe nonce for %s',
      async (kind) => {
        const { chain, nonce, balance, sign } = createManagementFixture();
        nonce.mockResolvedValue(Number.MAX_SAFE_INTEGER);
        const orders = Array.from(
          { length: kind === 'second output' ? 2 : 1 },
          () => ({ address, assets: { nativeToken: 1000n, tokens: [] } }),
        );
        const pending =
          kind === 'pending owner'
            ? [
                createManagementPayment(
                  TransactionType.manual,
                  43113n,
                  false,
                  42000n,
                  Number.MAX_SAFE_INTEGER,
                ),
              ]
            : [];
        await expect(
          chain.generateMultipleTransactions(
            '',
            TransactionType.manual,
            orders,
            pending,
            [],
          ),
        ).rejects.toThrow('nonce exceeds safe integer');
        expect(balance).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions admits one output at the maximum safe nonce
     * @dependencies
     * - Real native builder with safe integer upper boundary nonce.
     * @scenario
     * - Generate one output at Number.MAX_SAFE_INTEGER with no existing owner.
     * @expected
     * - The exact valid nonce is serialized without requiring an unsafe successor output.
     */
    it('admits one output at the maximum safe nonce', async () => {
      const { chain, nonce } = createManagementFixture();
      nonce.mockResolvedValue(Number.MAX_SAFE_INTEGER);
      const [payment] = await chain.generateMultipleTransactions(
        '',
        TransactionType.manual,
        [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
        [],
        [],
      );
      expect(
        Transaction.from('0x' + Buffer.from(payment.txBytes).toString('hex'))
          .nonce,
      ).toEqual(Number.MAX_SAFE_INTEGER);
    });

    /**
     * @target AvalancheChain.generateMultipleTransactions skips a saturated pending nonce inside the output batch
     * @dependencies
     * - Real native builder with available nonce four and one captured owner of nonce five.
     * @scenario
     * - Generate two outputs with maxParallel one while nonce five is already owned.
     * @expected
     * - Generated nonces are four and six; the occupied interior nonce is never reused.
     */
    it('skips a saturated pending nonce inside the output batch', async () => {
      const { chain } = createManagementFixture();
      const generated = await chain.generateMultipleTransactions(
        '',
        TransactionType.manual,
        [address, coldAddress].map((destination) => ({
          address: destination,
          assets: { nativeToken: 1000n, tokens: [] },
        })),
        [
          createManagementPayment(
            TransactionType.manual,
            43113n,
            false,
            42000n,
            5,
          ),
        ],
        [],
      );
      expect(
        generated.map(
          (payment) =>
            Transaction.from(
              '0x' + Buffer.from(payment.txBytes).toString('hex'),
            ).nonce,
        ),
      ).toEqual([4, 6]);
    });

    /**
     * @target AvalancheChain.generateMultipleTransactions preserves nonce ownership for pending %s
     * @dependencies
     * - Real native generator, captured pending envelopes and deterministic next nonce four.
     * @scenario
     * - Supply unsigned, signed or combined native pending owners of nonce four with maxParallel one.
     * @expected
     * - Two generated orders receive consecutive nonces five and six without changing pending bytes.
     */
    it.each(['unsigned', 'signed', 'combined'])(
      'preserves nonce ownership for pending %s',
      async (kind) => {
        const { chain } = createManagementFixture();
        const unsigned = createManagementPayment(TransactionType.manual);
        const signed = createManagementPayment(
          TransactionType.manual,
          43113n,
          true,
        );
        const unsignedJson = unsigned.toJson(),
          signedRaw = Buffer.from(signed.txBytes).toString('hex');
        const generated = await chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [address, coldAddress].map((destination) => ({
            address: destination,
            assets: { nativeToken: 1000n, tokens: [] },
          })),
          kind === 'signed' ? [] : [unsigned],
          kind === 'unsigned' ? [] : [signedRaw],
        );
        expect(
          generated.map(
            (payment) =>
              Transaction.from(
                '0x' + Buffer.from(payment.txBytes).toString('hex'),
              ).nonce,
          ),
        ).toEqual([5, 6]);
        expect(unsigned.toJson()).toEqual(unsignedJson);
        expect(Buffer.from(signed.txBytes).toString('hex')).toEqual(signedRaw);
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions respects maxParallel nonce capacity at owner count %s
     * @dependencies
     * - Real native generator with maxParallel two and captured unsigned owners.
     * @scenario
     * - Supply one or two owners of nonce four.
     * @expected
     * - One owner permits nonce four; two owners advance to five.
     */
    it.each([1, 2])(
      'respects maxParallel nonce capacity at owner count %s',
      async (count) => {
        const { chain } = createManagementFixture(10000000n, 21000n, 43113n, {
          maxParallelTx: 2,
        });
        const generated = await chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          Array.from({ length: count }, () =>
            createManagementPayment(TransactionType.manual),
          ),
          [],
        );
        expect(
          Transaction.from(
            '0x' + Buffer.from(generated[0].txBytes).toString('hex'),
          ).nonce,
        ).toEqual(count === 1 ? 4 : 5);
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects invalid next nonce %s
     * @dependencies
     * - Real native builder with one invalid deterministic nonce producer result.
     * @scenario
     * - Return negative, fractional, nonfinite, string or unsafe nonce values.
     * @expected
     * - No gas estimate, balance read or signer follows invalid nonce admission.
     */
    it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, '4'])(
      'rejects invalid next nonce %s',
      async (value) => {
        const { chain, nonce, gas, balance, sign } = createManagementFixture();
        nonce.mockResolvedValue(value as number);
        await expect(
          chain.generateMultipleTransactions(
            '',
            TransactionType.manual,
            [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
            [],
            [],
          ),
        ).rejects.toThrow('Invalid Avalanche next nonce');
        for (const mock of [gas, balance, sign])
          expect(mock).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects invalid fee field %s
     * @dependencies
     * - Real native builder with one mutated fee producer result.
     * @scenario
     * - Replace only a maximum or priority fee field with null, zero, negative, overflow or a priority above maximum.
     * @expected
     * - No gas, balance or signer follows malformed fee data.
     */
    it.each([
      'missing maximum',
      'zero maximum',
      'negative maximum',
      'overflow maximum',
      'missing priority',
      'negative priority',
      'excess priority',
    ])('rejects invalid fee field %s', async (kind) => {
      const { chain, fees, gas, balance, sign } = createManagementFixture();
      const feeData = {
        gasPrice: null,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
      };
      if (kind === 'missing maximum')
        Reflect.set(feeData, 'maxFeePerGas', null);
      if (kind === 'zero maximum') feeData.maxFeePerGas = 0n;
      if (kind === 'negative maximum') feeData.maxFeePerGas = -1n;
      if (kind === 'overflow maximum') feeData.maxFeePerGas = 1n << 256n;
      if (kind === 'missing priority')
        Reflect.set(feeData, 'maxPriorityFeePerGas', null);
      if (kind === 'negative priority') feeData.maxPriorityFeePerGas = -1n;
      if (kind === 'excess priority') feeData.maxPriorityFeePerGas = 11n;
      fees.mockResolvedValue(feeData as FeeData);
      await expect(
        chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          [],
          [],
        ),
      ).rejects.toThrow('Invalid Avalanche generation fee data');
      for (const mock of [gas, balance, sign])
        expect(mock).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.generateMultipleTransactions compares final reserve below the gas cap at balance offset %s
     * @dependencies
     * - Real native builder, fee wrapping and qualified native balance consumer.
     * @scenario
     * - Use gas estimate 21000 below cap 100000, multiplier two and fee ten; balance is exact final 421000 or one less.
     * @expected
     * - Equality generates native bytes; one short refuses with no signer or submission.
     */
    it.each([-1n, 0n])(
      'compares final reserve below the gas cap at balance offset %s',
      async (offset) => {
        const { chain, sign } = createManagementFixture(421000n + offset);
        const generated = chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          [],
          [],
        );
        if (offset < 0n)
          await expect(generated).rejects.toThrow(
            'native value plus maximum fee',
          );
        else {
          const [payment] = await generated;
          expect(
            (await chain.getTransactionAssets(payment)).inputAssets,
          ).toEqual({ nativeToken: 421000n, tokens: [] });
        }
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions enforces cap with multiplier $multiplier and estimate offset $offset
     * @dependencies
     * - Real native builder, asset reserve and deterministic RPC producers.
     * @scenario
     * - Estimate gas at the configured cap or one above, with one or two as multiplier.
     * @expected
     * - Exact cap generates its multiplied limit; excess never returns bytes or reaches signing.
     */
    it.each(
      [1n, 2n].flatMap((multiplier) =>
        [0n, 1n].map((offset) => ({ multiplier, offset })),
      ),
    )(
      'enforces cap with multiplier $multiplier and estimate offset $offset',
      async ({ multiplier, offset }) => {
        const { chain, sign } = createManagementFixture(
          10000000n,
          50000n + offset,
          43113n,
          {
            gasLimitCap: 50000n,
            gasLimitMultiplier: multiplier,
          },
        );
        const generated = chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          [],
          [],
        );
        if (offset !== 0n)
          await expect(generated).rejects.toThrow(
            'outside the configured limit',
          );
        else {
          const [payment] = await generated;
          const tx = Transaction.from(
            '0x' + Buffer.from(payment.txBytes).toString('hex'),
          );
          expect(tx.gasLimit).toEqual(50000n * multiplier);
          expect(chain.verifyTransactionExtraConditions(payment)).toEqual(true);
        }
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects overflowing aggregate native inputs
     * @dependencies
     * - Real native builder, wrapping and balance consumer.
     * @scenario
     * - Generate two individually valid values whose combined input plus fee exceeds uint256.
     * @expected
     * - The final aggregate rejects before signing or submission.
     */
    it('rejects overflowing aggregate native inputs', async () => {
      const { chain, sign } = createManagementFixture((1n << 256n) - 1n);
      const orders = [address, coldAddress].map((destination) => ({
        address: destination,
        assets: { nativeToken: 1n << 255n, tokens: [] },
      }));
      await expect(
        chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          orders,
          [],
          [],
        ),
      ).rejects.toThrow('native reserve overflows uint256');
      expect(sign).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects %s replacement during qualification
     * @dependencies
     * - Real native generator and one isolated replaced producer or consumer.
     * @scenario
     * - Replace a dependency while endpoint qualification awaits.
     * @expected
     * - No generated native result is returned and signing never runs.
     */
    it.each([
      'gas',
      'fees',
      'nonce',
      'wrap',
      'unwrap',
      'verifier',
      'assets',
      'enough',
      'network',
      'cap',
      'multiplier',
      'parallel policy',
      'gas limit method',
      'chain literal',
      'native literal',
    ])('rejects %s replacement during qualification', async (kind) => {
      const { chain, network, networkCheck, sign } = createManagementFixture();
      networkCheck.mockImplementation(async () => {
        if (kind === 'gas') Reflect.set(network, 'getGasRequired', vi.fn());
        if (kind === 'fees') Reflect.set(network, 'getFeeData', vi.fn());
        if (kind === 'nonce')
          Reflect.set(network, 'getAddressNextAvailableNonce', vi.fn());
        if (kind === 'wrap')
          Reflect.set(chain['tokenMap'], 'wrapAmount', vi.fn());
        if (kind === 'unwrap')
          Reflect.set(chain['tokenMap'], 'unwrapAmount', vi.fn());
        if (kind === 'verifier')
          chain.verifyTransactionExtraConditions = vi.fn(() => true);
        if (kind === 'assets') chain.getTransactionAssets = vi.fn();
        if (kind === 'enough')
          chain.hasLockAddressEnoughAssets = vi.fn(async () => true);
        if (kind === 'network') Reflect.set(chain, 'network', {});
        if (kind === 'cap') chain.configs.gasLimitCap += 1n;
        if (kind === 'multiplier') chain.configs.gasLimitMultiplier += 1n;
        if (kind === 'parallel policy') chain.configs.maxParallelTx += 1;
        if (kind === 'gas limit method')
          Reflect.set(chain, 'getGasLimit', vi.fn());
        if (kind === 'chain literal') Reflect.set(chain, 'CHAIN', 'foreign');
        if (kind === 'native literal')
          Reflect.set(chain, 'NATIVE_TOKEN_ID', 'foreign');
      });
      await expect(
        chain.generateMultipleTransactions(
          '',
          TransactionType.manual,
          [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
          [],
          [],
        ),
      ).rejects.toThrow('generation configuration changed');
      expect(sign).not.toHaveBeenCalled();
    });
    /**
     * @target AvalancheChain.generateMultipleTransactions generates native $type on $chainId with final value and fee reserve
     * @dependencies
     * - Real inherited builder, native TokenMap and native balance accounting.
     * - Deterministic nonce, gas, fee and balance RPC mocks.
     * @scenario
     * - Generate each native route on both selected C-Chain identities.
     * @expected
     * - The exact event, recipient, sequential nonce and final wrapped reserve are preserved.
     */
    it.each(
      [
        TransactionType.payment,
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        [43113n, 43114n].map((chainId) => ({ type, chainId })),
      ),
    )(
      'generates native $type on $chainId with final value and fee reserve',
      async ({ type, chainId }) => {
        const { chain, networkCheck, balance } = createManagementFixture(
          10000000n,
          21000n,
          chainId,
        );
        const event =
          type === TransactionType.manual ||
          type === TransactionType.coldStorage
            ? ''
            : eventId;
        const destination =
          type === TransactionType.coldStorage ? coldAddress : address;
        const [p] = await chain.generateMultipleTransactions(
          event,
          type,
          [
            {
              address: destination,
              assets: { nativeToken: 1000n, tokens: [] },
            },
          ],
          [],
          [],
        );
        const tx = Transaction.from(
          '0x' + Buffer.from(p.txBytes).toString('hex'),
        );
        expect([
          p.txType,
          p.eventId,
          tx.chainId,
          tx.to?.toLowerCase(),
          tx.data,
          tx.value,
          tx.nonce,
          tx.gasLimit,
        ]).toEqual([
          type,
          event,
          chainId,
          destination.toLowerCase(),
          '0x' + event,
          1000n,
          4,
          42000n,
        ]);
        expect((await chain.getTransactionAssets(p)).inputAssets).toEqual({
          nativeToken: 421000n,
          tokens: [],
        });
        expect(balance).toHaveBeenCalledWith(address);
        expect(networkCheck).toHaveBeenCalled();
        expect(chain.verifyTransactionExtraConditions(p)).toEqual(true);
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects native order %s before RPC
     * @dependencies
     * - Real chain and one malformed native output.
     * @scenario
     * - Supply an empty batch or isolated invalid asset/address field.
     * @expected
     * - No qualification, nonce, fee, gas or balance producer is reached.
     */
    it.each([
      'empty',
      'zero',
      'negative',
      'overflow',
      'number',
      'ERC20',
      'zero recipient',
      'malformed recipient',
      'wrong cold',
    ])('rejects native order %s before RPC', async (kind) => {
      const { chain, networkCheck, nonce, fees, gas, balance } =
        createManagementFixture();
      const order = {
        address: coldAddress,
        assets: {
          nativeToken: 1000n,
          tokens: [] as { id: string; value: bigint }[],
        },
      };
      if (kind === 'zero') order.assets.nativeToken = 0n;
      if (kind === 'negative') order.assets.nativeToken = -1n;
      if (kind === 'overflow') order.assets.nativeToken = 1n << 256n;
      if (kind === 'number') Reflect.set(order.assets, 'nativeToken', 1000);
      if (kind === 'ERC20')
        order.assets.tokens.push({ id: address, value: 1n });
      if (kind === 'zero recipient') order.address = '0x' + '00'.repeat(20);
      if (kind === 'malformed recipient') order.address = 'invalid';
      if (kind === 'wrong cold') order.address = address;
      await expect(
        chain.generateMultipleTransactions(
          '',
          TransactionType.coldStorage,
          kind === 'empty' ? [] : [order],
          [],
          [],
        ),
      ).rejects.toThrow('Invalid Avalanche native orders');
      for (const mock of [networkCheck, nonce, fees, gas, balance])
        expect(mock).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.generateMultipleTransactions rejects isolated insufficient %s final reserve
     * @dependencies
     * - Real native builder and qualified balance checks.
     * @scenario
     * - Provide a balance below the final value, multiplied fee or batch total.
     * @expected
     * - Final aggregate reserve rejects before any signing effect.
     */
    it.each(['value', 'multiplier', 'aggregate'])(
      'rejects isolated insufficient %s final reserve',
      async (kind) => {
        const { chain, gas, sign, balance } = createManagementFixture(
          kind === 'value'
            ? 1100000n
            : kind === 'multiplier'
              ? 1500000n
              : 3000000n,
          kind === 'multiplier' ? 100000n : 21000n,
        );
        const orders = Array.from(
          { length: kind === 'aggregate' ? 2 : 1 },
          () => ({
            address,
            assets: {
              nativeToken:
                kind === 'value'
                  ? 800000n
                  : kind === 'aggregate'
                    ? 2000000n
                    : 1000n,
              tokens: [],
            },
          }),
        );
        await expect(
          chain.generateMultipleTransactions(
            '',
            TransactionType.manual,
            orders,
            [],
            [],
          ),
        ).rejects.toThrow('native value plus maximum fee');
        expect(balance).toHaveBeenCalledTimes(1);
        expect(gas).toHaveBeenCalledTimes(orders.length);
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions admits the exact aggregate value plus fee boundary
     * @dependencies
     * - Real two-order native builder and balance consumer.
     * @scenario
     * - Supply exactly two values plus their multiplied gas maximum fees.
     * @expected
     * - Both transactions fit the total balance with consecutive nonces.
     */
    it('admits the exact aggregate value plus fee boundary', async () => {
      const { chain, balance } = createManagementFixture(4002000n, 100000n);
      const orders = [
        { address, assets: { nativeToken: 1000n, tokens: [] } },
        { address: coldAddress, assets: { nativeToken: 1000n, tokens: [] } },
      ];
      const result = await chain.generateMultipleTransactions(
        eventId,
        TransactionType.arbitrary,
        orders,
        [],
        [],
      );
      expect(
        result.map(
          (p) =>
            Transaction.from('0x' + Buffer.from(p.txBytes).toString('hex'))
              .nonce,
        ),
      ).toEqual([4, 5]);
      expect(balance).toHaveBeenCalledWith(address);
      const required = await Promise.all(
        result.map((payment) => chain.getTransactionAssets(payment)),
      );
      expect(
        required.reduce(
          (total, assets) => total + assets.inputAssets.nativeToken,
          0n,
        ),
      ).toEqual(4002000n);
    });
  });

  describe('rawTxToPaymentTransaction', () => {
    /**
     * @target AvalancheChain.rawTxToPaymentTransaction rejects changed literal identity %s
     * @dependencies
     * - Real manual converter and one changed chain instance identity field.
     * @scenario
     * - Replace CHAIN or NATIVE_TOKEN_ID before converting valid native type-2 JSON.
     * @expected
     * - The public converter rejects before network qualification.
     */
    it.each(['CHAIN', 'NATIVE_TOKEN_ID'])(
      'rejects changed literal identity %s',
      async (field) => {
        const { chain, networkCheck } = createManagementFixture();
        const payment = createManagementPayment(TransactionType.manual);
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        Reflect.set(chain, field, 'foreign');
        await expect(
          chain.rawTxToPaymentTransaction(JSON.stringify(tx.toJSON())),
        ).rejects.toThrow('Invalid Avalanche raw manual transaction');
        expect(networkCheck).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.rawTxToPaymentTransaction enforces gas ceiling with multiplier $multiplier at offset $offset
     * @dependencies
     * - Real manual converter and self-consistent type-2 JSON.
     * @scenario
     * - Convert an unsigned envelope at the exact multiplied ceiling or one above it.
     * @expected
     * - Equality is qualified; excess refuses before qualification or signing.
     */
    it.each(
      [1n, 2n].flatMap((multiplier) =>
        [0n, 1n].map((offset) => ({ multiplier, offset })),
      ),
    )(
      'enforces gas ceiling with multiplier $multiplier at offset $offset',
      async ({ multiplier, offset }) => {
        const { chain, networkCheck, sign } = createManagementFixture(
          10000000n,
          21000n,
          43113n,
          {
            gasLimitCap: 50000n,
            gasLimitMultiplier: multiplier,
          },
        );
        const payment = createManagementPayment(
          TransactionType.manual,
          43113n,
          false,
          50000n * multiplier + offset,
        );
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        const converted = chain.rawTxToPaymentTransaction(
          JSON.stringify(tx.toJSON()),
        );
        if (offset !== 0n)
          await expect(converted).rejects.toThrow(
            'Invalid Avalanche raw manual transaction',
          );
        else expect((await converted).txId).toEqual(payment.txId);
        expect(networkCheck).toHaveBeenCalledTimes(offset === 0n ? 1 : 0);
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.rawTxToPaymentTransaction admits an unsigned native manual envelope on %s
     * @dependencies
     * - Real chain and raw Ethers type-2 JSON.
     * @scenario
     * - Convert unsigned native manual bytes on each explicitly selected network.
     * @expected
     * - The exact bytes and empty manual identity survive network qualification.
     */
    it.each([43113n, 43114n])(
      'admits an unsigned native manual envelope on %s',
      async (id) => {
        const { chain, networkCheck } = createManagementFixture(
          10000000n,
          21000n,
          id,
        );
        const p = createManagementPayment(TransactionType.manual, id);
        const tx = Transaction.from(
          '0x' + Buffer.from(p.txBytes).toString('hex'),
        );
        const converted = await chain.rawTxToPaymentTransaction(
          JSON.stringify(tx.toJSON()),
        );
        expect([
          converted.txType,
          converted.eventId,
          Buffer.from(converted.txBytes).toString('hex'),
        ]).toEqual([
          TransactionType.manual,
          '',
          Buffer.from(p.txBytes).toString('hex'),
        ]);
        expect(networkCheck).toHaveBeenCalledTimes(1);
      },
    );

    /**
     * @target AvalancheChain.rawTxToPaymentTransaction rejects malformed raw %s before RPC or signing
     * @dependencies
     * - Real chain and one isolated malformed raw native envelope.
     * @scenario
     * - Supply signed, wrong-chain, contract-data, access-list, zero-value or legacy JSON.
     * @expected
     * - The converter refuses before qualification and signer calls.
     */
    it.each([
      'signed',
      'wrong chain',
      'call data',
      'access list',
      'zero value',
      'zero gas',
      'zero recipient',
      'legacy',
      'bad JSON',
    ])('rejects malformed raw %s before RPC or signing', async (kind) => {
      const { chain, networkCheck, sign } = createManagementFixture();
      let tx = Transaction.from(
        '0x' +
          Buffer.from(
            createManagementPayment(TransactionType.manual).txBytes,
          ).toString('hex'),
      );
      if (kind === 'signed') tx.signature = key.sign(tx.unsignedHash);
      if (kind === 'wrong chain') tx.chainId = 43114n;
      if (kind === 'call data') tx.data = '0xa9059cbb';
      if (kind === 'access list')
        tx.accessList = [{ address, storageKeys: [] }];
      if (kind === 'zero value') tx.value = 0n;
      if (kind === 'zero gas') tx.gasLimit = 0n;
      if (kind === 'zero recipient') tx.to = '0x' + '00'.repeat(20);
      if (kind === 'legacy')
        tx = Transaction.from({
          type: 0,
          chainId: 43113n,
          to: address,
          value: 1000n,
          gasLimit: 42000n,
          gasPrice: 10n,
          data: '0x',
        });
      await expect(
        chain.rawTxToPaymentTransaction(
          kind === 'bad JSON' ? '{' : JSON.stringify(tx.toJSON()),
        ),
      ).rejects.toThrow();
      expect(networkCheck).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });
  });

  describe('signTransaction', () => {
    /**
     * @target AvalancheChain.signTransaction rejects changed literal identity %s before signature admission
     * @dependencies
     * - Real native signer preflight and deterministic RPC/signer mocks.
     * @scenario
     * - Replace a literal identity before signing; when changing CHAIN also change the payment metadata network.
     * @expected
     * - Matching changed strings cannot admit another network or asset; no qualifier, fee or signer follows.
     */
    it.each(['CHAIN', 'NATIVE_TOKEN_ID'])(
      'rejects changed literal identity %s before signature admission',
      async (field) => {
        const { chain, networkCheck, gas, fees, sign } =
          createManagementFixture();
        const payment = createManagementPayment(TransactionType.manual);
        Reflect.set(chain, field, 'foreign');
        if (field === 'CHAIN') payment.network = 'foreign';
        expect(chain.verifyTransactionExtraConditions(payment)).toEqual(false);
        await expect(chain.signTransaction(payment, 1)).rejects.toThrow(
          'Invalid C-Chain payment for signing',
        );
        for (const mock of [networkCheck, gas, fees, sign])
          expect(mock).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.signTransaction enforces gas ceiling with multiplier $multiplier at offset $offset
     * @dependencies
     * - Real signing preflight and synthetic lock signature mediator.
     * @scenario
     * - Sign one manual envelope at the exact ceiling or one above it with matching estimates.
     * @expected
     * - Equality signs once; excess rejects before qualification, fees or signer admission.
     */
    it.each(
      [1n, 2n].flatMap((multiplier) =>
        [0n, 1n].map((offset) => ({ multiplier, offset })),
      ),
    )(
      'enforces gas ceiling with multiplier $multiplier at offset $offset',
      async ({ multiplier, offset }) => {
        const { chain, networkCheck, sign, gas, fees } =
          createManagementFixture(10000000n, 50000n, 43113n, {
            gasLimitCap: 50000n,
            gasLimitMultiplier: multiplier,
          });
        const payment = createManagementPayment(
          TransactionType.manual,
          43113n,
          false,
          50000n * multiplier + offset,
        );
        const signature = key.sign(payment.txId);
        sign.mockResolvedValue({
          signature: signature.r.slice(2) + signature.s.slice(2),
          signatureRecovery: signature.yParity,
        });
        const signed = chain.signTransaction(payment, 1);
        if (offset !== 0n) {
          await expect(signed).rejects.toThrow(
            'Invalid C-Chain payment for signing',
          );
          for (const mock of [networkCheck, gas, fees, sign])
            expect(mock).not.toHaveBeenCalled();
        } else {
          expect(
            chain.verifyTransactionExtraConditions(
              await signed,
              SigningStatus.Signed,
            ),
          ).toEqual(true);
          expect(sign).toHaveBeenCalledTimes(1);
        }
      },
    );

    /**
     * @target AvalancheChain.signTransaction signs native %s with the configured lock signer
     * @dependencies
     * - Real chain, fee checks and inherited signing consumer.
     * - Public synthetic fixture key only.
     * @scenario
     * - Return the real fixture signature from the mediator for each management route.
     * @expected
     * - Signed bytes retain route, event, chain and configured lock signer.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('signs native %s with the configured lock signer', async (type) => {
      const { chain, sign } = createManagementFixture();
      const p = createManagementPayment(type);
      const tx = Transaction.from(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
      const signature = key.sign(tx.unsignedHash);
      sign.mockResolvedValue({
        signature: signature.r.slice(2) + signature.s.slice(2),
        signatureRecovery: signature.yParity,
      });
      const result = await chain.signTransaction(p, 1);
      expect(
        chain.verifyTransactionExtraConditions(result, SigningStatus.Signed),
      ).toEqual(true);
      expect([result.eventId, result.txType, result.txId]).toEqual([
        p.eventId,
        type,
        p.txId,
      ]);
      expect(sign).toHaveBeenCalledTimes(1);
    });
  });

  describe('submitAuthorizedTransaction', () => {
    /**
     * @target AvalancheChain.submitAuthorizedTransaction compares exact signed AVAX reserve at wei offset %s
     * @dependencies
     * - Real eighteen-to-nine TokenMap, signed native preflight and mocked qualified dispatcher.
     * @scenario
     * - Use a signed manual value plus a nonaligned maximum gas fee; balance equals the raw requirement or is one wei less.
     * @expected
     * - Literal raw equality starts once; a one-wei deficit reaches neither dispatcher nor authority.
     */
    it.each([-1n, 0n])(
      'compares exact signed AVAX reserve at wei offset %s',
      async (offset) => {
        const { chain, network, balance } =
          await createMappedManagementFixture();
        const original = createManagementPayment(TransactionType.manual);
        const tx = Transaction.from(
          '0x' + Buffer.from(original.txBytes).toString('hex'),
        );
        tx.value = 1000n * 1000000000n;
        tx.maxFeePerGas = 10000000003n;
        tx.signature = key.sign(tx.unsignedHash);
        const requiredWei = tx.value + tx.gasLimit * tx.maxFeePerGas;
        balance.mockResolvedValue(requiredWei + offset);
        const payment = new PaymentTransaction(
          'avalanche',
          tx.unsignedHash,
          '',
          Buffer.from(tx.serialized.slice(2), 'hex'),
          TransactionType.manual,
        );
        const start = vi.fn(),
          authority = vi.fn(async (run: () => void) => {
            run();
          });
        const dispatcher = vi
          .spyOn(network, 'submitAuthorizedTransaction')
          .mockImplementation(async (_tx, authorize) => {
            await authorize(start);
          });
        const submitted = chain.submitAuthorizedTransaction(payment, authority);
        if (offset < 0n) {
          await expect(submitted).rejects.toThrow(
            'Insufficient authorized C-Chain assets',
          );
          for (const mock of [dispatcher, authority, start])
            expect(mock).not.toHaveBeenCalled();
        } else {
          await submitted;
          expect(start).toHaveBeenCalledTimes(1);
        }
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects changed literal identity %s before transport admission
     * @dependencies
     * - Real signed native preflight with qualified dispatcher and final authority spies.
     * @scenario
     * - Replace a literal chain or native asset identity before qualified submission.
     * @expected
     * - No network qualification, gas, balance, dispatcher or authority call follows.
     */
    it.each(['CHAIN', 'NATIVE_TOKEN_ID'])(
      'rejects changed literal identity %s before transport admission',
      async (field) => {
        const { chain, network, networkCheck, gas, balance } =
          createManagementFixture();
        const payment = createManagementPayment(
          TransactionType.manual,
          43113n,
          true,
        );
        Reflect.set(chain, field, 'foreign');
        if (field === 'CHAIN') payment.network = 'foreign';
        const dispatcher = vi.spyOn(network, 'submitAuthorizedTransaction');
        const authority = vi.fn();
        await expect(
          chain.submitAuthorizedTransaction(payment, authority),
        ).rejects.toThrow('Invalid authorized C-Chain submission');
        for (const mock of [networkCheck, gas, balance, dispatcher, authority])
          expect(mock).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction enforces signed gas ceiling with multiplier $multiplier at offset $offset
     * @dependencies
     * - Real native gas and asset preflight with mocked qualified dispatch and explicit authority.
     * @scenario
     * - Submit a signed manual envelope at the exact ceiling or one above it.
     * @expected
     * - Equality reaches one authorized start; excess reaches neither preflight nor dispatch nor authority.
     */
    it.each(
      [1n, 2n].flatMap((multiplier) =>
        [0n, 1n].map((offset) => ({ multiplier, offset })),
      ),
    )(
      'enforces signed gas ceiling with multiplier $multiplier at offset $offset',
      async ({ multiplier, offset }) => {
        const { chain, network, networkCheck, gas, balance } =
          createManagementFixture(10000000n, 50000n, 43113n, {
            gasLimitCap: 50000n,
            gasLimitMultiplier: multiplier,
          });
        const payment = createManagementPayment(
          TransactionType.manual,
          43113n,
          true,
          50000n * multiplier + offset,
        );
        const start = vi.fn();
        const dispatch = vi
          .spyOn(network, 'submitAuthorizedTransaction')
          .mockImplementation(async (_tx, authorize) => {
            await authorize(start);
          });
        const authority = vi.fn(async (run: () => void) => {
          run();
        });
        const submitted = chain.submitAuthorizedTransaction(payment, authority);
        if (offset !== 0n) {
          await expect(submitted).rejects.toThrow(
            'Invalid authorized C-Chain submission',
          );
          for (const mock of [
            networkCheck,
            gas,
            balance,
            dispatch,
            authority,
            start,
          ])
            expect(mock).not.toHaveBeenCalled();
        } else {
          await submitted;
          expect(dispatch).toHaveBeenCalledTimes(1);
          expect(authority).toHaveBeenCalledTimes(1);
          expect(start).toHaveBeenCalledTimes(1);
        }
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction requires explicit authority for native %s
     * @dependencies
     * - Real native preflight and signed management envelope.
     * - Mock qualified transport boundary and explicit authority callback.
     * @scenario
     * - Attempt legacy submission, then admit exactly one qualified start.
     * @expected
     * - Legacy submission refuses without RPC; qualified submission preserves signed bytes and starts once.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('requires explicit authority for native %s', async (type) => {
      const { chain, network, networkCheck } = createManagementFixture();
      const p = createManagementPayment(type, 43113n, true);
      const start = vi.fn();
      const dispatch = vi
        .spyOn(network, 'submitAuthorizedTransaction')
        .mockImplementation(async (_tx, authorize) => {
          await authorize(start);
        });
      await expect(chain.submitTransaction(p)).rejects.toThrow(
        'requires authorized submission',
      );
      expect(networkCheck).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      const authority = vi.fn(async (run: () => void) => {
        run();
      });
      await chain.submitAuthorizedTransaction(p, authority);
      expect(authority).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0].serialized).toEqual(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
    });
  });
});
