import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import type {
  TssAuthorizationPhase,
  TssAuthorizationPolicy,
  TssSigningIdentity,
} from './qualifiedTssSigner';

export type TssSigningKey = Omit<TssSigningIdentity, 'message'>;

export interface BoundSigningAction {
  readonly bindingId: string;
  withAction<T>(action: () => Promise<T>): Promise<T>;
}

interface SigningContext {
  readonly key: string;
  readonly bindingId: string;
  readonly withAction: BoundSigningAction['withAction'];
}

interface AuthorizationEntry extends SigningContext {
  readonly expiresAt: number;
}

/** Local transaction context authorizes digests; peer messages cannot create it. */
export class TssAuthorizationRegistry implements TssAuthorizationPolicy {
  private readonly context = new AsyncLocalStorage<SigningContext>();
  private readonly entries = new Map<string, AuthorizationEntry>();

  /** Captures bounded permit lifetime and registry capacity. */
  constructor(
    private readonly lifetimeMs: number,
    private readonly maxEntries: number,
  ) {
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 2147483647 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 10000
    )
      throw new Error('Invalid TSS authorization limits');
  }

  /** Validates and serializes the algorithm, chain code and derivation-path identity. */
  private keyIdentity(key: TssSigningKey): string {
    if (
      !['ecdsa', 'eddsa'].includes(key.algorithm) ||
      typeof key.chainCode !== 'string' ||
      !key.chainCode.length ||
      key.chainCode.trim() !== key.chainCode
    )
      throw new Error('Invalid TSS signing key identity');
    const path = key.derivationPath;
    if (key.algorithm === 'ecdsa') {
      if (
        !Array.isArray(path) ||
        path.length < 1 ||
        path.length > 255 ||
        Array.from(path).some(
          (index) =>
            !Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31,
        )
      )
        throw new Error('Invalid TSS derivation path');
    } else if (path !== undefined) {
      throw new Error('EdDSA does not use a derivation path');
    }
    return JSON.stringify([key.algorithm, key.chainCode, path ?? null]);
  }

  /** Supplies an immutable, already bound local transaction to its chain signer. */
  withContext<T>(
    key: TssSigningKey,
    binding: BoundSigningAction,
    action: () => T | Promise<T>,
  ): T | Promise<T> {
    if (
      typeof binding.bindingId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(binding.bindingId) ||
      typeof binding.withAction !== 'function'
    )
      throw new Error('Invalid local TSS transaction binding');
    const context = Object.freeze({
      key: this.keyIdentity(key),
      bindingId: binding.bindingId,
      withAction: binding.withAction.bind(binding),
    });
    return this.context.run(context, action);
  }

  /** Authorizes a signing phase using retained local context, expiry and binding checks. */
  withAuthorization = async <T>(
    identity: TssSigningIdentity,
    phase: TssAuthorizationPhase,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (
      typeof identity.message !== 'string' ||
      !/^[0-9a-f]{64}$/.test(identity.message) ||
      !['queue', 'backend', 'outbound', 'result'].includes(phase)
    )
      throw new Error('Invalid TSS authorization request');
    // Copy all deciding fields before invoking any asynchronous policy code.
    const key = this.keyIdentity(identity);
    const id = `${identity.algorithm}:${identity.message}`;
    const now = performance.now();
    let entry = this.entries.get(id);
    if (entry && entry.expiresAt <= now) {
      this.entries.delete(id);
      entry = undefined;
    }
    if (phase === 'queue') {
      const context = this.context.getStore();
      if (!context || context.key !== key)
        throw new Error(
          'TSS signing has no matching local transaction context',
        );
      if (entry && (entry.key !== key || entry.bindingId !== context.bindingId))
        throw new Error(
          'TSS digest is already bound to a different transaction',
        );
      if (!entry) {
        for (const [expiredId, candidate] of this.entries)
          if (candidate.expiresAt <= now) this.entries.delete(expiredId);
        if (this.entries.size >= this.maxEntries)
          throw new Error('TSS authorization capacity reached');
        entry = Object.freeze({ ...context, expiresAt: now + this.lifetimeMs });
        this.entries.set(id, entry);
      }
    }
    if (!entry || entry.key !== key)
      throw new Error('TSS digest is not authorized for this signing key');
    const authorized = entry;
    try {
      return await authorized.withAction(async () => {
        if (
          this.entries.get(id) !== authorized ||
          performance.now() >= authorized.expiresAt
        )
          throw new Error('TSS authorization expired before dispatch');
        return await action();
      });
    } catch (error) {
      // Revocation also closes delayed work already created by a failed enqueue.
      if (phase === 'queue' && this.entries.get(id) === authorized)
        this.entries.delete(id);
      throw error;
    }
  };
}
