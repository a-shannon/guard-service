import { FeeData, SigningKey, Transaction } from 'ethers';
import { createServer } from 'node:http';
import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  PaymentTransaction,
  SigningStatus,
  TransactionType,
} from '@rosen-chains/abstract-chain';

import { address, eventId, configs } from './avalancheTestData';
import {
  createChainFixture as setup,
  createPayment as payment,
  createAuthorizedChainFixture,
  allow,
  key,
  closeChainFixtures,
} from './avalancheTestUtils';
import { mockSubmission } from './mocked/avalancheChain.mock';

describe('AvalancheChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeChainFixtures();
  });
  describe('verifyTransactionExtraConditions', () => {
    /**
     * @target AvalancheChain.verifyTransactionExtraConditions rejects unsupported %s generation, signing and submission before RPC
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Set each unsupported route on an unsigned payment, check verification, then try generation, signing and signed submission.
     * @expected
     * - Every route rejects before network identity checks or synthetic signing.
     */
    it.each([TransactionType.lock, TransactionType.reward])(
      'rejects unsupported %s generation, signing and submission before RPC',
      async (type) => {
        const { chain, sign, networkCheck } = setup();
        const p = payment();
        p.txType = type;
        expect(chain.verifyTransactionExtraConditions(p)).toEqual(false);
        await expect(async () => {
          await chain.generateTransaction(eventId, type, [], [], []);
        }).rejects.toThrow('Unsupported Avalanche transaction route');
        await expect(async () => {
          await chain.signTransaction(p, 1);
        }).rejects.toThrow('Invalid C-Chain');
        const signed = Transaction.from(
          '0x' + Buffer.from(p.txBytes).toString('hex'),
        );
        signed.signature = new SigningKey('0x' + '11'.repeat(32)).sign(
          signed.unsignedHash,
        );
        p.txBytes = Buffer.from(signed.serialized.slice(2), 'hex');
        expect(
          chain.verifyTransactionExtraConditions(p, SigningStatus.Signed),
        ).toEqual(false);
        await expect(async () => {
          await chain.submitTransaction(p);
        }).rejects.toThrow('Invalid C-Chain');
        expect(sign).not.toHaveBeenCalled();
        expect(networkCheck).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions binds identity and type-2 payment to %s
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Construct each supported C-Chain identity and verify a matching type-2 payment.
     * @expected
     * - Chain/native identity and extractor identity match; the payment is accepted.
     */
    it.each([43113n, 43114n])(
      'binds identity and type-2 payment to %s',
      (id) => {
        const { chain } = setup(id);
        expect([chain.CHAIN, chain.NATIVE_TOKEN_ID, chain.CHAIN_ID]).toEqual([
          'avalanche',
          'avax',
          id,
        ]);
        expect(chain.extractor?.chain).toEqual('avalanche');
        expect(chain.verifyTransactionExtraConditions(payment(id))).toEqual(
          true,
        );
      },
    );

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions rejects a self-consistent legacy payment
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Build a canonical legacy transaction payment and verify its envelope.
     * @expected
     * - The payment type is rejected.
     */
    it('rejects a self-consistent legacy payment', () => {
      expect(
        setup().chain.verifyTransactionExtraConditions(payment(43113n, 0)),
      ).toEqual(false);
    });

    /**
     * @target AvalancheChain.verifyTransactionExtraConditions distinguishes signed and unsigned payment envelopes
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Check an unsigned envelope as signed, add its synthetic signature, and check both verification modes.
     * @expected
     * - Unsigned and signed envelopes are accepted only in their matching mode.
     */
    it('distinguishes signed and unsigned payment envelopes', () => {
      const { chain } = setup();
      const p = payment();
      expect(
        chain.verifyTransactionExtraConditions(p, SigningStatus.Signed),
      ).toEqual(false);
      const tx = Transaction.from(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
      tx.signature = new SigningKey('0x' + '11'.repeat(32)).sign(
        tx.unsignedHash,
      );
      p.txBytes = Buffer.from(tx.serialized.slice(2), 'hex');
      expect(chain.verifyTransactionExtraConditions(p)).toEqual(false);
      expect(
        chain.verifyTransactionExtraConditions(p, SigningStatus.Signed),
      ).toEqual(true);
    });
  });
  describe('getTxRequiredConfirmation', () => {
    /**
     * @target AvalancheChain.getTxRequiredConfirmation retains every configured policy while refusing rewards
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Read all five confirmation policies and request reward confirmations.
     * @expected
     * - Configured values persist; reward confirmations reject without RPC.
     */
    it('retains every configured policy while refusing rewards', () => {
      const { chain, networkCheck } = setup();
      expect(chain.getTxRequiredConfirmation(TransactionType.lock)).toEqual(
        configs.confirmations.observation,
      );
      expect(chain.getTxRequiredConfirmation(TransactionType.payment)).toEqual(
        configs.confirmations.payment,
      );
      expect(
        chain.getTxRequiredConfirmation(TransactionType.coldStorage),
      ).toEqual(configs.confirmations.cold);
      expect(chain.getTxRequiredConfirmation(TransactionType.manual)).toEqual(
        configs.confirmations.manual,
      );
      expect(
        chain.getTxRequiredConfirmation(TransactionType.arbitrary),
      ).toEqual(configs.confirmations.arbitrary);
      expect(() =>
        chain.getTxRequiredConfirmation(TransactionType.reward),
      ).toThrow('Unsupported Avalanche transaction route');
      expect(networkCheck).not.toHaveBeenCalled();
    });
  });
  describe('signTransaction', () => {
    /**
     * @target AvalancheChain.signTransaction rejects an isolated wrong %s before signing
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Mutate one payment envelope field and attempt verification and signing.
     * @expected
     * - The isolated mutation fails verification and signing before signer or RPC.
     */
    it.each([
      [
        'network',
        (p: PaymentTransaction) => {
          p.network = 'ethereum';
        },
      ],
      [
        'identifier',
        (p: PaymentTransaction) => {
          p.txId = '0x' + '00'.repeat(32);
        },
      ],
      [
        'event length',
        (p: PaymentTransaction) => {
          p.eventId = 'ab';
        },
      ],
      [
        'event binding',
        (p: PaymentTransaction) => {
          p.eventId = 'cd'.repeat(32);
        },
      ],
      [
        'bytes',
        (p: PaymentTransaction) => {
          p.txBytes = Uint8Array.from([0]);
        },
      ],
    ] as const)(
      'rejects an isolated wrong %s before signing',
      async (_, mutate) => {
        const { chain, sign, networkCheck } = setup();
        const p = payment();
        mutate(p);
        expect(chain.verifyTransactionExtraConditions(p)).toEqual(false);
        await expect(async () => {
          await chain.signTransaction(p, 1);
        }).rejects.toThrow('Invalid C-Chain');
        expect(sign).not.toHaveBeenCalled();
        expect(networkCheck).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.signTransaction rejects a self-consistent wrong chain %s before signing
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Build an internally consistent payment for each wrong chain and attempt signing.
     * @expected
     * - Signing rejects the chain mismatch before invoking the synthetic signer.
     */
    it.each([1n, 43114n, 0n])(
      'rejects a self-consistent wrong chain %s before signing',
      async (id) => {
        const { chain, sign } = setup();
        await expect(async () => {
          await chain.signTransaction(payment(id), 1);
        }).rejects.toThrow('Invalid C-Chain');
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.signTransaction checks current network before the signer
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Make the network identity check reject and attempt signing a valid payment.
     * @expected
     * - The network error propagates and the synthetic signer is not called.
     */
    it('checks current network before the signer', async () => {
      const { chain, networkCheck, sign } = setup();
      networkCheck.mockRejectedValue(new Error('wrong RPC network'));
      await expect(async () => {
        await chain.signTransaction(payment(), 1);
      }).rejects.toThrow('wrong RPC network');
      expect(sign).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.signTransaction passes the valid unsigned body hash to the synthetic signer
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Attempt signing a valid unsigned payment with a synthetic signer that rejects.
     * @expected
     * - The signer receives exactly the unsigned body hash before its error propagates.
     */
    it('passes the valid unsigned body hash to the synthetic signer', async () => {
      const { chain, sign } = setup();
      const p = payment();
      await expect(async () => {
        await chain.signTransaction(p, 1);
      }).rejects.toThrow('Synthetic signer reached');
      expect(Buffer.from(sign.mock.calls[0][0]).toString('hex')).toEqual(
        p.txId.slice(2),
      );
    });

    /**
     * @target AvalancheChain.signTransaction checks the signed result from the synthetic signer
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Return a synthetic signature for the correct body and parse the signed payment.
     * @expected
     * - The result passes signed-envelope verification and recovers the configured address.
     */
    it('checks the signed result from the synthetic signer', async () => {
      const { chain, sign } = setup();
      const p = payment();
      const signature = new SigningKey('0x' + '11'.repeat(32)).sign(p.txId);
      sign.mockResolvedValue({
        signature: signature.r.slice(2) + signature.s.slice(2),
        signatureRecovery: signature.yParity,
      });
      const signed = await chain.signTransaction(p, 1);
      expect(
        chain.verifyTransactionExtraConditions(signed, SigningStatus.Signed),
      ).toEqual(true);
      expect(
        Transaction.from('0x' + Buffer.from(signed.txBytes).toString('hex'))
          .from,
      ).toEqual(address);
    });

    /**
     * @target AvalancheChain.signTransaction rejects a result signed by a different synthetic key
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Return a signature from another synthetic account for the same unsigned hash.
     * @expected
     * - Signing rejects the resulting signer mismatch.
     */
    it('rejects a result signed by a different synthetic key', async () => {
      const { chain, sign } = setup();
      const p = payment();
      const signature = new SigningKey('0x' + '22'.repeat(32)).sign(p.txId);
      sign.mockResolvedValue({
        signature: signature.r.slice(2) + signature.s.slice(2),
        signatureRecovery: signature.yParity,
      });
      await expect(async () => {
        await chain.signTransaction(p, 1);
      }).rejects.toThrow('signer returned an invalid payment');
    });
  });
  describe('verifyTransactionFee', () => {
    /**
     * @target AvalancheChain.verifyTransactionFee refuses gas estimate %s with limit %s before signing
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Set each raw estimate, payment limit and multiplier; verify envelope/fee and attempt signing.
     * @expected
     * - Invalid estimates refuse fees and signing; a limit beyond the static ceiling also refuses the envelope.
     */
    it.each([
      [300000n, 200000n, 2n],
      [300000n, 600000n, 2n],
      [50000n, 45000n, 1n],
      [0n, 42000n, 2n],
      [-1n, 42000n, 2n],
    ])(
      'refuses gas estimate %s with limit %s before signing',
      async (estimate, limit, multiplier) => {
        const { chain, network, sign } = setup(43113n, {
          ...configs,
          gasLimitMultiplier: multiplier,
        });
        vi.mocked(network.getGasRequired).mockResolvedValue(estimate);
        const p = payment(43113n, 2, limit);
        const validEnvelope = limit <= configs.gasLimitCap * multiplier;
        expect(chain.verifyTransactionExtraConditions(p)).toEqual(
          validEnvelope,
        );
        expect(await chain.verifyTransactionFee(p)).toEqual(false);
        await expect(async () => {
          await chain.signTransaction(p, 1);
        }).rejects.toThrow(
          validEnvelope
            ? 'fee for signing'
            : 'Invalid C-Chain payment for signing',
        );
        expect(sign).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.verifyTransactionFee accepts the raw gas estimate at the lower tolerance boundary
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Set multiplier one and raw gas estimate equal to the lower tolerated payment limit.
     * @expected
     * - Fee verification accepts the exact boundary.
     */
    it('accepts the raw gas estimate at the lower tolerance boundary', async () => {
      const { chain, network } = setup(43113n, {
        ...configs,
        gasLimitMultiplier: 1n,
      });
      vi.mocked(network.getGasRequired).mockResolvedValue(50000n);
      expect(
        await chain.verifyTransactionFee(payment(43113n, 2, 50000n)),
      ).toEqual(true);
    });
  });
  describe('submitTransaction', () => {
    /**
     * @target AvalancheChain.submitTransaction refuses unsigned submission before contacting the RPC
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Attempt legacy submission of an unsigned payment and observe RPC/broadcast spies.
     * @expected
     * - The envelope rejects before network checks or broadcast.
     */
    it('refuses unsigned submission before contacting the RPC', async () => {
      const { chain, network, networkCheck } = setup();
      const broadcast = vi.spyOn(network, 'submitTransaction');
      await expect(async () => {
        await chain.submitTransaction(payment());
      }).rejects.toThrow('Invalid C-Chain');
      expect(broadcast).not.toHaveBeenCalled();
      expect(networkCheck).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitTransaction rejects a signed payment from a different account before submission
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Sign a valid payment with another synthetic account, verify and attempt submission.
     * @expected
     * - The signer mismatch rejects before network checks.
     */
    it('rejects a signed payment from a different account before submission', async () => {
      const { chain, networkCheck } = setup();
      const p = payment();
      const tx = Transaction.from(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
      tx.signature = new SigningKey('0x' + '22'.repeat(32)).sign(
        tx.unsignedHash,
      );
      p.txBytes = Buffer.from(tx.serialized.slice(2), 'hex');
      expect(
        chain.verifyTransactionExtraConditions(p, SigningStatus.Signed),
      ).toEqual(false);
      await expect(async () => {
        await chain.submitTransaction(p);
      }).rejects.toThrow('Invalid C-Chain');
      expect(networkCheck).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitTransaction keeps legacy submission behavior when the qualified route is not used
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Make legacy gas preflight fail and call the legacy chain route while spying on the qualified route.
     * @expected
     * - Legacy behavior resolves without entering qualified submission.
     */
    it('keeps legacy submission behavior when the qualified route is not used', async () => {
      const { chain, network, payment, gas } = createAuthorizedChainFixture();
      const qualified = vi.spyOn(network, 'submitAuthorizedTransaction');
      gas.mockRejectedValueOnce(new Error('legacy preflight failure'));
      await expect(chain.submitTransaction(payment)).resolves.toBeUndefined();
      expect(qualified).not.toHaveBeenCalled();
    });
  });
  describe('generateMultipleTransactions', () => {
    /**
     * @target AvalancheChain.generateMultipleTransactions refuses an unusable gas estimate %s in the real builder
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Supply each unusable raw gas estimate to the real AVAX payment builder with mocked assets/nonce/fees.
     * @expected
     * - Generation rejects the invalid estimate.
     */
    it.each([0n, -1n, 100001n])(
      'refuses an unusable gas estimate %s in the real builder',
      async (estimate) => {
        const { chain, network } = setup();
        vi.spyOn(network, 'getAddressNextAvailableNonce').mockResolvedValue(0);
        vi.spyOn(network, 'getFeeData').mockResolvedValue(
          new FeeData(null, 20n, 2n),
        );
        vi.spyOn(network, 'getGasRequired').mockResolvedValue(estimate);
        vi.spyOn(chain, 'hasLockAddressEnoughAssets').mockResolvedValue(true);
        vi.spyOn(network, 'getAddressBalanceForNativeToken').mockResolvedValue(
          10000000n,
        );
        await expect(async () => {
          await chain.generateMultipleTransactions(
            eventId,
            TransactionType.payment,
            [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
            [],
            [],
          );
        }).rejects.toThrow('gas estimate');
      },
    );

    /**
     * @target AvalancheChain.generateMultipleTransactions builds AVAX with the configured C-Chain and exact value
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Build an AVAX payment from configured nonce, fee, gas and native output fixtures.
     * @expected
     * - The exact C-Chain, value, nonce, doubled gas limit and type-2 envelope are retained.
     */
    it('builds AVAX with the configured C-Chain and exact value', async () => {
      const { chain, network } = setup();
      vi.spyOn(network, 'getAddressNextAvailableNonce').mockResolvedValue(3);
      vi.spyOn(network, 'getFeeData').mockResolvedValue(
        new FeeData(null, 20n, 2n),
      );
      vi.spyOn(network, 'getGasRequired').mockResolvedValue(21000n);
      vi.spyOn(chain, 'hasLockAddressEnoughAssets').mockResolvedValue(true);
      vi.spyOn(network, 'getAddressBalanceForNativeToken').mockResolvedValue(
        10000000n,
      );
      const [p] = await chain.generateMultipleTransactions(
        eventId,
        TransactionType.payment,
        [{ address, assets: { nativeToken: 1000n, tokens: [] } }],
        [],
        [],
      );
      const tx = Transaction.from(
        '0x' + Buffer.from(p.txBytes).toString('hex'),
      );
      expect([tx.chainId, tx.value, tx.nonce, tx.gasLimit, tx.type]).toEqual([
        43113n,
        1000n,
        3,
        42000n,
        2,
      ]);
      expect(chain.verifyTransactionExtraConditions(p)).toEqual(true);
    });
  });
  describe('constructor', () => {
    /**
     * @target AvalancheChain.constructor rejects invalid gas configuration
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas, fee and signer methods.
     * @scenario
     * - Construct a chain with zero gas cap or multiplier.
     * @expected
     * - Construction rejects invalid gas-limit configuration.
     */
    it.each([
      { ...configs, gasLimitCap: 0n },
      { ...configs, gasLimitMultiplier: 0n },
    ])('rejects invalid gas configuration', (config) => {
      expect(() => setup(43113n, config)).toThrow('gas limit configuration');
    });
  });
  describe('submitAuthorizedTransaction', () => {
    /**
     * @target AvalancheChain.submitAuthorizedTransaction preserves signed bytes and preflight checks on the explicit route
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Submit a signed payment through the qualified mock and inspect signed bytes, assets, authority, start and legacy spies.
     * @expected
     * - Signed bytes remain exact, the callback starts once, and the legacy route is unused.
     */
    it('preserves signed bytes and preflight checks on the explicit route', async () => {
      const { chain, network, payment, tx, balance } =
        createAuthorizedChainFixture();
      const { submit, start } = mockSubmission(network);
      const legacy = vi.spyOn(network, 'submitTransaction');
      const authorize = vi.fn(allow);
      await chain.submitAuthorizedTransaction(payment, authorize);
      expect(submit.mock.calls[0][0].serialized).toEqual(tx.serialized);
      expect(balance).toHaveBeenCalledWith(configs.addresses.lock);
      expect(authorize).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction denies changed %s at final authorization after a wait
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Wait inside authorization, mutate one original payment field, then request transport start.
     * @expected
     * - The changed payment rejects and transport does not start.
     */
    it.each(['network', 'txId', 'eventId', 'txType', 'txBytes'] as const)(
      'denies changed %s at final authorization after a wait',
      async (field) => {
        const { chain, network, payment } = createAuthorizedChainFixture();
        const { start } = mockSubmission(network);
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, async (send) => {
            await Promise.resolve();
            if (field === 'txBytes') payment.txBytes[0] ^= 1;
            else Reflect.set(payment, field, 'changed');
            send();
          });
        }).rejects.toThrow('payment changed');
        expect(start).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects original mutation during %s preflight
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Mutate the original payment during each gas/assets/balance preflight stage.
     * @expected
     * - The changed payment rejects before qualified submission or transport start.
     */
    it.each(['gas', 'assets', 'balance'] as const)(
      'rejects original mutation during %s preflight',
      async (phase) => {
        const fixture = createAuthorizedChainFixture();
        const { chain, network, payment } = fixture;
        const { start, submit } = mockSubmission(network);
        fixture[phase].mockImplementationOnce(async () => {
          payment.eventId = 'cd'.repeat(32);
          return (
            phase === 'gas'
              ? 21000n
              : phase === 'assets'
                ? {
                    inputAssets: { nativeToken: 1n, tokens: [] },
                    outputAssets: { nativeToken: 1n, tokens: [] },
                  }
                : 10000000n
          ) as never;
        });
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, allow);
        }).rejects.toThrow('payment changed');
        expect(start).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects gas estimate %s before authorization
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Supply each nonpositive or over-limit gas estimate before qualified submission.
     * @expected
     * - The gas failure rejects before authorization dispatch.
     */
    it.each([0n, -1n, 42001n])(
      'rejects gas estimate %s before authorization',
      async (estimate) => {
        const { chain, network, payment, gas } = createAuthorizedChainFixture();
        const { submit } = mockSubmission(network);
        gas.mockResolvedValue(estimate);
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, allow);
        }).rejects.toThrow('gas');
        expect(submit).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects insufficient assets before authorization
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Report insufficient lock-address assets for an otherwise valid signed payment.
     * @expected
     * - Asset validation rejects before qualified dispatch.
     */
    it('rejects insufficient assets before authorization', async () => {
      const { chain, network, payment, balance } =
        createAuthorizedChainFixture();
      const { submit } = mockSubmission(network);
      balance.mockResolvedValue(840999n);
      await expect(async () => {
        await chain.submitAuthorizedTransaction(payment, allow);
      }).rejects.toThrow('assets');
      expect(submit).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction propagates %s errors
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Reject each gas/assets/balance/submission stage with an isolated synthetic error.
     * @expected
     * - The corresponding failure propagates.
     */
    it.each(['gas', 'assets', 'balance', 'submit'] as const)(
      'propagates %s errors',
      async (phase) => {
        const fixture = createAuthorizedChainFixture();
        const { chain, network, payment } = fixture;
        const { submit } = mockSubmission(network);
        (phase === 'submit' ? submit : fixture[phase]).mockRejectedValueOnce(
          new Error('synthetic failure'),
        );
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, allow);
        }).rejects.toThrow('synthetic failure');
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction propagates authority denial without transport start
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Deny authority after preflight without calling its start callback.
     * @expected
     * - Authority denial propagates without transport start.
     */
    it('propagates authority denial without transport start', async () => {
      const { chain, network, payment } = createAuthorizedChainFixture();
      const { start } = mockSubmission(network);
      await expect(async () => {
        await chain.submitAuthorizedTransaction(payment, async () => {
          throw new Error('authority denied');
        });
      }).rejects.toThrow('authority denied');
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects %s without preflight or authorization
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Replace the signed envelope with each unsigned/wrong-signer/wrong-chain/manual variant.
     * @expected
     * - Invalid authority input rejects before gas preflight or qualified submission.
     */
    it.each(['unsigned', 'wrong signer', 'wrong chain', 'manual'])(
      'rejects %s without preflight or authorization',
      async (kind) => {
        const { chain, network, payment, tx, gas } =
          createAuthorizedChainFixture();
        const { submit } = mockSubmission(network);
        if (kind === 'manual') payment.txType = TransactionType.manual;
        else {
          tx.signature = null;
          if (kind === 'wrong chain') tx.chainId = 43114n;
          if (kind !== 'unsigned')
            tx.signature = (
              kind === 'wrong signer'
                ? new SigningKey('0x' + '22'.repeat(32))
                : key
            ).sign(tx.unsignedHash);
          payment.txBytes = Buffer.from(
            (kind === 'unsigned' ? tx.unsignedSerialized : tx.serialized).slice(
              2,
            ),
            'hex',
          );
          payment.txId = tx.unsignedHash;
        }
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, allow);
        }).rejects.toThrow('Invalid authorized');
        expect(gas).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects a network without the explicit qualified method
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Remove the network qualified method before submitting a valid signed payment.
     * @expected
     * - The missing route rejects before gas preflight.
     */
    it('rejects a network without the explicit qualified method', async () => {
      const { chain, network, payment, gas } = createAuthorizedChainFixture();
      Reflect.set(network, 'submitAuthorizedTransaction', undefined);
      await expect(async () => {
        await chain.submitAuthorizedTransaction(payment, allow);
      }).rejects.toThrow('Invalid authorized');
      expect(gas).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction rejects %s drift at final authorization
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Wait inside authority and change one network/method/chain/lock-address binding before start.
     * @expected
     * - Final identity drift rejects before transport start.
     */
    it.each(['network', 'submit', 'chain id', 'lock address'])(
      'rejects %s drift at final authorization',
      async (field) => {
        const { chain, network, payment } = createAuthorizedChainFixture();
        const { start } = mockSubmission(network);
        await expect(async () => {
          await chain.submitAuthorizedTransaction(payment, async (send) => {
            await Promise.resolve();
            if (field === 'network') Reflect.set(chain, 'network', {});
            if (field === 'submit')
              Reflect.set(network, 'submitAuthorizedTransaction', vi.fn());
            if (field === 'chain id')
              Reflect.set(network, 'expectedChainId', 43114n);
            if (field === 'lock address')
              Reflect.get(chain, 'configs').addresses.lock =
                '0x' + '22'.repeat(20);
            send();
          });
        }).rejects.toThrow('payment changed');
        expect(start).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheChain.submitAuthorizedTransaction detects mutation of the private EVM transaction by preflight
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Change the private EVM transaction signature during gas preflight.
     * @expected
     * - The private transaction mutation rejects before qualified submission.
     */
    it('detects mutation of the private EVM transaction by preflight', async () => {
      const { chain, network, payment, gas } = createAuthorizedChainFixture();
      const { submit } = mockSubmission(network);
      gas.mockImplementationOnce(async (tx) => {
        tx.signature = key.sign('0x' + '99'.repeat(32));
        return 21000n;
      });
      await expect(async () => {
        await chain.submitAuthorizedTransaction(payment, allow);
      }).rejects.toThrow('payment changed');
      expect(submit).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction detects mutation of the private payment copy by preflight
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked qualified submission, network identity, gas and asset preflight methods.
     * @scenario
     * - Change the private payment copy identifier during asset preflight.
     * @expected
     * - The private payment mutation rejects before qualified submission.
     */
    it('detects mutation of the private payment copy by preflight', async () => {
      const { chain, network, payment, assets } =
        createAuthorizedChainFixture();
      const { submit } = mockSubmission(network);
      assets.mockImplementationOnce(async (copy) => {
        copy.txId = 'changed';
        return {
          inputAssets: { nativeToken: 1n, tokens: [] },
          outputAssets: { nativeToken: 1n, tokens: [] },
        };
      });
      await expect(async () => {
        await chain.submitAuthorizedTransaction(payment, allow);
      }).rejects.toThrow('payment changed');
      expect(submit).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheChain.submitAuthorizedTransaction sends exactly the signed payload through the actual RPC helper and loopback
     * @dependencies
     * - Real AvalancheChain and synthetic payment/token configuration.
     * - Mocked network identity, gas and asset preflight methods.
     * - Actual AvalancheRpcNetwork, submitAuthorizedAvalanche and avalancheGetUrl transport.
     * - Synthetic loopback JSON-RPC server.
     * @scenario
     * - Submit a valid signed payment through the actual RPC helper to a synthetic loopback JSON-RPC server.
     * @expected
     * - The server receives exactly one eth_sendRawTransaction body with the signed bytes.
     */
    it('sends exactly the signed payload through the actual RPC helper and loopback', async () => {
      const requests: unknown[] = [];
      const server = createServer((request, response) => {
        let bytes = '';
        request.on('data', (chunk) => {
          bytes += chunk;
        });
        request.on('end', () => {
          const body = JSON.parse(bytes);
          requests.push(body);
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: Transaction.from(body.params[0]).hash,
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const port = (server.address() as { port: number }).port;
        const { chain, payment, tx } = createAuthorizedChainFixture(
          `http://127.0.0.1:${port}`,
        );
        await chain.submitAuthorizedTransaction(payment, allow);
        expect(requests).toEqual([
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendRawTransaction',
            params: [tx.serialized],
          },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });
});
