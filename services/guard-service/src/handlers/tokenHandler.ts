import fs from 'fs';

import {
  CorruptedConfigError,
  ERGO_CHAIN,
  RosenTokens,
  TokenMap,
} from '@rosen-bridge/tokens';

/** The installed TokenMap readers retain their API; only startup sealing is added. */
class StartupTokenMap extends TokenMap {
  #sealed = false;

  /** Applies token partitions and callbacks while releasing the update lease on every outcome. */
  override updateConfigByJson = async (tokens: RosenTokens): Promise<void> => {
    const release = await this.updateSemaphore.acquire();
    try {
      if (this.#sealed)
        throw new Error('Avalanche startup token map is sealed');
      const bridgeable: RosenTokens = [];
      const unbridgeable: RosenTokens = [];
      // Keep the partition rules of tokens 6.0.2, releasing even on malformed
      // input or a throwing callback (the upstream implementation lacks finally).
      for (const tokenSet of tokens) {
        const chains = Object.keys(tokenSet);
        if (chains.length === 0)
          throw new CorruptedConfigError('Found empty token set');
        if (chains.length === 1 && chains[0] !== ERGO_CHAIN)
          unbridgeable.push(tokenSet);
        else if (chains.includes(ERGO_CHAIN)) bridgeable.push(tokenSet);
        else
          throw new CorruptedConfigError(
            `Found token set without chain [${ERGO_CHAIN}]`,
          );
      }
      this.tokensConfig = bridgeable;
      this.unbridgeableTokens = unbridgeable;
      for (const callback of this.callbacks.values()) callback();
    } finally {
      release();
    }
  };

  /** Serializes startup sealing with token updates and freezes the captured token partitions. */
  sealForAvalanche = async (): Promise<void> => {
    const release = await this.updateSemaphore.acquire();
    try {
      if (this.#sealed) return;
      const seen = new WeakSet<object>();
      /** Freezes nested token data once per object, including cyclic references. */
      const freeze = (value: unknown): void => {
        if (value === null || typeof value !== 'object' || seen.has(value))
          return;
        seen.add(value);
        for (const member of Object.values(value)) freeze(member);
        Object.freeze(value);
      };
      freeze(this.tokensConfig);
      freeze(this.unbridgeableTokens);
      for (const key of [
        'tokensConfig',
        'unbridgeableTokens',
        'updateConfigByJson',
      ] as const)
        Object.defineProperty(this, key, {
          writable: false,
          configurable: false,
        });
      // Readers must not be replaced with views that disagree with the sealed
      // storage. Lock method bindings, leaving operational state mutable.
      for (const [key, value] of Object.entries(this))
        if (typeof value === 'function')
          Object.defineProperty(this, key, {
            writable: false,
            configurable: false,
          });
      this.#sealed = true;
    } finally {
      release();
    }
  };
}

class TokenHandler {
  private static instance: TokenHandler;
  protected tokenMap: StartupTokenMap;

  private constructor() {
    // do nothing
  }

  /**
   * initializes TokenHandler with tokens from the specified path
   * @param tokensPath path to tokens json file
   */
  static init = async (tokensPath: string): Promise<void> => {
    if (!TokenHandler.instance) {
      if (!fs.existsSync(tokensPath)) {
        throw new Error(`tokensMap file with path ${tokensPath} doesn't exist`);
      }
      TokenHandler.instance = new TokenHandler();
      const tokensJson: string = fs.readFileSync(tokensPath, 'utf8');
      const tokens = JSON.parse(tokensJson).tokens;
      TokenHandler.instance.tokenMap = new StartupTokenMap();
      await TokenHandler.instance.tokenMap.updateConfigByJson(tokens);
    }
  };

  /**
   * returns the TokenHandler instance if initialized
   * @returns TokenHandler instance
   */
  static getInstance = (): TokenHandler => {
    if (!TokenHandler.instance) {
      throw new Error('TokenHandler is not initialized');
    }
    return TokenHandler.instance;
  };

  /**
   * @returns the token map
   */
  getTokenMap = (): TokenMap => {
    return this.tokenMap;
  };

  /** Explicit startup opt-in; no job or configuration flag invokes it implicitly. */
  sealForAvalanche = async (): Promise<void> => {
    Object.defineProperty(this, 'tokenMap', {
      writable: false,
      configurable: false,
    });
    Object.defineProperty(this, 'getTokenMap', {
      writable: false,
      configurable: false,
    });
    await this.tokenMap.sealForAvalanche();
  };
}

export { TokenHandler };
