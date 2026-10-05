import { Interface, Transaction } from 'ethers';

import { fixture, key } from './settledTransactionTestUtils';

/** Build a standard JOE transfer and canonical receipt using the existing real RPC fixture. */
export const receiptFixture = () => {
  const f = fixture(43114n);
  const signed = Transaction.from({
    type: 2,
    chainId: 43114n,
    nonce: 7,
    to: '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd',
    value: 0n,
    gasLimit: 80000n,
    maxFeePerGas: 30n,
    maxPriorityFeePerGas: 2n,
    data:
      new Interface(['function transfer(address,uint256)']).encodeFunctionData(
        'transfer',
        ['0x' + '22'.repeat(20), 10000000000n],
      ) + 'ab'.repeat(32),
  });
  signed.signature = key.sign(signed.unsignedHash);
  Object.assign(f.tx, signed.toJSON(), {
    chainId: signed.chainId,
    hash: signed.hash!,
    from: signed.from!,
    signature: signed.signature,
  });
  f.block.transactions[0] = signed.hash!;
  const receipt = {
    ...f.receipt,
    hash: signed.hash!,
    from: signed.from!,
    to: signed.to!,
    logs: [
      {
        address: signed.to!,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x' + signed.from!.slice(2).toLowerCase().padStart(64, '0'),
          '0x' + '22'.repeat(20).padStart(64, '0'),
        ],
        data: '0x' + 10000000000n.toString(16).padStart(64, '0'),
        removed: false,
        transactionHash: signed.hash!,
        blockHash: f.block.hash,
        blockNumber: f.block.number,
        transactionIndex: 0,
        index: 0,
      },
    ],
  };
  f.rpc.getTransactionReceipt.mockResolvedValue(receipt);
  return { ...f, signed, receipt };
};
