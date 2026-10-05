import { Transaction, getAddress, Interface } from 'ethers';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import { TokenMap } from '@rosen-bridge/tokens';
import {
  PaymentTransaction,
  NotEnoughAssetsError,
  SigningStatus,
  TransactionFormatError,
  TransactionType,
} from '@rosen-chains/abstract-chain';
import {
  AvalancheRpcNetwork,
  type SettledAvalancheTransactionReceiptEvidence,
} from '@rosen-chains/avalanche-rpc';
import {
  EvmChain,
  EvmChainSignMediator,
  EvmConfigs,
  transferABI,
} from '@rosen-chains/evm';

import { captureAvalancheAssets } from './avalancheAssets';
import { hasAvalancheTransferProof } from './avalancheTransferProof';
import { AVALANCHE_CHAIN, AVAX } from './constants';

/** Mapped C-Chain payments bound to the selected RPC adapter and native management policy. */
export class AvalancheChain extends EvmChain {
  readonly CHAIN = AVALANCHE_CHAIN;
  readonly NATIVE_TOKEN_ID = AVAX;
  readonly CHAIN_ID: bigint;

  /** Qualify mapped outgoing token execution against the exact signed payment and current policy. */
  verifySettledPaymentEvidence: (
    payment: PaymentTransaction,
    evidence: Readonly<SettledAvalancheTransactionReceiptEvidence>,
  ) => boolean;

  /** Qualify an outgoing mapped token route without granting its business authorization. */
  verifySettledTokenEvidence: (
    payment: PaymentTransaction,
    evidence: Readonly<SettledAvalancheTransactionReceiptEvidence>,
  ) => boolean;

  /** Explicit qualified route; legacy submission cannot consume this callback. */
  submitAuthorizedTransaction: (
    payment: PaymentTransaction,
    authorizeSubmit: (start: () => void) => Promise<void>,
  ) => Promise<void>;

  /** Binds mapped type-2 payments to the qualified adapter and configured gas policy. */
  constructor(
    network: AvalancheRpcNetwork,
    configs: EvmConfigs,
    tokens: TokenMap,
    signMediator: EvmChainSignMediator,
    logger?: AbstractLogger,
  ) {
    if (!(network instanceof AvalancheRpcNetwork)) {
      throw new Error('AvalancheChain requires the C-Chain RPC adapter');
    }
    if (
      typeof configs.gasLimitCap !== 'bigint' ||
      typeof configs.gasLimitMultiplier !== 'bigint' ||
      configs.gasLimitCap <= 0n ||
      configs.gasLimitMultiplier < 1n ||
      configs.gasLimitCap * configs.gasLimitMultiplier >= 1n << 256n
    ) {
      throw new Error('Invalid C-Chain gas limit configuration');
    }
    super(
      network,
      configs,
      tokens,
      signMediator,
      AVALANCHE_CHAIN,
      AVAX,
      2,
      logger,
    );
    this.CHAIN_ID = network.expectedChainId;
    const assetPolicy = captureAvalancheAssets(tokens);
    const transfer = new Interface(transferABI);
    /** Keeps inherited token discovery bound to the validated immutable mapping. */
    const assertAssets = (reason?: string) => {
      try {
        if (this.tokenMap !== tokens)
          throw new TransactionFormatError('Avalanche token map changed');
        assetPolicy.assertFresh(this.supportedTokens);
      } catch (error) {
        if (reason) throw new TransactionFormatError(reason);
        throw error;
      }
    };
    assertAssets();

    const verifyNativeLock = this.verifyLockTransactionExtraConditions;
    /** Requires executed mapped token movement before the generic extractor can authorize an event. */
    this.verifyLockTransactionExtraConditions = async (transaction, block) => {
      assertAssets();
      if (transaction.value > 0n) return verifyNativeLock(transaction, block);
      try {
        if (
          !transaction.isSigned() ||
          transaction.to === null ||
          transaction.chainId !== selectedChainId ||
          !assetPolicy.ids.includes(transaction.to.toLowerCase()) ||
          transaction.data.length <= 138
        )
          return false;
        const decoded = assetPolicy.decode(
          transaction,
          transaction.data.slice(138),
        );
        if (decoded.recipient !== configuredLock.toLowerCase()) return false;
        const read = network.getSettledTransactionReceiptEvidence;
        const bytes = transaction.serialized;
        const blockHash = block.hash;
        const blockHeight = block.height;
        const evidence = await read.call(network, transaction.hash!, blockHash);
        assertAssets();
        if (
          this.network !== network ||
          this.configs !== configs ||
          configs.addresses !== configuredAddresses ||
          configuredAddresses.lock !== configuredLock ||
          network.expectedChainId !== selectedChainId ||
          network.getSettledTransactionReceiptEvidence !== read ||
          transaction.serialized !== bytes ||
          block.hash !== blockHash ||
          block.height !== blockHeight ||
          evidence.blockHash !== blockHash ||
          evidence.blockNumber !== blockHeight ||
          !Number.isSafeInteger(evidence.finalizedBlockNumber) ||
          evidence.finalizedBlockNumber < blockHeight ||
          evidence.confirmations !==
            evidence.finalizedBlockNumber - blockHeight + 1 ||
          !/^0x[0-9a-f]{64}$/.test(evidence.finalizedBlockHash)
        )
          return false;
        return hasAvalancheTransferProof(
          transaction,
          evidence,
          decoded.recipient,
          decoded.amount,
        );
      } catch {
        return false;
      }
    };

    const nativeRoutes = new Set([
      TransactionType.payment,
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ]);
    const selectedChainId = this.CHAIN_ID;
    const gasCap = configs.gasLimitCap;
    const gasMultiplier = configs.gasLimitMultiplier;
    const configuredAddresses = configs.addresses;
    const configuredLock = configuredAddresses.lock;
    const configuredCold = configuredAddresses.cold;
    /** Enforces primitive empty management IDs and exact payment/arbitrary event bytes. */
    const validEvent = (type: TransactionType, event: string) =>
      type === TransactionType.coldStorage || type === TransactionType.manual
        ? event === ''
        : typeof event === 'string' && /^[0-9a-f]{64}$/.test(event);
    const verifyEvm = this.verifyTransactionExtraConditions;
    /** Requires route identity, mapped asset, recipient and signer binding before inherited checks. */
    this.verifyTransactionExtraConditions = (
      payment: PaymentTransaction,
      signingStatus = SigningStatus.UnSigned,
    ): boolean => {
      try {
        assertAssets();
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        if (
          this.CHAIN !== AVALANCHE_CHAIN ||
          this.NATIVE_TOKEN_ID !== AVAX ||
          payment.network !== AVALANCHE_CHAIN ||
          !nativeRoutes.has(payment.txType) ||
          !validEvent(payment.txType, payment.eventId) ||
          this.network !== network ||
          this.configs !== configs ||
          configs.addresses !== configuredAddresses ||
          configuredAddresses.lock !== configuredLock ||
          configuredAddresses.cold !== configuredCold ||
          configs.gasLimitCap !== gasCap ||
          configs.gasLimitMultiplier !== gasMultiplier ||
          this.CHAIN_ID !== selectedChainId ||
          network.expectedChainId !== selectedChainId ||
          tx.chainId !== this.CHAIN_ID ||
          tx.type !== 2 ||
          tx.gasLimit <= 0n ||
          tx.gasLimit > gasCap * gasMultiplier ||
          tx.to === null ||
          getAddress(tx.to) === '0x0000000000000000000000000000000000000000' ||
          (tx.accessList?.length ?? 0) !== 0 ||
          (payment.txType === TransactionType.coldStorage &&
            tx.value > 0n &&
            (getAddress(configuredCold) === getAddress(configuredLock) ||
              getAddress(configuredCold) !== getAddress(tx.to))) ||
          tx.unsignedHash !== payment.txId ||
          tx.isSigned() !== (signingStatus === SigningStatus.Signed) ||
          (tx.isSigned() &&
            tx.from?.toLowerCase() !== configs.addresses.lock.toLowerCase())
        )
          return false;
        if (tx.value > 0n) {
          if (tx.data !== '0x' + payment.eventId) return false;
        } else {
          const decoded = assetPolicy.decode(tx, payment.eventId);
          if (
            payment.txType === TransactionType.coldStorage &&
            (getAddress(configuredCold) === getAddress(configuredLock) ||
              decoded.recipient !== configuredCold.toLowerCase())
          )
            return false;
        }
        return verifyEvm(payment, signingStatus);
      } catch {
        return false;
      }
    };
    const evmAssets = this.getTransactionAssets;
    const evmOrder = this.extractTransactionOrder;
    const verifyMappedEnvelope = this.verifyTransactionExtraConditions;
    /** Captures every payment field that can change its accounting meaning. */
    const accountingIdentity = (payment: PaymentTransaction) =>
      JSON.stringify([
        payment.network,
        payment.txId,
        payment.eventId,
        payment.txType,
        Buffer.from(payment.txBytes).toString('hex'),
      ]);
    /** Requires authoritative asset and envelope identity before exposing inherited accounting. */
    const assertAccountingEnvelope = (payment: PaymentTransaction) => {
      assertAssets();
      const tx = Transaction.from(
        '0x' + Buffer.from(payment.txBytes).toString('hex'),
      );
      if (
        this.verifyTransactionExtraConditions !== verifyMappedEnvelope ||
        !verifyMappedEnvelope(
          payment,
          tx.isSigned() ? SigningStatus.Signed : SigningStatus.UnSigned,
        )
      )
        throw new TransactionFormatError(
          'Invalid Avalanche accounting envelope',
        );
      return tx;
    };
    /**
     * Refuse successful ERC20 receipts without the exact mapped route Transfer.
     * @param payment Current signed route whose order has been independently authorized.
     * @param evidence Immutable canonical receipt from the selected RPC adapter.
     * @returns True only for exact mapped token execution with its route's settled confirmations.
     */
    const verifySettledToken = (
      payment: PaymentTransaction,
      evidence: Readonly<SettledAvalancheTransactionReceiptEvidence>,
    ): boolean => {
      try {
        const tx = assertAccountingEnvelope(payment);
        if (!tx.isSigned() || tx.value !== 0n) return false;
        const decoded = assetPolicy.decode(tx, payment.eventId);
        if (this.getTxRequiredConfirmation !== requiredConfirmation)
          return false;
        const required = requiredConfirmation(payment.txType);
        if (
          !Number.isSafeInteger(required) ||
          required < 1 ||
          !Number.isSafeInteger(evidence.finalizedBlockNumber) ||
          evidence.finalizedBlockNumber < evidence.blockNumber ||
          !Number.isSafeInteger(evidence.confirmations) ||
          evidence.confirmations !==
            evidence.finalizedBlockNumber - evidence.blockNumber + 1 ||
          evidence.confirmations < required ||
          !/^0x[0-9a-f]{64}$/.test(evidence.finalizedBlockHash)
        )
          return false;
        return hasAvalancheTransferProof(
          tx,
          evidence,
          decoded.recipient,
          decoded.amount,
        );
      } catch {
        return false;
      }
    };
    this.verifySettledTokenEvidence = verifySettledToken;
    /** Keep the payment consumer restricted to its independently authorized payment route. */
    this.verifySettledPaymentEvidence = (payment, evidence) =>
      payment.txType === TransactionType.payment &&
      verifySettledToken(payment, evidence);
    /** Exposes mapped transaction assets only from one valid captured payment envelope. */
    this.getTransactionAssets = async (payment) => {
      const identity = accountingIdentity(payment);
      const tx = assertAccountingEnvelope(payment);
      const result = await evmAssets(payment);
      assertAccountingEnvelope(payment);
      if (accountingIdentity(payment) !== identity)
        throw new TransactionFormatError(
          'Avalanche accounting envelope changed',
        );
      if (tx.value === 0n) {
        const token = assetPolicy.decode(tx, payment.eventId);
        for (const assets of [result.inputAssets, result.outputAssets]) {
          if (
            assets.tokens.length !== 1 ||
            assets.tokens[0].id !== token.id ||
            assetPolicy.unwrap(token.id, assets.tokens[0].value) !==
              token.amount
          )
            throw new TransactionFormatError(
              'Avalanche mapped token accounting mismatch',
            );
        }
      }
      return result;
    };
    /** Extracts mapped recipient and amounts only after exact envelope verification. */
    this.extractTransactionOrder = (payment) => {
      const identity = accountingIdentity(payment);
      const tx = assertAccountingEnvelope(payment);
      const result = evmOrder(payment);
      assertAccountingEnvelope(payment);
      if (accountingIdentity(payment) !== identity)
        throw new TransactionFormatError(
          'Avalanche accounting envelope changed',
        );
      if (tx.value === 0n) {
        const token = assetPolicy.decode(tx, payment.eventId);
        if (
          result.length !== 1 ||
          result[0].address !== token.recipient ||
          result[0].assets.nativeToken !== 0n ||
          result[0].assets.tokens.length !== 1 ||
          result[0].assets.tokens[0].id !== token.id ||
          assetPolicy.unwrap(token.id, result[0].assets.tokens[0].value) !==
            token.amount
        )
          throw new TransactionFormatError(
            'Avalanche mapped token order mismatch',
          );
      }
      return result;
    };

    /** Reads raw available wei without rounding it into transferable asset units. */
    const hasNativeReserveWei = async (
      required: bigint,
      assertCallerFresh: () => void,
    ) => {
      if (
        typeof required !== 'bigint' ||
        required < 0n ||
        required >= 1n << 256n
      )
        throw new TransactionFormatError(
          'Invalid Avalanche native wei requirement',
        );
      const qualify = network.assertNetwork;
      const read = network.getAddressBalanceForNativeToken;
      let target: string;
      try {
        target = getAddress(configuredLock);
        if (target === '0x0000000000000000000000000000000000000000')
          throw new Error('Zero lock address');
      } catch {
        throw new TransactionFormatError('Invalid Avalanche lock address');
      }
      if (typeof qualify !== 'function' || typeof read !== 'function')
        throw new TransactionFormatError('Invalid Avalanche asset adapter');
      /** Binds each native availability read to the caller and qualified lock adapter. */
      const assertFresh = () => {
        assertCallerFresh();
        assertAssets('Avalanche native asset requirement changed');
        if (
          this.configs !== configs ||
          configs.addresses !== configuredAddresses ||
          configuredAddresses.lock !== configuredLock ||
          this.network !== network ||
          this.CHAIN_ID !== selectedChainId ||
          network.expectedChainId !== selectedChainId ||
          this.CHAIN !== AVALANCHE_CHAIN ||
          this.NATIVE_TOKEN_ID !== AVAX ||
          this.tokenMap !== tokens ||
          network.assertNetwork !== qualify ||
          network.getAddressBalanceForNativeToken !== read
        )
          throw new TransactionFormatError(
            'Avalanche native asset requirement changed',
          );
      };
      assertFresh();
      await qualify();
      assertFresh();
      const balance = await read(target);
      assertFresh();
      if (typeof balance !== 'bigint' || balance < 0n || balance >= 1n << 256n)
        throw new TransactionFormatError('Invalid Avalanche native balance');
      return balance >= required;
    };

    /** Compares wrapped requirements against exact raw AVAX and mapped token reserves. */
    this.hasLockAddressEnoughAssets = async (required) => {
      if (
        typeof required.nativeToken !== 'bigint' ||
        required.nativeToken < 0n ||
        required.nativeToken >= 1n << 256n ||
        !Array.isArray(required.tokens)
      )
        throw new TransactionFormatError(
          'Invalid Avalanche native asset requirement',
        );
      const amount = required.nativeToken;
      const tokenRequirements = required.tokens;
      const capturedRequirements = tokenRequirements.map((token) => ({
        ...token,
      }));
      const seen = new Set<string>();
      for (const token of capturedRequirements) {
        if (!assetPolicy.ids.includes(token.id))
          throw new TransactionFormatError(
            'Invalid Avalanche native asset requirement',
          );
        assetPolicy.unwrap(token.id, token.value);
        if (seen.has(token.id))
          throw new TransactionFormatError(
            'Duplicate Avalanche asset requirement',
          );
        seen.add(token.id);
      }
      const readToken = network.getAddressBalanceForERC20Asset;
      const qualify = network.assertNetwork;
      const read = network.getAddressBalanceForNativeToken;
      const wrap = tokens.wrapAmount;
      const unwrap = tokens.unwrapAmount;
      let target: string;
      try {
        target = getAddress(configuredLock);
        if (target === '0x0000000000000000000000000000000000000000')
          throw new Error('Zero lock address');
      } catch {
        throw new TransactionFormatError('Invalid Avalanche lock address');
      }
      if (
        typeof qualify !== 'function' ||
        typeof read !== 'function' ||
        typeof wrap !== 'function' ||
        typeof unwrap !== 'function'
      )
        throw new TransactionFormatError('Invalid Avalanche asset adapter');
      /** Binds each balance await and wrapping operation to the captured native requirement. */
      const assertFresh = () => {
        assertAssets('Avalanche native asset requirement changed');
        if (
          this.configs !== configs ||
          configs.addresses !== configuredAddresses ||
          configuredAddresses.lock !== configuredLock ||
          this.network !== network ||
          this.CHAIN_ID !== selectedChainId ||
          network.expectedChainId !== selectedChainId ||
          this.CHAIN !== AVALANCHE_CHAIN ||
          this.NATIVE_TOKEN_ID !== AVAX ||
          this.tokenMap !== tokens ||
          network.assertNetwork !== qualify ||
          network.getAddressBalanceForNativeToken !== read ||
          tokens.wrapAmount !== wrap ||
          tokens.unwrapAmount !== unwrap ||
          network.getAddressBalanceForERC20Asset !== readToken ||
          required.nativeToken !== amount ||
          required.tokens !== tokenRequirements ||
          tokenRequirements.length !== capturedRequirements.length ||
          tokenRequirements.some(
            (token, index) =>
              token.id !== capturedRequirements[index].id ||
              token.value !== capturedRequirements[index].value,
          )
        )
          throw new TransactionFormatError(
            'Avalanche native asset requirement changed',
          );
      };
      assertFresh();
      const nativeRequiredWei = unwrap.call(
        tokens,
        AVAX,
        amount,
        AVALANCHE_CHAIN,
      ).amount;
      assertFresh();
      if (!(await hasNativeReserveWei(nativeRequiredWei, assertFresh)))
        return false;
      assertFresh();
      for (const token of capturedRequirements) {
        const balance = await readToken.call(network, target, token.id);
        assertFresh();
        assetPolicy.available(token.id, balance);
        if (balance < assetPolicy.unwrap(token.id, token.value)) return false;
      }
      return true;
    };
    /** Generates mapped payment/management orders, reserving final assets and maximum gas. */
    this.generateMultipleTransactions = async (...args) => {
      assertAssets();
      if (!nativeRoutes.has(args[1])) {
        throw new TransactionFormatError(
          'Unsupported Avalanche transaction route',
        );
      }
      if (!validEvent(args[1], args[0])) {
        throw new TransactionFormatError('Invalid Avalanche event ID');
      }
      const originalOrders = structuredClone(args[2]);
      if (!Array.isArray(originalOrders) || originalOrders.length === 0)
        throw new TransactionFormatError('Invalid Avalanche native orders');
      for (const order of originalOrders) {
        try {
          if (
            getAddress(order.address) ===
              '0x0000000000000000000000000000000000000000' ||
            typeof order.assets.nativeToken !== 'bigint' ||
            order.assets.nativeToken < 0n ||
            order.assets.nativeToken >= 1n << 256n ||
            !Array.isArray(order.assets.tokens) ||
            (order.assets.nativeToken === 0n &&
              order.assets.tokens.length === 0) ||
            (args[1] === TransactionType.coldStorage &&
              (getAddress(order.address) !== getAddress(configuredCold) ||
                getAddress(configuredCold) === getAddress(configuredLock)))
          )
            throw new Error('Invalid native order');
          for (const token of order.assets.tokens) {
            if (assetPolicy.unwrap(token.id, token.value) <= 0n)
              throw new Error('Invalid token order');
          }
        } catch {
          throw new TransactionFormatError('Invalid Avalanche native orders');
        }
      }
      const orders = originalOrders.flatMap((order) => [
        ...(order.assets.nativeToken > 0n
          ? [
              {
                ...order,
                assets: { nativeToken: order.assets.nativeToken, tokens: [] },
              },
            ]
          : []),
        ...order.assets.tokens.map((token) => ({
          ...order,
          assets: { nativeToken: 0n, tokens: [token] },
        })),
      ]);
      const verify = this.verifyTransactionExtraConditions;
      const assets = this.getTransactionAssets;
      const enough = this.hasLockAddressEnoughAssets;
      const qualify = network.assertNetwork;
      const gas = network.getGasRequired;
      const fees = network.getFeeData;
      const nonce = network.getAddressNextAvailableNonce;
      const wrap = tokens.wrapAmount;
      const unwrap = tokens.unwrapAmount;
      const gasLimit = this.getGasLimit;
      const maxParallel = configs.maxParallelTx;
      if (
        !Number.isSafeInteger(maxParallel) ||
        maxParallel <= 0 ||
        !Array.isArray(args[3]) ||
        !Array.isArray(args[4])
      )
        throw new TransactionFormatError(
          'Invalid Avalanche pending transaction policy',
        );
      const nonceCount = new Map<number, number>();
      /** Counts only captured, self-consistent pending envelopes for this lock and chain. */
      const countNonce = (
        payment: PaymentTransaction,
        status: SigningStatus,
      ) => {
        if (!verify(payment, status))
          throw new TransactionFormatError(
            'Invalid Avalanche pending transaction',
          );
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        nonceCount.set(tx.nonce, (nonceCount.get(tx.nonce) ?? 0) + 1);
      };
      args[3].forEach((payment) => countNonce(payment, SigningStatus.UnSigned));
      args[4].forEach((raw) => {
        try {
          if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(raw))
            throw new Error('Invalid pending bytes');
          const tx = Transaction.from('0x' + raw);
          const event =
            tx.value === 0n
              ? tx.data.length === 138
                ? ''
                : tx.data.slice(-64)
              : tx.data.slice(2);
          if (tx.value === 0n) {
            if (event !== '' && !/^[0-9a-f]{64}$/.test(event))
              throw new Error('Invalid pending token event');
            assetPolicy.decode(tx, event);
          }
          countNonce(
            new PaymentTransaction(
              AVALANCHE_CHAIN,
              tx.unsignedHash,
              event,
              Buffer.from(tx.serialized.slice(2), 'hex'),
              event === '' ? TransactionType.manual : TransactionType.payment,
            ),
            SigningStatus.Signed,
          );
        } catch {
          throw new TransactionFormatError(
            'Invalid Avalanche pending transaction',
          );
        }
      });
      if (typeof qualify !== 'function')
        throw new TransactionFormatError(
          'Invalid Avalanche generation adapter',
        );
      /** Rejects configuration or consumer replacement before returning generated bytes. */
      const assertFresh = () => {
        assertAssets();
        if (
          this.network !== network ||
          this.configs !== configs ||
          this.CHAIN !== AVALANCHE_CHAIN ||
          this.NATIVE_TOKEN_ID !== AVAX ||
          this.CHAIN_ID !== selectedChainId ||
          network.expectedChainId !== selectedChainId ||
          configs.addresses !== configuredAddresses ||
          configuredAddresses.lock !== configuredLock ||
          configuredAddresses.cold !== configuredCold ||
          configs.gasLimitCap !== gasCap ||
          configs.gasLimitMultiplier !== gasMultiplier ||
          configs.maxParallelTx !== maxParallel ||
          this.getGasLimit !== gasLimit ||
          this.verifyTransactionExtraConditions !== verify ||
          this.getTransactionAssets !== assets ||
          this.hasLockAddressEnoughAssets !== enough ||
          this.tokenMap !== tokens ||
          network.getGasRequired !== gas ||
          network.getFeeData !== fees ||
          network.getAddressNextAvailableNonce !== nonce ||
          tokens.wrapAmount !== wrap ||
          tokens.unwrapAmount !== unwrap ||
          network.assertNetwork !== qualify
        )
          throw new TransactionFormatError(
            'Avalanche generation configuration changed',
          );
      };
      assertFresh();
      await qualify();
      assertFresh();
      let nextNonce = await nonce.call(network, configuredLock);
      assertFresh();
      if (!Number.isSafeInteger(nextNonce) || nextNonce < 0)
        throw new TransactionFormatError('Invalid Avalanche next nonce');
      while ((nonceCount.get(nextNonce) ?? 0) >= maxParallel) {
        nextNonce += 1;
        if (!Number.isSafeInteger(nextNonce))
          throw new TransactionFormatError(
            'Avalanche nonce exceeds safe integer',
          );
      }
      const feeData = await fees.call(network);
      assertFresh();
      const maxFeePerGas = feeData.maxFeePerGas;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      if (
        typeof maxFeePerGas !== 'bigint' ||
        maxFeePerGas <= 0n ||
        maxFeePerGas >= 1n << 256n ||
        typeof maxPriorityFeePerGas !== 'bigint' ||
        maxPriorityFeePerGas < 0n ||
        maxPriorityFeePerGas > maxFeePerGas
      )
        throw new TransactionFormatError(
          'Invalid Avalanche generation fee data',
        );
      const payments: PaymentTransaction[] = [];
      for (const order of orders) {
        while ((nonceCount.get(nextNonce) ?? 0) >= maxParallel) {
          nextNonce += 1;
          if (!Number.isSafeInteger(nextNonce))
            throw new TransactionFormatError(
              'Avalanche nonce exceeds safe integer',
            );
        }
        if (!Number.isSafeInteger(nextNonce))
          throw new TransactionFormatError(
            'Avalanche nonce exceeds safe integer',
          );
        const token = order.assets.tokens[0];
        const value = token
          ? 0n
          : unwrap.call(tokens, AVAX, order.assets.nativeToken, AVALANCHE_CHAIN)
              .amount;
        assertFresh();
        if (
          typeof value !== 'bigint' ||
          (!token && value <= 0n) ||
          value >= 1n << 256n
        )
          throw new TransactionFormatError(
            'Invalid unwrapped Avalanche native value',
          );
        const tx = Transaction.from({
          type: 2,
          chainId: selectedChainId,
          nonce: nextNonce,
          to: token ? token.id : order.address,
          value,
          data: token
            ? transfer.encodeFunctionData('transfer', [
                order.address,
                assetPolicy.unwrap(token.id, token.value),
              ]) + args[0]
            : '0x' + args[0],
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        const estimate = await gas.call(network, tx);
        assertFresh();
        tx.gasLimit = gasLimit.call(this, estimate);
        payments.push(
          new PaymentTransaction(
            AVALANCHE_CHAIN,
            tx.unsignedHash,
            args[0],
            Buffer.from(tx.unsignedSerialized.slice(2), 'hex'),
            args[1],
          ),
        );
        nextNonce += 1;
      }
      let nativeRequired = 0n;
      let nativeRequiredWei = 0n;
      const requiredTokens = new Map<string, bigint>();
      for (const payment of payments) {
        if (!verify(payment)) {
          throw new TransactionFormatError('Invalid generated C-Chain payment');
        }
        const input = (await assets(payment)).inputAssets;
        assertFresh();
        const envelope = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        if (envelope.value === 0n) {
          const token = assetPolicy.decode(envelope, payment.eventId);
          if (
            input.tokens.length !== 1 ||
            input.tokens[0].id !== token.id ||
            assetPolicy.unwrap(token.id, input.tokens[0].value) !== token.amount
          )
            throw new TransactionFormatError(
              'Generated Avalanche token accounting mismatch',
            );
        } else if (input.tokens.length !== 0)
          throw new TransactionFormatError(
            'Generated Avalanche native accounting mismatch',
          );
        if (
          typeof input.nativeToken !== 'bigint' ||
          input.nativeToken <= 0n ||
          input.nativeToken >= 1n << 256n
        )
          throw new TransactionFormatError(
            'Invalid generated Avalanche assets',
          );
        nativeRequired += input.nativeToken;
        for (const token of input.tokens) {
          assetPolicy.unwrap(token.id, token.value);
          requiredTokens.set(
            token.id,
            (requiredTokens.get(token.id) ?? 0n) + token.value,
          );
        }
        const tx = Transaction.from(
          '0x' + Buffer.from(payment.txBytes).toString('hex'),
        );
        nativeRequiredWei += tx.value + tx.gasLimit * tx.maxFeePerGas!;
      }
      if (nativeRequired >= 1n << 256n || nativeRequiredWei >= 1n << 256n)
        throw new TransactionFormatError(
          'Avalanche native reserve overflows uint256',
        );
      if (!(await hasNativeReserveWei(nativeRequiredWei, assertFresh)))
        throw new NotEnoughAssetsError(
          'Avalanche native value plus maximum fee exceeds lock assets',
        );
      assertFresh();
      if (
        requiredTokens.size > 0 &&
        !(await enough({
          nativeToken: 0n,
          tokens: [...requiredTokens].map(([id, value]) => ({ id, value })),
        }))
      )
        throw new NotEnoughAssetsError(
          'Avalanche token payments exceed lock assets',
        );
      assertFresh();
      return payments;
    };

    const verifyRawManual = this.verifyTransactionExtraConditions;
    /** Converts only unsigned mapped type-2 manual envelopes for the selected RPC chain. */
    this.rawTxToPaymentTransaction = async (raw) => {
      let tx: Transaction;
      try {
        const input = JSON.parse(raw);
        if (
          input !== null &&
          typeof input === 'object' &&
          ['sig', 'signature', 'r', 's', 'v'].some(
            (field) => input[field] != null,
          )
        )
          throw new Error('Signed raw envelope');
        tx = Transaction.from(input);
      } catch {
        throw new TransactionFormatError(
          'Invalid Avalanche raw manual transaction',
        );
      }
      const payment = new PaymentTransaction(
        AVALANCHE_CHAIN,
        tx.unsignedHash,
        '',
        Buffer.from(tx.unsignedSerialized.slice(2), 'hex'),
        TransactionType.manual,
      );
      const qualify = network.assertNetwork;
      if (
        tx.isSigned() ||
        this.verifyTransactionExtraConditions !== verifyRawManual ||
        typeof qualify !== 'function' ||
        !verifyRawManual(payment)
      )
        throw new TransactionFormatError(
          'Invalid Avalanche raw manual transaction',
        );
      await qualify();
      if (
        this.verifyTransactionExtraConditions !== verifyRawManual ||
        network.assertNetwork !== qualify ||
        !verifyRawManual(payment)
      )
        throw new TransactionFormatError(
          'Avalanche raw manual transaction changed',
        );
      return payment;
    };

    const confirmations = configs.confirmations;
    const confirmationPolicy = Object.freeze({ ...confirmations });
    const confirmationFields = new Map<
      TransactionType,
      keyof EvmConfigs['confirmations']
    >([
      [TransactionType.lock, 'observation'],
      [TransactionType.payment, 'payment'],
      [TransactionType.coldStorage, 'cold'],
      [TransactionType.manual, 'manual'],
      [TransactionType.arbitrary, 'arbitrary'],
    ]);
    const readChainId = this.CHAIN_ID;
    /** Returns each configured policy without admitting reward or unknown routes. */
    this.getTxRequiredConfirmation = (type) => {
      const field = confirmationFields.get(type);
      if (field === undefined)
        throw new TransactionFormatError(
          'Unsupported Avalanche transaction route',
        );
      const count = confirmationPolicy[field];
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new TransactionFormatError(
          'Invalid Avalanche confirmation policy',
        );
      if (
        this.configs !== configs ||
        configs.confirmations !== confirmations ||
        Object.entries(confirmationPolicy).some(
          ([key, value]) =>
            configs.confirmations[key as keyof EvmConfigs['confirmations']] !==
            value,
        ) ||
        this.network !== network ||
        this.CHAIN_ID !== readChainId ||
        network.expectedChainId !== readChainId ||
        this.CHAIN !== AVALANCHE_CHAIN ||
        this.NATIVE_TOKEN_ID !== AVAX
      )
        throw new TransactionFormatError(
          'Avalanche read configuration changed',
        );
      return count;
    };
    const requiredConfirmation = this.getTxRequiredConfirmation;
    const confirmationStatus = this.getTxConfirmationStatus;
    /** Qualifies the adapter and rejects policy or observation drift before returning status. */
    this.getTxConfirmationStatus = async (hash, type) => {
      const policy = requiredConfirmation;
      const count = policy(type);
      const assertNetwork = network.assertNetwork;
      const observe = network.getTxConfirmation;
      if (typeof assertNetwork !== 'function' || typeof observe !== 'function')
        throw new TransactionFormatError('Invalid Avalanche read adapter');
      /** Binds each awaited observation to the captured method and confirmation policy. */
      const assertFresh = () => {
        if (
          this.getTxRequiredConfirmation !== policy ||
          network.assertNetwork !== assertNetwork ||
          network.getTxConfirmation !== observe ||
          policy(type) !== count
        )
          throw new TransactionFormatError(
            'Avalanche read configuration changed',
          );
      };
      assertFresh();
      await assertNetwork();
      assertFresh();
      const status = await confirmationStatus(hash, type);
      assertFresh();
      return status;
    };
    const addresses = configs.addresses;
    const coldAddress = addresses.cold;
    const lockAddress = addresses.lock;
    /** Reads only configured assets with downward balance rounding and fresh adapter identity. */
    this.getAddressAssets = async (address, tokenIds) => {
      assertAssets();
      const selected =
        tokenIds === undefined ? [...assetPolicy.ids] : [...tokenIds];
      if (
        !Array.isArray(tokenIds ?? []) ||
        selected.some((id) => id !== AVAX && !assetPolicy.ids.includes(id)) ||
        new Set(selected).size !== selected.length
      )
        throw new TransactionFormatError('Unsupported Avalanche balance asset');
      const target = getAddress(address);
      if (target === '0x0000000000000000000000000000000000000000')
        throw new TransactionFormatError('Invalid Avalanche balance address');
      const qualify = network.assertNetwork;
      const readNative = network.getAddressBalanceForNativeToken;
      const readToken = network.getAddressBalanceForERC20Asset;
      const wrap = tokens.wrapAmount;
      /** Binds address balance awaits to their original query, map and methods. */
      const assertFresh = () => {
        assertAssets();
        if (
          this.network !== network ||
          this.configs !== configs ||
          configs.addresses !== addresses ||
          addresses.lock !== lockAddress ||
          addresses.cold !== coldAddress ||
          this.CHAIN_ID !== selectedChainId ||
          network.expectedChainId !== selectedChainId ||
          network.assertNetwork !== qualify ||
          network.getAddressBalanceForNativeToken !== readNative ||
          network.getAddressBalanceForERC20Asset !== readToken ||
          tokens.wrapAmount !== wrap ||
          (tokenIds !== undefined &&
            (tokenIds.length !== selected.length ||
              tokenIds.some((id, index) => id !== selected[index])))
        )
          throw new TransactionFormatError('Avalanche balance query changed');
      };
      assertFresh();
      await qualify();
      assertFresh();
      const native = await readNative(target);
      assertFresh();
      if (typeof native !== 'bigint' || native < 0n || native >= 1n << 256n)
        throw new TransactionFormatError('Invalid Avalanche native balance');
      const result = {
        nativeToken: assetPolicy.nativeAvailable(native),
        tokens: [] as { id: string; value: bigint }[],
      };
      assertFresh();
      if (
        typeof result.nativeToken !== 'bigint' ||
        result.nativeToken < 0n ||
        result.nativeToken >= 1n << 256n
      )
        throw new TransactionFormatError('Invalid wrapped Avalanche balance');
      for (const id of selected.filter((id) => id !== AVAX)) {
        const balance = await readToken(target, id);
        assertFresh();
        result.tokens.push({ id, value: assetPolicy.available(id, balance) });
      }
      return result;
    };
    /** Reads conservative mapped assets from the configured, qualified cold address. */
    this.getColdAddressAssets = async (tokenIds) => {
      assertAssets('Invalid Avalanche cold asset mapping');
      if (tokenIds !== undefined && !Array.isArray(tokenIds))
        throw new TransactionFormatError(
          'Unsupported Avalanche cold balance asset',
        );
      const selected =
        tokenIds === undefined ? [...assetPolicy.ids] : [...tokenIds];
      if (
        selected.some((id) => id !== AVAX && !assetPolicy.ids.includes(id)) ||
        new Set(selected).size !== selected.length
      )
        throw new TransactionFormatError(
          'Unsupported Avalanche cold balance asset',
        );
      let target: string;
      try {
        target = getAddress(coldAddress);
        if (
          target === '0x0000000000000000000000000000000000000000' ||
          target === getAddress(lockAddress)
        )
          throw new Error('Invalid cold address');
      } catch {
        throw new TransactionFormatError('Invalid Avalanche cold address');
      }
      const assertNetwork = network.assertNetwork;
      const readBalance = network.getAddressBalanceForNativeToken;
      const readToken = network.getAddressBalanceForERC20Asset;
      if (
        typeof assertNetwork !== 'function' ||
        typeof readBalance !== 'function'
      )
        throw new TransactionFormatError('Invalid Avalanche read adapter');
      /** Rejects configuration, adapter or method changes across state-read awaits. */
      const assertFresh = () => {
        assertAssets('Avalanche read configuration changed');
        if (
          this.configs !== configs ||
          configs.addresses !== addresses ||
          addresses.cold !== coldAddress ||
          addresses.lock !== lockAddress ||
          this.network !== network ||
          this.CHAIN_ID !== readChainId ||
          network.expectedChainId !== readChainId ||
          this.CHAIN !== AVALANCHE_CHAIN ||
          this.NATIVE_TOKEN_ID !== AVAX ||
          network.assertNetwork !== assertNetwork ||
          network.getAddressBalanceForNativeToken !== readBalance ||
          network.getAddressBalanceForERC20Asset !== readToken ||
          this.tokenMap !== tokens ||
          (tokenIds !== undefined &&
            (tokenIds.length !== selected.length ||
              tokenIds.some((id, index) => id !== selected[index])))
        )
          throw new TransactionFormatError(
            'Avalanche read configuration changed',
          );
      };
      assertFresh();
      await assertNetwork();
      assertFresh();
      const balance = await readBalance(target);
      assertFresh();
      if (typeof balance !== 'bigint' || balance < 0n || balance >= 1n << 256n)
        throw new TransactionFormatError('Invalid Avalanche native balance');
      const wrapped = assetPolicy.nativeAvailable(balance);
      assertFresh();
      if (typeof wrapped !== 'bigint' || wrapped < 0n || wrapped >= 1n << 256n)
        throw new TransactionFormatError('Invalid wrapped Avalanche balance');
      const tokenBalances: { id: string; value: bigint }[] = [];
      for (const id of selected.filter((id) => id !== AVAX)) {
        const raw = await readToken(target, id);
        assertFresh();
        tokenBalances.push({ id, value: assetPolicy.available(id, raw) });
      }
      return { nativeToken: wrapped, tokens: tokenBalances };
    };

    const verifyNativeEnvelope = this.verifyTransactionExtraConditions;
    /** Captures the route metadata and exact native transaction bytes. */
    const transactionIdentity = (value: PaymentTransaction) =>
      JSON.stringify([
        value.network,
        value.txId,
        value.eventId,
        value.txType,
        Buffer.from(value.txBytes).toString('hex'),
      ]);
    const signEvm = this.signTransaction;
    /** Signs captured mapped bytes only under unchanged chain, fee and signer authority. */
    this.signTransaction = async (payment, requiredSign) => {
      if (
        this.verifyTransactionExtraConditions !== verifyNativeEnvelope ||
        !verifyNativeEnvelope(payment) ||
        !Number.isSafeInteger(requiredSign) ||
        requiredSign <= 0
      ) {
        throw new TransactionFormatError('Invalid C-Chain payment for signing');
      }
      const original = transactionIdentity(payment);
      const captured = new PaymentTransaction(
        payment.network,
        payment.txId,
        payment.eventId,
        Uint8Array.from(payment.txBytes),
        payment.txType,
      );
      const qualify = network.assertNetwork;
      const fee = this.verifyTransactionFee;
      const gas = network.getGasRequired;
      const fees = network.getFeeData;
      const signer = signMediator.sign;
      const gasSlippage = configs.gasLimitSlippage;
      const priceSlippage = configs.gasPriceSlippage;
      if (
        typeof qualify !== 'function' ||
        typeof fee !== 'function' ||
        typeof signer !== 'function'
      )
        throw new TransactionFormatError('Invalid Avalanche signing adapter');
      /** Rejects changed caller bytes, fee policy or signer before and after signing awaits. */
      const assertFresh = () => {
        if (
          transactionIdentity(payment) !== original ||
          transactionIdentity(captured) !== original ||
          this.verifyTransactionExtraConditions !== verifyNativeEnvelope ||
          this.verifyTransactionFee !== fee ||
          network.getGasRequired !== gas ||
          network.getFeeData !== fees ||
          network.assertNetwork !== qualify ||
          this.signMediator !== signMediator ||
          signMediator.sign !== signer ||
          configs.gasLimitSlippage !== gasSlippage ||
          configs.gasPriceSlippage !== priceSlippage ||
          !verifyNativeEnvelope(captured)
        )
          throw new TransactionFormatError(
            'Avalanche signing authority changed',
          );
      };
      assertFresh();
      await qualify();
      assertFresh();
      const validFee = await fee(captured);
      assertFresh();
      if (!validFee) {
        throw new TransactionFormatError('Invalid C-Chain fee for signing');
      }
      const signed = await signEvm(captured, requiredSign);
      assertFresh();
      if (
        signed.network !== captured.network ||
        signed.txId !== captured.txId ||
        signed.eventId !== captured.eventId ||
        signed.txType !== captured.txType ||
        !verifyNativeEnvelope(signed, SigningStatus.Signed)
      ) {
        throw new TransactionFormatError(
          'C-Chain signer returned an invalid payment',
        );
      }
      return signed;
    };

    const submitEvm = this.submitTransaction;
    /** Admits only signed payments for this chain before inherited submission. */
    this.submitTransaction = async (payment) => {
      if (
        !this.verifyTransactionExtraConditions(payment, SigningStatus.Signed)
      ) {
        throw new TransactionFormatError(
          'Invalid C-Chain payment for submission',
        );
      }
      if (payment.txType !== TransactionType.payment)
        throw new TransactionFormatError(
          'Avalanche management requires authorized submission',
        );
      await network.assertNetwork();
      return submitEvm(payment);
    };

    /** Checks gas/assets and dispatches captured payment bytes under fresh authority. */
    this.submitAuthorizedTransaction = async (payment, authorizeSubmit) => {
      const identity = transactionIdentity;
      const original = identity(payment);
      const captured = new PaymentTransaction(
        payment.network,
        payment.txId,
        payment.eventId,
        Uint8Array.from(payment.txBytes),
        payment.txType,
      );
      const submit = network.submitAuthorizedTransaction;
      const qualify = network.assertNetwork;
      const estimate = network.getGasRequired;
      const getAssets = this.getTransactionAssets;
      const checkAssets = this.hasLockAddressEnoughAssets;
      if (
        typeof authorizeSubmit !== 'function' ||
        typeof submit !== 'function' ||
        typeof qualify !== 'function' ||
        typeof estimate !== 'function' ||
        typeof getAssets !== 'function' ||
        typeof checkAssets !== 'function' ||
        this.verifyTransactionExtraConditions !== verifyNativeEnvelope ||
        !verifyNativeEnvelope(captured, SigningStatus.Signed)
      )
        throw new TransactionFormatError(
          'Invalid authorized C-Chain submission',
        );
      const tx = Transaction.from(
        '0x' + Buffer.from(captured.txBytes).toString('hex'),
      );
      const serialized = tx.serialized;
      /** Rejects changes to the payment, adapter or protected chain identity. */
      const assertFresh = () => {
        if (
          identity(payment) !== original ||
          identity(captured) !== original ||
          tx.serialized !== serialized ||
          this.network !== network ||
          network.submitAuthorizedTransaction !== submit ||
          network.assertNetwork !== qualify ||
          network.getGasRequired !== estimate ||
          this.getTransactionAssets !== getAssets ||
          this.hasLockAddressEnoughAssets !== checkAssets ||
          this.verifyTransactionExtraConditions !== verifyNativeEnvelope ||
          this.CHAIN_ID !== network.expectedChainId ||
          !verifyNativeEnvelope(captured, SigningStatus.Signed)
        )
          throw new TransactionFormatError(
            'Authorized C-Chain payment changed',
          );
      };
      // Preflight checks preserve the legacy gas and asset requirements. Fresh
      // event/scanner/fee authority remains the caller's final admission check.
      assertFresh();
      await qualify();
      assertFresh();
      const gasRequired = await estimate(tx);
      assertFresh();
      if (gasRequired <= 0n || gasRequired > tx.gasLimit)
        throw new TransactionFormatError('Insufficient authorized C-Chain gas');
      const assets = await getAssets(captured);
      assertFresh();
      if (tx.value === 0n) {
        const token = assetPolicy.decode(tx, captured.eventId);
        if (
          assets.inputAssets.tokens.length !== 1 ||
          assets.inputAssets.tokens[0].id !== token.id ||
          assetPolicy.unwrap(token.id, assets.inputAssets.tokens[0].value) !==
            token.amount
        )
          throw new TransactionFormatError(
            'Authorized Avalanche token accounting mismatch',
          );
      } else if (assets.inputAssets.tokens.length !== 0)
        throw new TransactionFormatError(
          'Authorized Avalanche native accounting mismatch',
        );
      if (
        typeof assets.inputAssets.nativeToken !== 'bigint' ||
        assets.inputAssets.nativeToken <= 0n
      )
        throw new TransactionFormatError(
          'Invalid authorized Avalanche native assets',
        );
      const enough = await hasNativeReserveWei(
        tx.value + tx.gasLimit * tx.maxFeePerGas!,
        assertFresh,
      );
      assertFresh();
      if (!enough)
        throw new TransactionFormatError(
          'Insufficient authorized C-Chain assets',
        );
      if (
        assets.inputAssets.tokens.length > 0 &&
        !(await checkAssets({
          nativeToken: 0n,
          tokens: assets.inputAssets.tokens,
        }))
      )
        throw new TransactionFormatError(
          'Insufficient authorized C-Chain token assets',
        );
      assertFresh();
      let started = false;
      await submit(tx, async (start) => {
        await authorizeSubmit(() => {
          assertFresh();
          if (started)
            throw new TransactionFormatError(
              'Avalanche authorized submission started more than once',
            );
          started = true;
          start();
        });
      });
      assertFresh();
      if (!started)
        throw new TransactionFormatError(
          'Avalanche authorized submission did not start',
        );
    };
  }

  /** Applies the gas multiplier only to a positive estimate within the configured cap. */
  protected getGasLimit = (estimate: bigint): bigint => {
    if (estimate <= 0n || estimate > this.configs.gasLimitCap) {
      throw new Error('C-Chain gas estimate is outside the configured limit');
    }
    const limit = estimate * this.configs.gasLimitMultiplier;
    if (limit >= 1n << 256n)
      throw new Error('C-Chain gas limit overflows uint256');
    return limit;
  };

  /** Rejects underestimation and preserves the inherited upper-limit policy. */
  protected verifyGasLimit = (actual: bigint, estimate: bigint): boolean => {
    try {
      return actual >= estimate && super.verifyGasLimit(actual, estimate);
    } catch {
      return false;
    }
  };
}
