import { DefaultLogger } from '@rosen-bridge/abstract-logger';
import {
  AbstractChain,
  ConfirmationStatus,
  ImpossibleBehavior,
  PaymentTransaction,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import { SigningStatus } from '@rosen-chains/abstract-chain';
import { AvalancheChain } from '@rosen-chains/avalanche';
import { DOGE_CHAIN } from '@rosen-chains/doge';
import { ErgoChain } from '@rosen-chains/ergo';
import { EXPLORER_NETWORK } from '@rosen-chains/ergo-explorer-network';
import { NODE_NETWORK } from '@rosen-chains/ergo-node-network';

import { recoverAvalancheApprovedOrder } from '../agreement/avalancheOrderRecovery';
import GuardsDogeConfigs from '../configs/guardsDogeConfigs';
import GuardsErgoConfigs from '../configs/guardsErgoConfigs';
import { DatabaseAction, TransactionCheckPreimage } from '../db/databaseAction';
import { TransactionEntity } from '../db/entities/transactionEntity';
import ChainHandler from '../handlers/chainHandler';
import { NotificationHandler } from '../handlers/notificationHandler';
import { getPreparedAvalancheInputs } from '../jobs/initScanner';
import {
  BoundTransactionContext,
  RevocableSigningAttempt,
  SigningPersistenceAuthorization,
  SigningRowPreimage,
  TransactionSigningContext,
  isAvalancheManagementRow,
} from '../signing/transactionSigningContext';
import { TransactionStatus } from '../utils/constants';

const logger = DefaultLogger.getInstance().child(import.meta.url);

class TransactionProcessor {
  private static signingContext: TransactionSigningContext;
  private static signingLimits: {
    readonly timeoutMs: number;
    readonly maxPending: number;
  };
  private static readonly attempts = new Map<string, RevocableSigningAttempt>();
  private static readonly failureBindings = new WeakMap<
    RevocableSigningAttempt,
    BoundTransactionContext
  >();

  /** Installs the prepared signing context for transaction processing. */
  static initSigning = (
    context: TransactionSigningContext,
    limits: { readonly timeoutMs: number; readonly maxPending: number },
  ): void => {
    if (this.attempts.size)
      throw new Error(
        'Cannot replace signing policy while attempts are active',
      );
    if (
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs < 1 ||
      limits.timeoutMs > 2147483647 ||
      !Number.isSafeInteger(limits.maxPending) ||
      limits.maxPending < 1 ||
      limits.maxPending > 1024
    )
      throw new Error('Invalid processor signing limits');
    this.signingContext = context;
    this.signingLimits = Object.freeze({ ...limits });
  };

  /** Returns the installed signing context or rejects an uninitialized processor. */
  private static getSigningContext = (): TransactionSigningContext => {
    if (!this.signingContext)
      throw new Error('Transaction signing is not initialized');
    return this.signingContext;
  };

  /** Captures the exact persisted transaction values for a later compare-and-swap. */
  private static captureRow = (tx: TransactionEntity): TransactionEntity => ({
    ...tx,
    event: tx.event ? { ...tx.event } : null,
    order: tx.order ? { ...tx.order } : null,
  });

  /**
   * processes all active transactions in the database
   */
  static processTransactions = async (): Promise<void> => {
    logger.info(`Processing transactions`);
    const txs = await DatabaseAction.getInstance().getActiveTransactions();
    for (let tx of txs) {
      logger.info(
        `Processing transaction [${tx.txId}] with status [${tx.status}]`,
      );
      try {
        tx = await recoverAvalancheApprovedOrder(tx, this.getSigningContext);
        switch (tx.status) {
          case TransactionStatus.approved: {
            await this.processApprovedTx(tx);
            break;
          }
          case TransactionStatus.inSign: {
            await this.processInSignTx(tx);
            break;
          }
          case TransactionStatus.signFailed: {
            await this.processSignFailedTx(tx);
            break;
          }
          case TransactionStatus.signed: {
            await this.processSignedTx(tx);
            break;
          }
          case TransactionStatus.sent: {
            await this.processSentTx(tx);
            break;
          }
        }
      } catch (e) {
        logger.warn(`An error occurred while processing tx [${tx.txId}]: ${e}`);
        logger.warn(e.stack);
      }
    }
    logger.info(`Processed [${txs.length}] transactions`);
  };

  /**
   * sends request to sign tx
   * @param tx transaction record
   */
  static processApprovedTx = async (tx: TransactionEntity): Promise<void> => {
    if (
      ![TransactionStatus.approved, TransactionStatus.signFailed].includes(
        tx.status,
      )
    )
      throw new Error('Transaction is not eligible for a signing attempt');
    const context = this.getSigningContext();
    // bind copies the complete row synchronously, before its first lookup.
    const binding = context.bind(tx, [
      TransactionStatus.approved,
      TransactionStatus.signFailed,
      TransactionStatus.inSign,
    ]);
    const bound = await binding;
    const dbAction = DatabaseAction.getInstance();
    const id = bound.preimage.txId;
    const release = await dbAction.txSignSemaphore.acquire();
    try {
      if (this.attempts.has(id)) return;
      if (this.attempts.size >= this.signingLimits.maxPending)
        throw new Error('Processor signing capacity reached');
      const chain = ChainHandler.getInstance().getChain(bound.preimage.chain);
      const payment = bound.payment();
      await bound.withPersistence('queue', async (expected, authorization) => {
        if (
          ![TransactionStatus.approved, TransactionStatus.signFailed].includes(
            expected.status,
          ) ||
          !(await dbAction.setTxStatusIfUnchanged(
            expected,
            TransactionStatus.inSign,
            authorization,
          ))
        )
          throw new Error('Signing queue CAS conflict');
      });
      const attempt: RevocableSigningAttempt = context.beginAttempt(
        bound,
        this.signingLimits.timeoutMs,
        () => this.attempts.get(id) === attempt,
      );
      this.attempts.set(id, attempt);
      this.failureBindings.set(attempt, bound);
      const timer = setTimeout(() => {
        attempt.revoke();
        if (this.attempts.get(id) === attempt) this.attempts.delete(id);
      }, this.signingLimits.timeoutMs);
      timer.unref();
      // ALS follows the promise; the scanner exclusion ended at the queue CAS.
      void context.run(attempt, async () => {
        try {
          const signed = await chain.signTransaction(
            payment,
            bound.requiredSign,
          );
          await this.handleSuccessfulSign(signed, attempt);
        } catch (error) {
          attempt.revoke();
          try {
            await this.handleFailedSign(id, error, attempt);
          } catch (failure) {
            logger.warn(
              `Signing failure could not change transaction [${id}]: ${failure}`,
            );
          }
        } finally {
          attempt.revoke();
          clearTimeout(timer);
          if (this.attempts.get(id) === attempt) this.attempts.delete(id);
        }
      });
      logger.info(`Tx [${id}] got sent to the signer`);
    } finally {
      release();
    }
  };

  /**
   * updates database tx to signed tx
   * @param tx
   */
  static handleSuccessfulSign = async (
    tx: PaymentTransaction,
    bound: BoundTransactionContext,
  ): Promise<void> => {
    if (!bound || this.attempts.get(bound.preimage.txId) !== bound)
      throw new Error('Signing result has no active local attempt');
    await this.getSigningContext().persistResult(
      bound,
      tx,
      async (json, expected, authorization) => {
        if (
          !(await DatabaseAction.getInstance().updateWithSignedTxIfUnchanged(
            expected,
            json,
            authorization,
          ))
        )
          throw new Error('Signing result CAS conflict');
      },
    );
    logger.info(`Tx [${bound.preimage.txId}] is signed successfully`);
  };

  /**
   * updates tx status to sign-failed
   * @param tx
   */
  static handleFailedSign = async (
    txId: string,
    e: unknown,
    bound: RevocableSigningAttempt,
  ): Promise<void> => {
    logger.warn(`An error occurred while signing tx [${txId}]: ${e}`);
    if (
      !bound ||
      bound.preimage.txId !== txId ||
      this.attempts.get(txId) !== bound
    )
      throw new Error('Signing failure has no active local attempt');
    bound.revoke();
    const failureBinding = this.failureBindings.get(bound);
    if (!failureBinding) throw new Error('Signing failure has no row binding');
    await failureBinding.withPersistence(
      'failure',
      async (expected, authorization) => {
        if (
          this.attempts.get(txId) !== bound ||
          expected.status !== TransactionStatus.inSign
        )
          throw new Error('Signing failure attempt was replaced');
        if (
          !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.signFailed,
            authorization,
          ))
        )
          throw new Error('Signing failure CAS conflict');
      },
      () => {
        if (this.attempts.get(txId) !== bound)
          throw new Error('Signing failure attempt was replaced');
      },
    );
  };

  /**
   * sets tx as sign-failed if enough time past from the request to sign
   * @param tx transaction record
   */
  static processInSignTx = async (tx: TransactionEntity): Promise<void> => {
    if (this.attempts.has(tx.txId)) return;
    const bound = await this.getSigningContext().bind(tx, [
      TransactionStatus.inSign,
    ]);
    const id = bound.preimage.txId;
    const chain = ChainHandler.getInstance().getChain(bound.preimage.chain);
    const paymentTx = bound.payment();
    if (await chain.isTransactionInSign(paymentTx)) {
      logger.info(`Signer is still signing tx [${id}]`);
    } else {
      logger.warn(
        `Signer does not have tx [${id}]. Updating status to sign-failed`,
      );
      const dbAction = DatabaseAction.getInstance();
      const release = await dbAction.txSignSemaphore.acquire();
      try {
        if (this.attempts.has(id)) return;
        await bound.withPersistence(
          'failure',
          async (expected, authorization) => {
            if (
              !(await dbAction.setTxStatusIfUnchanged(
                expected,
                TransactionStatus.signFailed,
                authorization,
              ))
            )
              throw new Error('Orphaned signing status CAS conflict');
          },
          () => {
            if (this.attempts.has(id))
              throw new Error('Orphaned signing attempt was replaced');
          },
        );
      } finally {
        release();
      }
    }
  };

  /**
   * revalidates tx, request to sign again if it's still valid, otherwise sets as invalid
   * @param tx transaction record
   */
  static processSignFailedTx = async (tx: TransactionEntity): Promise<void> => {
    tx = this.captureRow(tx);
    const checked = DatabaseAction.getInstance().captureTxCheckPreimage(tx);
    const bound = await this.getSigningContext().bind(tx, [
      TransactionStatus.signFailed,
    ]);
    const chain = ChainHandler.getInstance().getChain(tx.chain);
    // TODO: Remove this if and implement a general way to reduce confirmation check frequency
    // local:ergo/rosen-bridge/guard-service#447
    if (tx.chain === DOGE_CHAIN) {
      // in case of Doge, we only check confirmation of sign-failed txs in 10% of times (configurable with default value of 10)
      if (
        Math.random() >
        GuardsDogeConfigs.signFailedConfirmationCheckPercent / 100
      ) {
        logger.info(
          `Ignored confirmation check for Doge tx [${tx.txId}]. Requesting to sign tx...`,
        );
        await this.processApprovedTx(tx);
        return;
      } else {
        logger.info(`Checking confirmation status for Doge tx [${tx.txId}]...`);
      }
    }
    const txConfirmation = await chain.getTxConfirmationStatus(
      tx.txId,
      tx.type as TransactionType,
    );
    if (
      txConfirmation !== ConfirmationStatus.NotFound ||
      (await chain.isTxInMempool(tx.txId))
    ) {
      // tx found in network. set status as sent
      logger.info(
        `Tx [${tx.txId}] found in blockchain. Updating status to 'sent'`,
      );
      /** Checks the captured transaction under its current execution observation. */
      const observe = async (
        expected: import('../signing/transactionSigningContext').SigningRowPreimage,
      ) => {
        if (
          !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.sent,
          ))
        )
          throw new Error('Observed signing transaction CAS conflict');
      };
      if (tx.type === TransactionType.reward)
        await bound.withRewardRecovery(
          async (expected, signedJson, authorization) => {
            if (signedJson === undefined) return observe(expected);
            if (
              !authorization ||
              !(await DatabaseAction.getInstance().recoverSignedRewardIfUnchanged(
                expected,
                signedJson,
                authorization,
              ))
            )
              throw new Error('Reward signed recovery CAS conflict');
          },
        );
      else if (tx.type === TransactionType.payment)
        await bound.withPaymentRecovery(
          checked,
          this.paymentTimeout(bound),
          async (expected, signedJson, authorization) => {
            if (signedJson === undefined) return observe(expected);
            if (
              !authorization ||
              !(await DatabaseAction.getInstance().recoverSignedPaymentIfUnchanged(
                expected,
                signedJson,
                authorization,
              ))
            )
              throw new Error('Payment signed recovery CAS conflict');
          },
        );
      else if (isAvalancheManagementRow(bound.preimage))
        await bound.withPaymentRecovery(
          checked,
          this.paymentTimeout(bound),
          async (expected, signedJson, authorization) => {
            if (
              !signedJson ||
              !authorization ||
              !(await DatabaseAction.getInstance().recoverSignedManagementIfUnchanged(
                expected,
                signedJson,
                authorization,
              ))
            )
              throw new Error('Native management signed recovery CAS conflict');
          },
        );
      else await bound.withAction(observe);
    } else {
      // tx is not found, checking if tx is still valid
      const paymentTx = bound.payment();
      const validityStatus = await chain.isTxValid(
        paymentTx,
        SigningStatus.UnSigned,
      );
      if (validityStatus.isValid) {
        // tx is valid, requesting to sign...
        logger.info(`Tx [${tx.txId}] is still valid. Requesting to sign tx...`);
        const height = await chain.getHeight();
        await bound.withAction(async () => {
          if (
            !(await DatabaseAction.getInstance().updateTxLastCheckIfUnchanged(
              checked,
              height,
            ))
          )
            throw new Error('Transaction last-check CAS conflict');
        });
        await this.processApprovedTx(tx);
      } else {
        // tx is invalid, reset status if enough blocks past.
        await this.setTransactionAsInvalid(tx, chain, validityStatus.details);
      }
    }
  };

  /**
   * submits tx to blockchain
   * @param tx transaction record
   */
  static processSignedTx = async (tx: TransactionEntity): Promise<void> => {
    const bound = await this.getSigningContext().bind(tx, [
      TransactionStatus.signed,
    ]);
    const chain = ChainHandler.getInstance().getChain(bound.preimage.chain);
    if (bound.preimage.type === TransactionType.reward) {
      await this.submitReward(bound, chain, true);
      return;
    }
    if (
      bound.preimage.type === TransactionType.payment ||
      isAvalancheManagementRow(bound.preimage)
    ) {
      await this.submitPayment(bound, chain, true);
      return;
    }
    await bound.withAction(async (expected) => {
      await chain.submitTransaction(bound.payment());
      if (
        !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
          expected,
          TransactionStatus.sent,
        ))
      )
        throw new Error('Submitted transaction CAS conflict');
    });
  };

  /** Returns the configured payment submission timeout. */
  private static paymentTimeout = (
    bound: BoundTransactionContext,
  ): number | undefined => {
    // Avalanche's provider timeout is protected. Reuse the frozen startup
    // configuration for this local lifetime; its adapter bounds the real request.
    const seconds =
      bound.preimage.chain === 'avalanche'
        ? getPreparedAvalancheInputs()?.config.rpc.timeout
        : bound.preimage.chain === 'ergo'
          ? GuardsErgoConfigs.chainNetworkName === NODE_NETWORK
            ? GuardsErgoConfigs.node.timeout
            : GuardsErgoConfigs.chainNetworkName === EXPLORER_NETWORK
              ? GuardsErgoConfigs.explorer.timeout
              : undefined
          : undefined;
    return typeof seconds === 'number' ? seconds * 1000 : undefined;
  };

  /** Submits a payment through its prepared transaction authority. */
  private static submitPayment = async (
    bound: BoundTransactionContext,
    chain: AbstractChain<unknown>,
    persist: boolean,
  ): Promise<void> => {
    const timeoutMs = this.paymentTimeout(bound);
    const prepared = await bound.preparePaymentSubmission(timeoutMs);
    try {
      if (prepared.kind === 'legacy') {
        await prepared.withLegacyAction(async (expected) => {
          await chain.submitTransaction(prepared.payment());
          if (
            persist &&
            !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
              expected,
              TransactionStatus.sent,
            ))
          )
            throw new Error('Submitted transaction CAS conflict');
        });
        return;
      }
      if (prepared.kind === 'ready') {
        if (
          chain instanceof ErgoChain &&
          typeof chain.submitAuthorizedTransaction === 'function'
        ) {
          await chain.submitAuthorizedTransaction(prepared.payment(), {
            timeoutMs: timeoutMs!,
            authorizeSubmit: prepared.authorizeSubmit,
          });
        } else if (
          chain instanceof AvalancheChain &&
          typeof chain.submitAuthorizedTransaction === 'function'
        ) {
          await chain.submitAuthorizedTransaction(
            prepared.payment(),
            prepared.authorizeSubmit,
          );
        } else {
          throw new Error(
            'Qualified payment submission capability is unavailable',
          );
        }
      }
      await prepared.withResult(async (expected, permit) => {
        if (
          !permit ||
          !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.sent,
            permit,
          ))
        )
          throw new Error('Submitted payment CAS conflict');
      });
    } finally {
      prepared.close();
    }
  };

  /** Submits a reward through its prepared transaction authority. */
  private static submitReward = async (
    bound: BoundTransactionContext,
    chain: AbstractChain<unknown>,
    persist: boolean,
  ): Promise<void> => {
    const seconds =
      GuardsErgoConfigs.chainNetworkName === NODE_NETWORK
        ? GuardsErgoConfigs.node.timeout
        : GuardsErgoConfigs.chainNetworkName === EXPLORER_NETWORK
          ? GuardsErgoConfigs.explorer.timeout
          : NaN;
    if (typeof seconds !== 'number')
      throw new Error('Invalid reward submission timeout');
    const timeoutMs = seconds * 1000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2147483647
    )
      throw new Error('Invalid selected Ergo submission timeout');
    const prepared = await bound.prepareRewardSubmission(timeoutMs);
    try {
      if (prepared.kind === 'legacy') {
        await prepared.withLegacyAction(async (expected) => {
          await chain.submitTransaction(bound.payment());
          if (
            persist &&
            !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
              expected,
              TransactionStatus.sent,
            ))
          )
            throw new Error('Submitted transaction CAS conflict');
        });
        return;
      }
      if (
        !(chain instanceof ErgoChain) ||
        typeof chain.submitAuthorizedTransaction !== 'function'
      )
        throw new Error('Qualified reward requires the Ergo chain');
      if (prepared.kind === 'ready')
        await chain.submitAuthorizedTransaction(bound.payment(), {
          timeoutMs,
          authorizeSubmit: prepared.authorizeSubmit,
        });
      // An observed transaction is reconciled without starting another POST.
      await prepared.withResult(async (expected, permit) => {
        if (
          !permit ||
          !(await DatabaseAction.getInstance().setTxStatusIfUnchanged(
            expected,
            TransactionStatus.sent,
            permit,
          ))
        )
          throw new Error('Submitted reward CAS conflict');
      });
    } finally {
      prepared.close();
    }
  };

  /**
   * processes the transaction that has been sent before
   * @param tx transaction record
   */
  static processSentTx = async (tx: TransactionEntity): Promise<void> => {
    tx = this.captureRow(tx);
    const checked = DatabaseAction.getInstance().captureTxCheckPreimage(tx);
    const bound = await this.getSigningContext().bind(tx, [
      TransactionStatus.sent,
    ]);
    const chain = ChainHandler.getInstance().getChain(tx.chain);
    // TODO: Remove this if and implement a general way to reduce confirmation check frequency
    // local:ergo/rosen-bridge/guard-service#447
    if (tx.chain === DOGE_CHAIN) {
      // in case of Doge, we only check confirmation of sign-failed txs in 60% of times (configurable with default value of 60)
      if (
        Math.random() >
        GuardsDogeConfigs.sentConfirmationCheckPercent / 100
      ) {
        logger.info(`Ignored confirmation check for Doge tx [${tx.txId}].`);
        return;
      } else {
        logger.info(`Checking confirmation status for Doge tx [${tx.txId}]...`);
      }
    }
    const txConfirmation = await chain.getTxConfirmationStatus(
      tx.txId,
      tx.type as TransactionType,
    );
    switch (txConfirmation) {
      case ConfirmationStatus.ConfirmedEnough: {
        /** Completes the captured transaction using its current persistence authority. */
        const complete = async (
          expected: SigningRowPreimage,
          authorization?: SigningPersistenceAuthorization,
        ) => {
          if (
            !(await DatabaseAction.getInstance().finalizeTxIfUnchanged(
              expected,
              authorization,
            ))
          )
            throw new Error('Transaction completion CAS conflict');
        };
        if (
          bound.preimage.type === TransactionType.payment ||
          isAvalancheManagementRow(bound.preimage)
        )
          await bound.withPaymentCompletion(
            this.paymentTimeout(bound),
            complete,
          );
        else await bound.withPersistence('completion', complete);
        logger.info(
          `Tx [${tx.txId}] is confirmed and its process state was updated`,
        );
        break;
      }
      case ConfirmationStatus.NotConfirmedEnough: {
        // tx is mined, but not enough confirmation, updating last check...
        const height = await chain.getHeight();
        await bound.withAction(async () => {
          if (
            !(await DatabaseAction.getInstance().updateTxLastCheckIfUnchanged(
              checked,
              height,
            ))
          )
            throw new Error('Transaction last-check CAS conflict');
        });
        logger.info(`Tx [${tx.txId}] is in confirmation process`);
        break;
      }
      case ConfirmationStatus.NotFound: {
        // tx is not mined, checking mempool...
        if (await chain.isTxInMempool(tx.txId)) {
          // tx is in mempool, updating last check...
          const height = await chain.getHeight();
          await bound.withAction(async () => {
            if (
              !(await DatabaseAction.getInstance().updateTxLastCheckIfUnchanged(
                checked,
                height,
              ))
            )
              throw new Error('Transaction last-check CAS conflict');
          });
          logger.info(`Tx [${tx.txId}] is in mempool`);
        } else {
          // tx is not in mempool, checking if tx is still valid
          const paymentTx = bound.payment();
          const validityStatus = await chain.isTxValid(
            paymentTx,
            SigningStatus.Signed,
          );
          if (validityStatus.isValid) {
            // tx is valid. resending...
            logger.info(`Tx [${tx.txId}] is still valid. Resending tx...`);
            if (bound.preimage.type === TransactionType.reward)
              await this.submitReward(bound, chain, false);
            else if (
              bound.preimage.type === TransactionType.payment ||
              isAvalancheManagementRow(bound.preimage)
            )
              await this.submitPayment(bound, chain, false);
            else
              await bound.withAction(() =>
                chain.submitTransaction(bound.payment()),
              );
          } else {
            // tx is invalid. reset status if enough blocks past.
            await this.setTransactionAsInvalid(
              tx,
              chain,
              validityStatus.details,
            );
          }
        }
      }
    }
  };

  /**
   * resets status of event (if tx is related to any event) and set tx as invalid if enough blocks past from last check
   * @param tx transaction record
   * @param chain AbstractChain object
   * @param invalidationDetails reason of invalidation with unexpectedness status
   */
  static setTransactionAsInvalid = async (
    tx: TransactionEntity,
    chain: AbstractChain<unknown>,
    invalidationDetails:
      | {
          reason: string;
          unexpected: boolean;
        }
      | undefined,
  ): Promise<void> => {
    if (
      invalidationDetails === undefined &&
      tx.type !== TransactionType.payment &&
      !isAvalancheManagementRow(tx)
    )
      throw new ImpossibleBehavior(
        `Tx [${tx.txId}] is invalid but no reason is provided`,
      );
    tx = this.captureRow(tx);
    const legacyDetails =
      invalidationDetails === undefined
        ? undefined
        : Object.freeze({ ...invalidationDetails });
    if (
      ![TransactionStatus.sent, TransactionStatus.signFailed].includes(
        tx.status,
      ) ||
      !Number.isSafeInteger(tx.lastCheck) ||
      tx.lastCheck < 0
    )
      throw new Error('Invalid transaction invalidation evidence');
    const checked = DatabaseAction.getInstance().captureTxCheckPreimage(tx);
    const bound = await this.getSigningContext().bind(tx, [tx.status]);
    chain = ChainHandler.getInstance().getChain(bound.preimage.chain);
    const required = chain.getTxRequiredConfirmation(
      tx.type as TransactionType,
    );
    const height = await chain.getHeight();
    if (
      !Number.isSafeInteger(height) ||
      height < 0 ||
      !Number.isSafeInteger(required) ||
      required < 0
    )
      throw new Error(
        'Invalid transaction invalidation height or confirmation policy',
      );
    if (height - tx.lastCheck >= required) {
      /** Invalidates the captured transaction using its current persistence authority. */
      const invalidate = async (
        expected: TransactionCheckPreimage,
        authorization: SigningPersistenceAuthorization | undefined,
        derived: Readonly<{ reason: string; unexpected: boolean }> | undefined,
      ) => {
        const details = derived ?? legacyDetails;
        if (
          !details ||
          typeof details.reason !== 'string' ||
          typeof details.unexpected !== 'boolean'
        )
          throw new ImpossibleBehavior(
            'Transaction invalidation reason is unavailable',
          );
        if (
          !(await DatabaseAction.getInstance().invalidateTxIfUnchanged(
            expected,
            expected.lastCheck,
            details.unexpected,
            authorization,
          ))
        )
          throw new Error('Transaction invalidation CAS conflict');
        return details;
      };
      const details =
        bound.preimage.type === TransactionType.payment ||
        isAvalancheManagementRow(bound.preimage)
          ? await bound.withPaymentInvalidation(
              checked,
              this.paymentTimeout(bound),
              invalidate,
            )
          : await bound.withPersistence(
              'invalidation',
              (expected, authorization) =>
                invalidate(
                  { ...checked, ...expected },
                  authorization,
                  undefined,
                ),
            );
      if (details.unexpected) {
        // send notification if invalidation reason is unexpected
        await NotificationHandler.getInstance().notify(
          'warning',
          `Tx is invalid`,
          `Tx [${tx.txId}] on chain [${tx.chain}] is invalid due to reason: ${details.reason}`,
        );
      }
      switch (tx.type) {
        case TransactionType.payment:
          if (!tx.event)
            throw new ImpossibleBehavior(
              `Tx [${tx.txId}] has no event associated with it`,
            );
          logger.info(
            `Tx [${tx.txId}] is invalid. Event [${tx.event.id}] is now waiting for payment. Reason: ${details.reason}`,
          );
          break;
        case TransactionType.reward:
          if (!tx.event)
            throw new ImpossibleBehavior(
              `Tx [${tx.txId}] has no event associated with it`,
            );
          logger.info(
            `Tx [${tx.txId}] is invalid. Event [${tx.event.id}] is now waiting for reward distribution. Reason: ${details.reason}`,
          );
          break;
        case TransactionType.arbitrary:
          if (!tx.order)
            throw new ImpossibleBehavior(
              `Tx [${tx.txId}] has no order associated with it`,
            );

          logger.info(
            `Tx [${tx.txId}] is invalid. Order [${tx.order.id}] is now waiting for payment. Reason: ${details.reason}`,
          );
          break;
        case TransactionType.coldStorage:
          logger.info(
            `Cold storage tx [${tx.txId}] is invalid. Reason: ${details.reason}`,
          );
          break;
        case TransactionType.manual:
          logger.warn(
            `Manual tx [${tx.txId}] is invalid. Reason: ${details.reason}`,
          );
          break;
      }
    } else {
      logger.info(
        `Tx [${tx.txId}] is invalid. Waiting for enough confirmation of this proposition. Reason: ${legacyDetails?.reason ?? 'not yet qualified'}`,
      );
    }
  };
}

export default TransactionProcessor;
