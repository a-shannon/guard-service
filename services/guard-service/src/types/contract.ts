import { SupportedChain } from '../types/config';

export interface ChainConfigs {
  addresses: {
    lock: string;
    cold: string;
    WatcherTriggerEvent: string;
    WatcherPermit: string;
    Fraud: string;
    Commitment: string;
    guardSign: string;
  };
  tokens: {
    RWTId: string;
    CleanupNFT: string;
  };
  cleanupConfirm: number;
}
export interface AvalancheContracts {
  readonly addresses: { readonly lock: string };
}
export interface AvalancheBridgeContracts extends AvalancheContracts {
  readonly addresses: AvalancheContracts['addresses'] & {
    readonly cold: string;
    readonly WatcherPermit: string;
    readonly Fraud: string;
    readonly WatcherTriggerEvent: string;
    readonly Commitment: string;
  };
  readonly tokens: { readonly RWTId: string };
}
export type AllChainsConfigs = {
  avalanche?: AvalancheContracts;
  version: string;
  tokens: {
    RWTRepoNFT: string;
    RSN: string;
    GuardNFT: string;
    MinFeeNFT: string;
  };
} & {
  [K in SupportedChain]: ChainConfigs;
};
