import fs from 'fs';

import {
  CorruptedConfigError,
  ERGO_CHAIN,
  RosenTokens,
  TokenMap,
} from '@rosen-bridge/tokens';

/** Preserve TokenMap update behavior while releasing the lease on every exit. */
class StartupTokenMap extends TokenMap {
  /** Applies token partitions and callbacks while releasing the update lease on every outcome. */
  override updateConfigByJson = async (tokens: RosenTokens): Promise<void> => {
    const release = await this.updateSemaphore.acquire();
    try {
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
}

export { TokenHandler };
