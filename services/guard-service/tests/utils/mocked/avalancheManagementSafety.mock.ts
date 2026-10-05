import type {
  AvalancheManagementPurpose,
  BoundAvalancheManagementAuthority,
} from '../../../src/utils/avalancheTransactionSafety';

/** Creates a deterministic authority resolver whose phase checks can be isolated. */
export const mockManagementAuthority = () => {
  const check = vi.fn(async (_purpose: AvalancheManagementPurpose) => {});
  const authority: BoundAvalancheManagementAuthority = {
    authorityId: 'ab'.repeat(32),
    checkUnderScannerLease: check,
  };
  const bind = vi.fn(async () => authority);
  return { authority, bind, check };
};
