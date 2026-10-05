import { AvalancheSafetyState } from '@rosen-bridge/evm-scanner';
import { TransactionType } from '@rosen-chains/abstract-chain';

import {
  AvalancheManagementPurpose,
  AvalancheTransactionSafety,
} from '../../src/utils/avalancheTransactionSafety';
import { createManagementSafetyFixture } from './avalancheManagementSafetyTestUtils';

describe('AvalancheTransactionSafety native management', () => {
  let fixture: Awaited<ReturnType<typeof createManagementSafetyFixture>>;
  beforeEach(async () => {
    fixture = await createManagementSafetyFixture();
  });
  afterEach(async () => {
    await fixture.close();
    vi.restoreAllMocks();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction binds native %s without an event resolver
   * @dependencies
   * - Real SQLite database and dedicated Avalanche scanner with synthetic blocks.
   * - Mocked management authority and phase checker.
   * @scenario
   * - Bind each non-event native route and invoke its identity action.
   * @expected
   * - The immutable route is checked under scanner exclusion without event lookup.
   */
  it.each([
    TransactionType.coldStorage,
    TransactionType.manual,
    TransactionType.arbitrary,
  ])('binds native %s without an event resolver', async (type) => {
    fixture.intent.txType = type;
    fixture.intent.eventId =
      type === TransactionType.arbitrary ? 'cd'.repeat(32) : '';
    const bound = await fixture.safety.bindTransaction(fixture.intent);
    const dispatch = vi.fn((captured) => captured);
    expect(await bound.withAction(dispatch)).toEqual(fixture.intent);
    expect(fixture.check).toHaveBeenCalledWith('identity');
    expect(fixture.getEvent).not.toHaveBeenCalled();
    expect(Object.isFrozen(bound.intent)).toEqual(true);
    expect(Object.isFrozen(bound)).toEqual(true);
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction separates the %s dynamic management check
   * @dependencies
   * - Real SQLite scanner with a completed synthetic frontier.
   * - Mocked phase-specific management eligibility checker.
   * @scenario
   * - Invoke one bound action with each explicit lifecycle purpose.
   * @expected
   * - The requested purpose reaches the authority checker before the action.
   */
  it.each(['identity', 'signing', 'submission'] as const)(
    'separates the %s dynamic management check',
    async (purpose) => {
      const bound = await fixture.safety.bindTransaction(fixture.intent);
      const dispatch = vi.fn(() => 'allowed');
      expect(await bound.withAction(dispatch, purpose)).toEqual('allowed');
      expect(fixture.check).toHaveBeenCalledWith(purpose);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  /**
   * @target AvalancheTransactionSafety.bindTransaction rejects malformed management %s before authority
   * @dependencies
   * - Real scanner and mocked management resolver.
   * @scenario
   * - Change only a route or its required event/order identity.
   * @expected
   * - Binding rejects before the management resolver is invoked.
   */
  it.each([
    'lock route',
    'cold event',
    'manual event',
    'arbitrary missing',
    'arbitrary uppercase',
  ])('rejects malformed management %s before authority', async (kind) => {
    if (kind === 'lock route') fixture.intent.txType = TransactionType.lock;
    if (kind === 'cold event') fixture.intent.eventId = 'cd'.repeat(32);
    if (kind === 'manual event') {
      fixture.intent.txType = TransactionType.manual;
      fixture.intent.eventId = 'cd'.repeat(32);
    }
    if (kind.startsWith('arbitrary')) {
      fixture.intent.txType = TransactionType.arbitrary;
      fixture.intent.eventId = kind.endsWith('uppercase')
        ? 'CD'.repeat(32)
        : '';
    }
    await expect(
      fixture.safety.bindTransaction(fixture.intent),
    ).rejects.toThrow('route identity');
    expect(fixture.bind).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction refuses management without an authority resolver
   * @dependencies
   * - Real scanner and a safety instance without management dependencies.
   * @scenario
   * - Bind a cold-storage intent using the existing two-argument constructor.
   * @expected
   * - The default refusal remains in force.
   */
  it('refuses management without an authority resolver', async () => {
    const safety = new AvalancheTransactionSafety(
      fixture.getEvent,
      fixture.getScanner,
    );
    await expect(safety.bindTransaction(fixture.intent)).rejects.toThrow(
      'routes are disabled',
    );
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction rejects a coercible %s order identifier
   * @dependencies
   * - Real SQLite scanner and mocked management authority resolver.
   * @scenario
   * - Supply a nonprimitive value that RegExp.test would coerce to valid order hex.
   * @expected
   * - Binding rejects before resolving authority or retaining a mutable identity.
   */
  it.each(['boxed string', 'array', 'toString object'])(
    'rejects a coercible %s order identifier',
    async (kind) => {
      const id = 'cd'.repeat(32);
      const value =
        kind === 'boxed string'
          ? Object(id)
          : kind === 'array'
            ? [id]
            : { toString: () => id };
      fixture.intent.txType = TransactionType.arbitrary;
      Object.assign(fixture.intent, { eventId: value });
      await expect(
        fixture.safety.bindTransaction(fixture.intent),
      ).rejects.toThrow('route identity');
      expect(fixture.bind).not.toHaveBeenCalled();
    },
  );

  /**
   * @target AvalancheTransactionSafety.bindTransaction rejects authority %s drift before an action
   * @dependencies
   * - Actual SQLite scanner and a mutable authority resolver fixture.
   * @scenario
   * - Capture authority, then mutate its identity or checker before dispatch.
   * @expected
   * - Dispatch rejects and releases scanner exclusion.
   */
  it.each(['identity', 'checker', 'replacement'])(
    'rejects authority %s drift before an action',
    async (kind) => {
      const bound = await fixture.safety.bindTransaction(fixture.intent);
      if (kind === 'identity')
        Object.assign(fixture.authority, { authorityId: '00'.repeat(32) });
      if (kind === 'checker')
        fixture.authority.checkUnderScannerLease = vi.fn(async () => {});
      if (kind === 'replacement')
        fixture.bind.mockResolvedValue({
          ...fixture.authority,
          authorityId: '00'.repeat(32),
        });
      const dispatch = vi.fn();
      await expect(bound.withAction(dispatch)).rejects.toThrow(
        'authority changed',
      );
      expect(dispatch).not.toHaveBeenCalled();
      await expect(fixture.scanner.update()).resolves.toBeUndefined();
    },
  );

  /**
   * @target AvalancheTransactionSafety.bindTransaction preserves scanner hold against native management
   * @dependencies
   * - Real SQLite persistent safety row and dedicated scanner.
   * @scenario
   * - Capture an intent, place the scanner on hold, and request signing.
   * @expected
   * - No phase checker or action runs while the hold remains.
   */
  it('preserves scanner hold against native management', async () => {
    const bound = await fixture.safety.bindTransaction(fixture.intent);
    await fixture.database
      .getRepository(AvalancheSafetyState)
      .update({ scanner: 'avalanche' }, { holdReason: 'management-hold' });
    const dispatch = vi.fn();
    await expect(bound.withAction(dispatch, 'signing')).rejects.toThrow(
      'not qualified',
    );
    expect(fixture.check).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction holds exclusion through policy checks and dispatch
   * @dependencies
   * - Actual SQLite scanner and mocked asynchronous policy checker.
   * @scenario
   * - Attempt a scanner update during each protected phase.
   * @expected
   * - Updates reject within the action and succeed after it returns.
   */
  it('holds exclusion through policy checks and dispatch', async () => {
    const bound = await fixture.safety.bindTransaction(fixture.intent);
    fixture.check.mockImplementation(async () => {
      await expect(fixture.scanner.update()).rejects.toThrow('already running');
    });
    await bound.withAction(async () => {
      await expect(fixture.scanner.update()).rejects.toThrow('already running');
    }, 'submission');
    await expect(fixture.scanner.update()).resolves.toBeUndefined();
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction refuses phase denial without blocking identity observation
   * @dependencies
   * - Real scanner with a management checker that refuses new effects.
   * @scenario
   * - Deny signing/submission but permit identity after a simulated consumed balance.
   * @expected
   * - New effects reject; the identity action still executes.
   */
  it('refuses phase denial without blocking identity observation', async () => {
    const bound = await fixture.safety.bindTransaction(fixture.intent);
    fixture.check.mockImplementation(async (purpose) => {
      if (purpose !== 'identity') throw new Error('new transfer is ineligible');
    });
    for (const purpose of ['signing', 'submission'] as const) {
      const dispatch = vi.fn();
      await expect(bound.withAction(dispatch, purpose)).rejects.toThrow(
        'ineligible',
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
    await expect(bound.withAction(() => 'observed')).resolves.toEqual(
      'observed',
    );
  });

  /**
   * @target AvalancheTransactionSafety.bindTransaction rejects unknown purposes and missing scanners
   * @dependencies
   * - Real scanner fixture and its current resolver.
   * @scenario
   * - Supply an unknown purpose, then remove the scanner before a valid action.
   * @expected
   * - Neither attempt invokes the checker or dispatch.
   */
  it('rejects unknown purposes and missing scanners', async () => {
    const bound = await fixture.safety.bindTransaction(fixture.intent);
    const dispatch = vi.fn();
    await expect(
      bound.withAction(dispatch, 'unknown' as AvalancheManagementPurpose),
    ).rejects.toThrow('action purpose');
    fixture.getScanner.mockReturnValue(undefined);
    await expect(bound.withAction(dispatch)).rejects.toThrow(
      'dedicated scanner',
    );
    expect(fixture.check).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
