import { blake2b } from 'blakejs';

export const eventId = Buffer.from(
  blake2b('synchronization-source', undefined, 32),
).toString('hex');
export default {
  payment: {
    network: 'ergo',
    txId: 'af6f3eb9fb67db7898258546585dbb7060d962161f56e4c6bdcc03eedc46a82d',
    eventId: '',
    txBytes:
      '9c060174826021b3375b16b4529b8207a947608b8bcbbd611503455c7bd444ae2c038d00000002ca0c38b1b9e9c253183cebbf6e2372f816b0e1a579aa423c974d100a8911e0e5895a0268c749b9ab894e4d064a783dfe1361b64c9d99857c391390d630ebe2d205e0a7120008cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37fe4a03c0000e0a71210130400040004040400040204000e204b1e5bcfbd6763b9cea8411841213611258fabed16293af6aa8cd8200b7e12860404040004000400010104020400040004000e20c2eeb21a772554cc9733586df12f27d2f444f50e623c1f57cf89c09dc5097c5505020101d807d601b2a5730000d6028cb2db6308a773010001d603aeb5b4a57302b1a5d901036391b1db630872037303d9010363aedb63087203d901054d0e938c7205017202d604e4c6a7041ad605b2a5730400d606db63087205d607ae7206d901074d0e938c720701720295938cb2db63087201730500017306d196830301ef7203938cb2db6308b2a473070073080001b2720473090095720796830201938cb27206730a0001720293c27205c2a7730bd801d608c2a7d196830501ef720393c27201720893e4c67201041a7204938cb2db6308b2a4730c00730d0001b27204730e00957207d801d609b27206730f0096830701938c720901720293cbc272057310e6c67205051ae6c67205060e93e4c67205070ecb720893e4c67205041a7204938c72090273117312e4a03c020001014b010e20c318fdf3aec1aa2cfb8282001cdbf233d320e4faf55c8fa5d1670f537d4ebff6e0a7120008cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37fe4a03c0000e0a7120008cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37fe4a03c020001014b00e091431005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304e4a03c0000cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37f0000',
    txType: 'manual',
    inputBoxes: [
      'e0b08c010008cd02ba9caed7214e9bc5ab7ef4ab049b891208d16fd6d5612f8e4bf211a0c0b1a37fe3a03c02ca0c38b1b9e9c253183cebbf6e2372f816b0e1a579aa423c974d100a8911e0e502895a0268c749b9ab894e4d064a783dfe1361b64c9d99857c391390d630ebe2d296010025a9ea65f1a1ae42695e1ef244a111e300fb6576d9f23f9c8b4661ebed3c18d500',
    ],
    dataInputs: [],
  },
  lock: '9fwFGZqo1uyc3bW84SCdYEvbncWy51AcHUtD1s5txDus8qBBihv',
  order: [
    {
      address: '9fwFGZqo1uyc3bW84SCdYEvbncWy51AcHUtD1s5txDus8qBBihv',
      assets: {
        nativeToken: {
          integer: '300000',
        },
        tokens: [],
      },
    },
    {
      address:
        'EE7687i4URb4YuSGSQXPCb7yjKwPzLkrEB4u6kZdScqCkeY81qy66Mz69ohJQhx9whKit1dh7VuPpzSeuadba8PcuitfKL6xnBhHYHXc7Uf6i6tq8NkqfZi1HToyAbVPz4LgnGE9sDbJqgvtord736pvsVmdfmRmTvaEQ8VTDx7RoK71VhEXuwqZF2UjWdY3G3DpmdWPGKprtLg4kjB4ikRpYG9eG9rF33ucgQ1hHmu1UeAUXqhv9e2U7VfF2X6D9js7zc4FXJb1ct4H56eEgwLbKRDAegkHUmeH1TJSknxRqTP1W97E9b9tSRj8P3CEi58J7GzmoWVJUg1ZXmQGAHfFUvDVC6Kif9tNE9rwuvp43QzoFVHcNdNCXxpUhBs7FkKHaW8mBVxzMoXQnpekVVuFePqgNL5CDQ8CjbmwHCSkvbRyXifVr8bCqmxytfEiyGMVzAZjEu3TcoERSJYRt2QwsaJ4wCneFUbm7kvNJ9rDgJS9wzHGLKtbgVbh1STbRwp5Zo6TtvrnQkUkf2sMcnpeZn6LfQSQwdJXdXr',
      assets: {
        nativeToken: {
          integer: '300000',
        },
        tokens: [
          {
            id: 'ca0c38b1b9e9c253183cebbf6e2372f816b0e1a579aa423c974d100a8911e0e5',
            value: {
              integer: '1',
            },
          },
          {
            id: '895a0268c749b9ab894e4d064a783dfe1361b64c9d99857c391390d630ebe2d2',
            value: {
              integer: '75',
            },
          },
        ],
      },
      extra: 'c318fdf3aec1aa2cfb8282001cdbf233d320e4faf55c8fa5d1670f537d4ebff6',
    },
  ],
  provenance: {
    repository: 'rosen-bridge/guard-service',
    commit: 'b1f5ab6f81435053a979e8078eb098d8ec1f5a47',
    path: 'packages/chains/ergo/tests/transactionTestData.ts',
    fixture: 'transaction6',
  },
};
