import { DataSource } from '@rosen-bridge/extended-typeorm';

import { ChainAddressBalanceEntity } from '../../../src/db/entities/chainAddressBalanceEntity';

describe('ChainAddressBalanceEntity', () => {
  let source: DataSource;
  beforeEach(async () => {
    source = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [ChainAddressBalanceEntity],
      synchronize: true,
    });
    await source.initialize();
  });
  afterEach(async () => {
    await source.destroy();
  });
  describe('balance', () => {
    /**
     * @target ChainAddressBalanceEntity.balance 'preserves exact bigint %s through text storage'
     * @dependencies Actual entity and SQLite repository; in-memory database.
     * @scenario Save the named bigint and read it through the repository and SQL.
     * @expected Exact bigint round trip and SQLite text storage.
     */
    it.each([0n, 9007199254740993n, (1n << 256n) - 1n])(
      'preserves exact bigint %s through text storage',
      async (balance) => {
        const repository = source.getRepository(ChainAddressBalanceEntity);
        await repository.save({
          chain: 'ethereum',
          address: 'address',
          tokenId: 'asset',
          lastUpdate: '1',
          balance,
        });
        expect(
          (
            await repository.findOneByOrFail({
              chain: 'ethereum',
              address: 'address',
              tokenId: 'asset',
            })
          ).balance,
        ).toBe(balance);
        const rows = await source.query(
          'SELECT typeof(balance) AS storage, balance FROM chain_address_balance_entity',
        );
        expect(rows).toEqual([
          { storage: 'text', balance: balance.toString() },
        ]);
      },
    );
  });
  describe('composite primary key', () => {
    /**
     * @target ChainAddressBalanceEntity 'retains independent balances across composite keys'
     * @dependencies Actual entity and SQLite repository; in-memory database.
     * @scenario Insert the same address/token on two chains, then repeat a key.
     * @expected Two independent rows; duplicate key rejected.
     */
    it('retains independent balances across composite keys', async () => {
      const repository = source.getRepository(ChainAddressBalanceEntity);
      const row = {
        address: 'address',
        tokenId: 'asset',
        lastUpdate: '1',
        balance: 9007199254740993n,
      };
      await repository.insert([
        { ...row, chain: 'ethereum' },
        { ...row, chain: 'binance' },
      ]);
      expect(await repository.count()).toBe(2);
      await expect(
        repository.insert({ ...row, chain: 'ethereum' }),
      ).rejects.toThrow();
      expect(await repository.count()).toBe(2);
    });
  });
});
