import { Transaction } from 'ethers';

import { GuardDetection } from '@rosen-bridge/detection';
import { TransactionType } from '@rosen-chains/abstract-chain';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';
import { ErgoTransaction } from '@rosen-chains/ergo';

import EventSynchronization from '../../src/synchronization/eventSynchronization';
import { eventId } from './eventSynchronizationTestData';

export { eventId } from './eventSynchronizationTestData';

/** Exposes synchronization ports for deterministic fixture controls. */
export class TestPersistenceSynchronization extends EventSynchronization {
  /** Initializes deterministic guard detection for the fixture. */
  constructor() {
    super({ activeGuards: vi.fn() } as unknown as GuardDetection);
  }
  /** Installs an active synchronization with independent response slots. */
  activate = (id: string) =>
    this.activeSyncMap.set(id, {
      timestamp: 1,
      responses: Array<PaymentTransaction | undefined>(
        this.guardPks.length,
      ).fill(undefined),
    });
  /** Reports whether the fixture synchronization remains active. */
  active = (id: string) => this.activeSyncMap.has(id);
  verification = vi
    .fn<(tx: PaymentTransaction, id: string) => Promise<boolean>>()
    .mockResolvedValue(true);
  /** Delegates repeated verification to the controlled fixture result. */
  protected verifySynchronizationResponse = (
    tx: PaymentTransaction,
    id: string,
  ) => this.verification(tx, id);
  /** Approves the fixture payment with its explicit transaction identity. */
  approve = (tx: PaymentTransaction) => this.setTxAsApproved(tx, tx.txId);
}

/** Creates a synchronization fixture value without external transport. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Exposes synchronization ports for deterministic fixture controls. */
export class TestSynchronizationFixture extends EventSynchronization {
  /** Initializes deterministic guard detection for the fixture. */
  constructor() {
    super({ activeGuards: vi.fn() } as unknown as GuardDetection);
  }
  /** Installs an active synchronization with independent response slots. */
  activate = (id = eventId) => {
    const active = {
      timestamp: 1,
      responses: Array<PaymentTransaction | undefined>(
        this.guardPks.length,
      ).fill(undefined),
    };
    this.activeSyncMap.set(id, active);
    return active;
  };
  /** Supplies the verification port used by this scenario. */
  useVerification = (
    verify: (tx: PaymentTransaction, id: string) => Promise<boolean>,
  ) => {
    this.verifySynchronizationResponse = verify;
  };
  /** Exposes response verification to the scenario. */
  verify = (tx: PaymentTransaction, id: string) =>
    this.verifySynchronizationResponse(tx, id);
  /** Exposes one sender response to the scenario. */
  respond = (tx: PaymentTransaction, id: string, sender: number) =>
    this.processSyncResponse(tx, id, sender);
  /** Acquires the approval lease for controlled race fixtures. */
  acquireApproval = () => this.approvalSemaphore.acquire();
  setTxAsApproved = vi
    .fn<(tx: PaymentTransaction) => Promise<void>>()
    .mockResolvedValue(undefined);
}

/** Creates a synchronization fixture value without external transport. */
export const evm = (network = 'ethereum', nonce = 1) => {
  const signed = Transaction.from({
    type: 2,
    chainId: network === 'binance' ? 56n : 1n,
    nonce,
    gasLimit: 25000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    to: '0x' + '12'.repeat(20),
    value: 5n,
    data: '0x' + eventId,
    signature: { r: '0x' + '01'.repeat(32), s: '0x' + '02'.repeat(32), v: 27 },
  });
  return {
    signed,
    payment: new PaymentTransaction(
      network,
      signed.unsignedHash,
      eventId,
      Buffer.from(signed.serialized.slice(2), 'hex'),
      TransactionType.payment,
    ),
  };
};

/** Creates a synchronization fixture value without external transport. */
export const ergo = () =>
  new ErgoTransaction(
    'model-id',
    eventId,
    Buffer.from('ab', 'hex'),
    TransactionType.payment,
    [Buffer.from('aa', 'hex')],
    [Buffer.from('bb', 'hex')],
  );
