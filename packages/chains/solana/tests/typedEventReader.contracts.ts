import type { ChainMinimumFee } from '@rosen-bridge/minimum-fee';
import type { SolanaRosenExtractor } from '@rosen-bridge/rosen-extractor';
import type { TokenMap } from '@rosen-bridge/tokens';
import {
  AbstractChain,
  type ChainConfigs,
  type EventReadHandlers,
  type EventReadView,
  type EventTrigger,
} from '@rosen-chains/abstract-chain';
import type { BlockInfo } from '@rosen-chains/abstract-chain';

import { AbstractSolanaEventChain } from '../lib/abstractSolanaEventChain';
import { AbstractSolanaNetwork } from '../lib/abstractSolanaNetwork';
import type { SolanaEventTransaction } from '../lib/requestBoundEventContext';

declare const rawNetwork: AbstractSolanaNetwork<string>;
declare const carrierNetwork: AbstractSolanaNetwork;
declare const configs: ChainConfigs;
declare const tokenMap: TokenMap;
declare const extractor: SolanaRosenExtractor;
const rawRead: Promise<string> = rawNetwork.getTransaction('tx', 'block');
const carrierRead: Promise<SolanaEventTransaction> =
  carrierNetwork.getTransaction('tx', 'block');
void [rawRead, carrierRead];

// The explicit ordinary-read generic keeps the raw read type at its boundary.
const explicitRawArguments: ConstructorParameters<
  typeof AbstractSolanaEventChain<string>
> = [rawNetwork, configs, tokenMap, extractor];
void explicitRawArguments;

// The default event-chain constructor still requires event-carrier reads.
abstract class DefaultEventChainProbe extends AbstractSolanaEventChain {}
type DefaultEventChainNetwork = ConstructorParameters<
  typeof DefaultEventChainProbe
>[0];
// @ts-expect-error a raw ordinary network cannot satisfy the default carrier network
const unsafeDefaultNetwork: DefaultEventChainNetwork = rawNetwork;
void unsafeDefaultNetwork;

// Reader and policy handlers must use the same transaction type.
abstract class TypedHelperProbe extends AbstractChain<SolanaEventTransaction> {
  declare readonly event: EventTrigger;
  declare readonly fee: ChainMinimumFee;
  declare readonly handlers: EventReadHandlers<SolanaEventTransaction>;

  verifyTypedReader(reader: EventReadView<SolanaEventTransaction>) {
    return this.verifyEventWithReaderUsingHandlers(
      this.event,
      this.fee,
      reader,
      this.handlers,
    );
  }

  rejectRawReader(reader: EventReadView<string>) {
    return this.verifyEventWithReaderUsingHandlers(
      this.event,
      this.fee,
      // @ts-expect-error carrier handlers cannot be paired with a string reader
      reader,
      this.handlers,
    );
  }
}

// Existing three-argument protected callers remain source-compatible.
abstract class LegacyHelperProbe extends AbstractChain<string> {
  declare readonly event: EventTrigger;
  declare readonly fee: ChainMinimumFee;

  verifyLegacyReader(reader: EventReadView<string>) {
    return this.verifyEventWithReader(this.event, this.fee, reader);
  }
}

abstract class AcceptedCarrierHookOverride extends AbstractSolanaEventChain<string> {
  protected override serializeTx = (
    transaction: string | SolanaEventTransaction,
  ): string =>
    typeof transaction === 'string' ? transaction : transaction.extractorInput;

  override verifyLockTransactionExtraConditions = async (
    transaction: string | SolanaEventTransaction,
    blockInfo: BlockInfo,
  ): Promise<boolean> =>
    typeof transaction === 'string' ||
    transaction.requestedBlockhash === blockInfo.hash;
}

abstract class RejectedRawOnlyHookOverride extends AbstractSolanaEventChain<string> {
  // @ts-expect-error an ordinary-only serializer cannot receive an event carrier
  protected override serializeTx = (transaction: string): string => transaction;
}

abstract class RejectedRawOnlyVerifierOverride extends AbstractSolanaEventChain<string> {
  // @ts-expect-error an ordinary-only verifier cannot receive an event carrier
  override verifyLockTransactionExtraConditions = async (
    transaction: string,
  ): Promise<boolean> => typeof transaction === 'string';
}

void DefaultEventChainProbe;
void TypedHelperProbe;
void LegacyHelperProbe;
void AcceptedCarrierHookOverride;
void RejectedRawOnlyHookOverride;
void RejectedRawOnlyVerifierOverride;
