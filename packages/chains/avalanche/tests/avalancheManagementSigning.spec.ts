import { SigningKey, Transaction } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransactionType } from '@rosen-chains/abstract-chain';

import {
  coldAddress,
  createManagementFixture,
  createManagementPayment,
} from './avalancheManagementTestUtils';
import { address } from './avalancheTestData';
import { closeChainFixtures, key } from './avalancheTestUtils';

describe('AvalancheChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeChainFixtures();
  });
  describe('signTransaction', () => {
    /**
     * @target AvalancheChain.signTransaction rejects $kind mutation during $stage for $type before the signer
     * @dependencies
     * - Real chain and native route envelope with isolated qualifier/fee mutation.
     * @scenario
     * - Change one caller field, configuration, adapter or signing authority at an await boundary.
     * @expected
     * - Signing fails before the mediator can observe any digest.
     */
    it.each(
      [
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        ['qualification', 'fee'].flatMap((stage) =>
          [
            'bytes',
            'event',
            'type',
            'ID',
            'network metadata',
            'lock',
            'cold',
            'chainId',
            'expected chain',
            'network',
            'mediator',
            'sign method',
            'fee method',
            'gas producer',
            'fee producer',
            'gas slippage',
            'price slippage',
            'verifier',
          ].map((kind) => ({ type, stage, kind })),
        ),
      ),
    )(
      'rejects $kind mutation during $stage for $type before the signer',
      async ({ type, stage, kind }) => {
        const { chain, network, networkCheck, sign } =
          createManagementFixture();
        const p = createManagementPayment(type);
        /** Apply one case-local change exactly at the selected signing wait boundary. */
        const mutate = () => {
          if (kind === 'bytes') p.txBytes[0] ^= 1;
          if (kind === 'event') p.eventId = 'different';
          if (kind === 'type') p.txType = TransactionType.reward;
          if (kind === 'ID') p.txId = '0x' + 'ff'.repeat(32);
          if (kind === 'network metadata') p.network = 'other';
          if (kind === 'lock') chain.configs.addresses.lock = coldAddress;
          if (kind === 'cold') chain.configs.addresses.cold = address;
          if (kind === 'chainId') Reflect.set(chain, 'CHAIN_ID', 43114n);
          if (kind === 'expected chain')
            Reflect.set(network, 'expectedChainId', 43114n);
          if (kind === 'network') Reflect.set(chain, 'network', {});
          if (kind === 'mediator')
            Reflect.set(chain, 'signMediator', { sign: vi.fn() });
          if (kind === 'sign method') chain['signMediator'].sign = vi.fn();
          if (kind === 'fee method')
            chain.verifyTransactionFee = vi.fn(async () => true);
          if (kind === 'gas producer')
            Reflect.set(network, 'getGasRequired', vi.fn());
          if (kind === 'fee producer')
            Reflect.set(network, 'getFeeData', vi.fn());
          if (kind === 'gas slippage') chain.configs.gasLimitSlippage += 1n;
          if (kind === 'price slippage') chain.configs.gasPriceSlippage += 1n;
          if (kind === 'verifier')
            chain.verifyTransactionExtraConditions = vi.fn(() => true);
        };
        if (stage === 'qualification')
          networkCheck.mockImplementation(async () => {
            mutate();
          });
        else
          vi.spyOn(chain, 'verifyTransactionFee').mockImplementation(
            async () => {
              mutate();
              return true;
            },
          );
        await expect(chain.signTransaction(p, 1)).rejects.toThrow(
          'signing authority changed',
        );
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.signTransaction refuses a wrong lock signer for %s
     * @dependencies
     * - Real native route and inherited signature reconstruction.
     * - Two public synthetic fixture scalars.
     * @scenario
     * - Return a correctly formatted signature from the other synthetic account.
     * @expected
     * - The signed result fails configured lock binding.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('refuses a wrong lock signer for %s', async (type) => {
      const { chain, sign } = createManagementFixture();
      const p = createManagementPayment(type);
      const signature = new SigningKey('0x' + '33'.repeat(32)).sign(p.txId);
      sign.mockResolvedValue({
        signature: signature.r.slice(2) + signature.s.slice(2),
        signatureRecovery: signature.yParity,
      });
      await expect(chain.signTransaction(p, 1)).rejects.toThrow(
        'signer returned an invalid payment',
      );
      expect(sign).toHaveBeenCalledTimes(1);
    });

    /**
     * @target AvalancheChain.signTransaction refuses a changed caller during the signer for %s
     * @dependencies
     * - Real native signing path and deterministic signature callback.
     * @scenario
     * - Return the valid signature while changing the original caller-owned bytes.
     * @expected
     * - The result is refused and the mediator digest remains the original hash.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('refuses a changed caller during the signer for %s', async (type) => {
      const { chain, sign } = createManagementFixture();
      const p = createManagementPayment(type);
      const txId = p.txId;
      sign.mockImplementation(async () => {
        const signature = key.sign(txId);
        p.txBytes[0] ^= 1;
        return {
          signature: signature.r.slice(2) + signature.s.slice(2),
          signatureRecovery: signature.yParity,
        };
      });
      await expect(chain.signTransaction(p, 1)).rejects.toThrow(
        'signing authority changed',
      );
      expect(Buffer.from(sign.mock.calls[0][0]).toString('hex')).toEqual(
        txId.slice(2),
      );
    });

    /**
     * @target AvalancheChain.signTransaction refuses invalid required signature count %s before RPC
     * @dependencies
     * - Real native manual route and isolated invalid threshold.
     * @scenario
     * - Supply zero, negative, fractional or unsafe signature counts.
     * @expected
     * - Neither qualification nor the signer runs.
     */
    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      'refuses invalid required signature count %s before RPC',
      async (count) => {
        const { chain, networkCheck, sign } = createManagementFixture();
        await expect(
          chain.signTransaction(
            createManagementPayment(TransactionType.manual),
            count,
          ),
        ).rejects.toThrow('Invalid C-Chain payment for signing');
        expect(networkCheck).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
      },
    );
  });

  describe('rawTxToPaymentTransaction', () => {
    /**
     * @target AvalancheChain.rawTxToPaymentTransaction refuses %s drift during qualification
     * @dependencies
     * - Real native raw manual converter and isolated network qualification mutation.
     * @scenario
     * - Change one selected-chain, address, qualifier or verifier field while qualification awaits.
     * @expected
     * - No converted manual transaction survives the changed lease.
     */
    it.each([
      'cold',
      'lock',
      'chainId',
      'expected chain',
      'network',
      'qualifier',
      'verifier',
    ])('refuses %s drift during qualification', async (kind) => {
      const { chain, network, networkCheck } = createManagementFixture();
      const tx = Transaction.from(
        '0x' +
          Buffer.from(
            createManagementPayment(TransactionType.manual).txBytes,
          ).toString('hex'),
      );
      networkCheck.mockImplementation(async () => {
        if (kind === 'cold') chain.configs.addresses.cold = address;
        if (kind === 'lock') chain.configs.addresses.lock = coldAddress;
        if (kind === 'chainId') Reflect.set(chain, 'CHAIN_ID', 43114n);
        if (kind === 'expected chain')
          Reflect.set(network, 'expectedChainId', 43114n);
        if (kind === 'network') Reflect.set(chain, 'network', {});
        if (kind === 'qualifier') network.assertNetwork = vi.fn(async () => {});
        if (kind === 'verifier')
          chain.verifyTransactionExtraConditions = vi.fn(() => true);
      });
      await expect(
        chain.rawTxToPaymentTransaction(JSON.stringify(tx.toJSON())),
      ).rejects.toThrow('raw manual transaction changed');
    });
  });

  describe('submitAuthorizedTransaction', () => {
    /**
     * @target AvalancheChain.submitAuthorizedTransaction blocks $kind before native $type transport start
     * @dependencies
     * - Real preflight with native lock accounting and captured signed management bytes.
     * - Isolated final authority callback and mock transport start.
     * @scenario
     * - Change caller bytes, chain policy, adapter or methods immediately before the callback starts transport.
     * @expected
     * - The physical start callback is never reached.
     */
    it.each(
      [
        TransactionType.coldStorage,
        TransactionType.manual,
        TransactionType.arbitrary,
      ].flatMap((type) =>
        [
          'bytes',
          'cold',
          'lock',
          'expected chain',
          'dispatch',
          'qualifier',
          'gas method',
          'assets method',
          'enough method',
          'verifier',
        ].map((kind) => ({ type, kind })),
      ),
    )(
      'blocks $kind before native $type transport start',
      async ({ type, kind }) => {
        const { chain, network } = createManagementFixture();
        const p = createManagementPayment(type, 43113n, true);
        const start = vi.fn();
        vi.spyOn(network, 'submitAuthorizedTransaction').mockImplementation(
          async (_tx, authorize) => {
            await authorize(start);
          },
        );
        await expect(
          chain.submitAuthorizedTransaction(p, async (run) => {
            if (kind === 'bytes') p.txBytes[0] ^= 1;
            if (kind === 'cold') chain.configs.addresses.cold = address;
            if (kind === 'lock') chain.configs.addresses.lock = coldAddress;
            if (kind === 'expected chain')
              Reflect.set(network, 'expectedChainId', 43114n);
            if (kind === 'dispatch')
              network.submitAuthorizedTransaction = vi.fn(async () => {});
            if (kind === 'qualifier')
              network.assertNetwork = vi.fn(async () => {});
            if (kind === 'gas method')
              network.getGasRequired = vi.fn(async () => 21000n);
            if (kind === 'assets method') chain.getTransactionAssets = vi.fn();
            if (kind === 'enough method')
              chain.hasLockAddressEnoughAssets = vi.fn(async () => true);
            if (kind === 'verifier')
              chain.verifyTransactionExtraConditions = vi.fn(() => true);
            run();
          }),
        ).rejects.toThrow('Authorized C-Chain payment changed');
        expect(start).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction refuses final authority %s
     * @dependencies
     * - Real native manual preflight and mocked qualified dispatcher.
     * @scenario
     * - Omit, throw, withhold or repeat the required final authority start.
     * @expected
     * - Missing/withheld authority never starts; duplicate authority starts at most once.
     */
    it.each(['missing', 'throw', 'withheld', 'duplicate'])(
      'refuses final authority %s',
      async (kind) => {
        const { chain, network } = createManagementFixture();
        const p = createManagementPayment(TransactionType.manual, 43113n, true);
        const start = vi.fn();
        const dispatch = vi
          .spyOn(network, 'submitAuthorizedTransaction')
          .mockImplementation(async (_tx, authorize) => {
            await authorize(start);
          });
        const authority =
          kind === 'missing'
            ? undefined
            : async (run: () => void) => {
                if (kind === 'throw')
                  throw new Error('Synthetic authority refused');
                if (kind === 'withheld') return;
                run();
                if (kind === 'duplicate') run();
              };
        await expect(
          chain.submitAuthorizedTransaction(
            p,
            authority as (run: () => void) => Promise<void>,
          ),
        ).rejects.toThrow();
        expect(start).toHaveBeenCalledTimes(kind === 'duplicate' ? 1 : 0);
        if (kind === 'missing') expect(dispatch).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects the wrong RPC chain before gas preflight
     * @dependencies
     * - Real RPC chain qualification and signed native manual envelope.
     * @scenario
     * - Report an unrelated Ethereum chain from the actual provider identity read.
     * @expected
     * - No gas, asset or qualified transport effect follows.
     */
    it('rejects the wrong RPC chain before gas preflight', async () => {
      const { chain, network, networkCheck, gas } = createManagementFixture();
      networkCheck.mockRestore();
      vi.spyOn(network['provider'], 'send').mockResolvedValue('0x1');
      const dispatch = vi.spyOn(network, 'submitAuthorizedTransaction');
      await expect(
        chain.submitAuthorizedTransaction(
          createManagementPayment(TransactionType.manual, 43113n, true),
          async (run) => {
            run();
          },
        ),
      ).rejects.toThrow();
      expect(gas).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
