import { TokenMap } from '@rosen-bridge/tokens';
import { PaymentTransaction } from '@rosen-chains/abstract-chain';

import TxAgreement from '../../src/agreement/txAgreement';
import GuardPkHandler from '../../src/handlers/guardPkHandler';
import { TokenHandler } from '../../src/handlers/tokenHandler';
import GuardTurn from '../../src/utils/guardTurn';
import DatabaseActionMock from '../db/mocked/databaseAction.mock';
import { tokenMapping } from '../utils/avalancheChainTestUtils';
import { admissionFixture } from '../verification/avalancheManagementAdmissionTestUtils';

/** Joins the real mainnet cold job and chain while isolating endpoint, turn and agreement queue ports. */
export const coldProducerFixture = async () => {
  await DatabaseActionMock.clearTables();
  const f = await admissionFixture(true);
  const tokens = new TokenMap();
  await tokens.updateConfigByJson(tokenMapping());
  vi.spyOn(TokenHandler.getInstance(), 'getTokenMap').mockReturnValue(tokens);
  vi.spyOn(GuardTurn, 'guardTurn').mockReturnValue(
    GuardPkHandler.getInstance().guardId,
  );
  vi.spyOn(f.network, 'getAddressNextAvailableNonce').mockResolvedValue(0);
  const queued: PaymentTransaction[] = [];
  vi.spyOn(TxAgreement, 'getInstance').mockResolvedValue({
    getChainPendingTransactions: () => [],
    addTransactionToQueue: (payment: PaymentTransaction) =>
      queued.push(payment),
  } as unknown as TxAgreement);
  return { ...f, queued };
};
