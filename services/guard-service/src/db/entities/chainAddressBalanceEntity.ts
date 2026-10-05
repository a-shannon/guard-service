import {
  BigIntValueTransformer,
  Column,
  Entity,
  PrimaryColumn,
} from '@rosen-bridge/extended-typeorm';

@Entity()
export class ChainAddressBalanceEntity {
  @PrimaryColumn('varchar')
  chain: string;

  @PrimaryColumn('varchar')
  address: string;

  @PrimaryColumn('varchar')
  tokenId: string;

  @Column('varchar')
  lastUpdate: string;

  // SQLite numeric affinity otherwise passes large integers through JS numbers.
  @Column({ type: 'text', transformer: new BigIntValueTransformer() })
  balance: bigint;
}
