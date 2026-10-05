import { GuardDetection } from '@rosen-bridge/detection';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';

import { DatabaseAction } from '../../src/db/databaseAction';
import EventSynchronization from '../../src/synchronization/eventSynchronization';
import { AvalancheTransactionSafety } from '../../src/utils/avalancheTransactionSafety';
import { eventId } from './avalancheSynchronizationTestData';

/** Produces a deterministic hexadecimal block identity for the fixture height. */
export const blockHash = (height: number) =>
  '0x' + height.toString(16).padStart(64, '0');

export class TestDatabase extends DatabaseAction {
  /** Exposes the existing DAO constructor with the fixture's owned data source. */
  constructor(source: DataSource) {
    super(source);
  }
}
export class TestSynchronization extends EventSynchronization {
  /** Supplies deterministic guard detection and the fixture's observation safety. */
  constructor(safety: AvalancheTransactionSafety) {
    super({ activeGuards: vi.fn() } as unknown as GuardDetection, safety);
  }
  /** Installs independent response slots for the synthetic event. */
  activate = () => {
    this.activeSyncMap.set(eventId, {
      timestamp: 1,
      responses: Array<PaymentTransaction | undefined>(
        this.guardPks.length,
      ).fill(undefined),
    });
  };
  /** Reports whether the synthetic event remains in the active synchronization. */
  active = () => this.activeSyncMap.has(eventId);
  /** Exposes the production approval action without changing its implementation. */
  approve = (tx: PaymentTransaction, id: string) =>
    this.setTxAsApproved(tx, id);
  /** Exposes the production response action for sender and quorum controls. */
  respond = (tx: PaymentTransaction, id: string, sender: number) =>
    this.processSyncResponse(tx, id, sender);
}
