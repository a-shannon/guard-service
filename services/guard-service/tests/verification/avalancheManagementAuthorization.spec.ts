import { decodeRlp, encodeRlp, keccak256, SigningKey } from 'ethers';

import { ChainUtils, TransactionType } from '@rosen-chains/abstract-chain';

import { createManagementAuthorizationFixture } from './avalancheManagementAuthorizationTestUtils';

describe('AvalancheManagementAuthorization', () => {
  const fixtures: Awaited<
    ReturnType<typeof createManagementAuthorizationFixture>
  >[] = [];

  /** Builds one native authority fixture and registers its provider cleanup. */
  const setup = async (type = TransactionType.coldStorage, token = false) => {
    const fixture = await createManagementAuthorizationFixture(type, token);
    fixtures.push(fixture);
    return fixture;
  };

  afterEach(() => {
    fixtures.splice(0).forEach((f) => f.close());
    vi.restoreAllMocks();
  });
  describe('bind', () => {
    /**
     * @target AvalancheManagementAuthorization.bind authorizes JOE cold storage with separate AVAX reserve
     * @dependencies Actual token envelope/accounting and mutable qualified balance/policy ports
     * @scenario Bind cold signing with token balance above high and post-transfer tokens at low
     * @expected Signing succeeds; later consumed balances preserve observation identity and deny another effect
     */
    it('authorizes JOE cold storage with separate AVAX reserve', async () => {
      const f = await setup(TransactionType.coldStorage, true);
      const authority = await f.authorization.bind(f.intent());
      await authority.checkUnderScannerLease('signing');
      expect(f.cold.required).toEqual({
        nativeToken: 840000n,
        tokens: [{ id: f.tx.to!.toLowerCase(), value: 750000n }],
      });
      f.cold.locked.tokens[0].value = 1250000n;
      await authority.checkUnderScannerLease('identity');
      await expect(authority.checkUnderScannerLease('signing')).rejects.toThrow(
        'reserve',
      );
    });

    /**
     * @target AvalancheManagementAuthorization.bind refuses JOE cold %s before signing
     * @dependencies Real token input assets and isolated cold balance/reservation mutations
     * @scenario Break one token trigger, remaining token amount, native gas floor or reservation
     * @expected Effect authorization refuses while admitted observation identity remains readable
     */
    it.each([
      'trigger',
      'token low',
      'token high',
      'native floor',
      'forbidden token',
      'forbidden AVAX',
      'competing cold',
      'duplicate balance',
      'wrong required token',
    ])('refuses JOE cold %s before signing', async (fault) => {
      const f = await setup(TransactionType.coldStorage, true);
      const authority = await f.authorization.bind(f.intent());
      if (fault === 'trigger') f.cold.locked.tokens[0].value = 1500000n;
      if (fault === 'token low') f.cold.locked.tokens[0].value = 1999999n;
      if (fault === 'token high') f.cold.locked.tokens[0].value = 3000000n;
      if (fault === 'native floor') f.cold.locked.nativeToken = 939999n;
      if (fault === 'forbidden token')
        Object.assign(f.cold, { forbiddenTokens: [f.tx.to!.toLowerCase()] });
      if (fault === 'forbidden AVAX')
        Object.assign(f.cold, { forbiddenTokens: ['avax'] });
      if (fault === 'competing cold')
        Object.assign(f.cold, { activeTxIds: ['0x' + '78'.repeat(32)] });
      if (fault === 'duplicate balance')
        f.cold.locked.tokens.push({ ...f.cold.locked.tokens[0] });
      if (fault === 'wrong required token')
        f.cold.required.tokens[0].id = '0x' + '78'.repeat(20);
      await expect(authority.checkUnderScannerLease('signing')).rejects.toThrow(
        'reserve',
      );
      await expect(
        authority.checkUnderScannerLease('identity'),
      ).resolves.toBeUndefined();
    });

    /**
     * @target AvalancheManagementAuthorization.bind authorizes mapped JOE %s against the admitted order
     * @dependencies Actual mainnet chain, official token map, ethers calldata and mocked policy/DAO/fee ports
     * @scenario Bind an enabled token route and recheck signing with the exact admitted model
     * @expected Authority accepts the one selected token and does not read cold reserve state
     */
    it.each([TransactionType.manual, TransactionType.arbitrary])(
      'authorizes mapped JOE %s against the admitted order',
      async (type) => {
        const f = await setup(type, true);
        const authority = await f.authorization.bind(f.intent());
        await authority.checkUnderScannerLease('signing');
        expect(f.chain.extractTransactionOrder(f.payment())[0].assets).toEqual({
          nativeToken: 0n,
          tokens: [{ id: f.tx.to!.toLowerCase(), value: 750000n }],
        });
        expect(f.getColdState).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheManagementAuthorization.bind refuses a mapped arbitrary order with changed %s
     * @dependencies Actual token decoding and order codec; mutable admitted order port
     * @scenario Change only the approved token amount, asset or recipient
     * @expected Binding refuses before fees, signing or persistence
     */
    it.each(['amount', 'asset', 'recipient'] as const)(
      'refuses a mapped arbitrary order with changed %s',
      async (field) => {
        const f = await setup(TransactionType.arbitrary, true);
        const order = f.chain.extractTransactionOrder(f.payment());
        if (field === 'amount') order[0].assets.tokens[0].value += 1n;
        if (field === 'asset')
          order[0].assets.tokens[0].id = '0x' + '78'.repeat(20);
        if (field === 'recipient') order[0].address = '0x' + '78'.repeat(20);
        Object.assign(f.order, { orderJson: ChainUtils.encodeOrder(order) });
        await expect(f.authorization.bind(f.intent())).rejects.toThrow(
          'approved order',
        );
        expect(f.fee).not.toHaveBeenCalled();
      },
    );

    /**
     * @target AvalancheManagementAuthorization.bind authorizes native %s from the admitted row
     * @dependencies
     * - Actual ethers native envelope, AvalancheChain type/config/order extraction and token scale.
     * - Mocked fee checker and policy/database resolver ports.
     * @scenario
     * - Bind each enabled native route against its exact admitted model and policy.
     * @expected
     * - Identity and signing checks succeed with the same native value and required threshold.
     */
    it.each([
      TransactionType.coldStorage,
      TransactionType.manual,
      TransactionType.arbitrary,
    ])('authorizes native %s from the admitted row', async (type) => {
      const f = await setup(type);
      const authority = await f.authorization.bind(f.intent());
      expect(authority.authorityId).toMatch(/^[0-9a-f]{64}$/);
      await authority.checkUnderScannerLease('identity');
      await authority.checkUnderScannerLease('signing');
      expect(f.fee).toHaveBeenCalledOnce();
      expect(Object.isFrozen(authority)).toEqual(true);
    });

    /**
     * @target AvalancheManagementAuthorization.bind rejects an isolated admitted-row %s
     * @dependencies
     * - Actual native envelope and deterministic admitted-row resolver.
     * @scenario
     * - Change one database identity, relation, status, threshold or stored envelope field.
     * @expected
     * - Authority binding refuses before any transfer or signing effect.
     */
    it.each([
      'missing',
      'txId',
      'chain',
      'type',
      'event',
      'order',
      'status',
      'zero threshold',
      'fractional threshold',
      'bytes',
      'model event',
    ])('rejects an isolated admitted-row %s', async (kind) => {
      const f = await setup();
      if (kind === 'missing') f.getTx.mockResolvedValue(null);
      if (kind === 'txId') f.row.txId = '0x' + '00'.repeat(32);
      if (kind === 'chain') f.row.chain = 'ethereum';
      if (kind === 'type') f.row.type = TransactionType.manual;
      if (kind === 'event') f.row.event = { id: 'ab'.repeat(32) };
      if (kind === 'order') f.row.order = { id: 'ab'.repeat(32) };
      if (kind === 'status') f.row.status = 'invalid';
      if (kind === 'zero threshold') f.row.requiredSign = 0;
      if (kind === 'fractional threshold') f.row.requiredSign = 1.5;
      if (kind === 'bytes' || kind === 'model event') {
        const obj = JSON.parse(f.row.txJson);
        if (kind === 'bytes') obj.txBytes = 'abcd';
        else obj.eventId = 'ab'.repeat(32);
        f.row.txJson = JSON.stringify(obj);
      }
      await expect(f.authorization.bind(f.intent())).rejects.toThrow(
        'database',
      );
      expect(f.fee).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheManagementAuthorization.bind rejects isolated native envelope %s
     * @dependencies
     * - Actual ethers transaction serialization and native policy guard.
     * - Package envelope checker mocked true to isolate this policy layer.
     * @scenario
     * - Change one envelope field and regenerate its otherwise self-consistent row/hash.
     * @expected
     * - The native-envelope guard refuses before fee checks.
     */
    it.each([
      'chain',
      'type',
      'zero recipient',
      'zero value',
      'data',
      'access list',
      'zero gas',
      'zero fee',
      'wrong signer',
    ])('rejects isolated native envelope %s', async (kind) => {
      const f = await setup(TransactionType.manual);
      if (kind === 'chain') f.tx.chainId = 43114n;
      if (kind === 'type') {
        f.tx.type = 0;
        f.tx.maxFeePerGas = null;
        f.tx.maxPriorityFeePerGas = null;
        f.tx.gasPrice = 20n;
      }
      if (kind === 'zero recipient') f.tx.to = '0x' + '00'.repeat(20);
      if (kind === 'zero value') f.tx.value = 0n;
      if (kind === 'data') f.tx.data = '0x01';
      if (kind === 'access list')
        f.tx.accessList = [
          { address: '0x' + '33'.repeat(20), storageKeys: [] },
        ];
      if (kind === 'zero gas') f.tx.gasLimit = 0n;
      if (kind === 'zero fee') {
        // Ethers requires a representable envelope even when its fee is zero.
        f.tx.maxPriorityFeePerGas = 0n;
        f.tx.maxFeePerGas = 0n;
      }
      if (kind === 'wrong signer')
        f.tx.signature = new SigningKey('0x' + '22'.repeat(32)).sign(
          f.tx.unsignedHash,
        );
      f.row.txId = f.tx.unsignedHash;
      f.row.txJson = f.payment().toJson();
      await expect(f.authorization.bind(f.intent())).rejects.toThrow(
        'Avalanche management envelope',
      );
      expect(f.fee).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheManagementAuthorization.bind rejects contradictory raw fee bytes before database admission
     * @dependencies
     * - Actual ethers RLP decoder and transaction parser.
     * @scenario
     * - Increase only the encoded priority fee above its unchanged maximum fee.
     * @expected
     * - Parsing refuses before database admission, fee checks or signing effects.
     */
    it('rejects contradictory raw fee bytes before database admission', async () => {
      const f = await setup(TransactionType.manual);
      const fields = decodeRlp('0x' + f.tx.unsignedSerialized.slice(4));
      if (!Array.isArray(fields)) throw new Error('Expected type-2 RLP fields');
      fields[2] = '0x06fc23ac00'; // 30 gwei, above the unchanged 20 gwei maximum.
      const bytes = '0x02' + encodeRlp(fields).slice(2);
      await expect(
        f.authorization.bind({
          ...f.intent(),
          txBytes: bytes.slice(2),
          txId: keccak256(bytes),
        }),
      ).rejects.toThrow('priorityFee');
      expect(f.getTx).not.toHaveBeenCalled();
      expect(f.fee).not.toHaveBeenCalled();
    });

    /**
     * @target AvalancheManagementAuthorization.bind rejects isolated arbitrary order %s
     * @dependencies
     * - Actual order codec/extractor and mocked current order/database resolvers.
     * @scenario
     * - Change one approved order identity, chain, status, content or active transaction owner.
     * @expected
     * - Authority refuses the stale or different native order.
     */
    it.each([
      'missing',
      'id',
      'chain',
      'status',
      'amount',
      'competing transaction',
      'missing owner',
    ])('rejects isolated arbitrary order %s', async (kind) => {
      const f = await setup(TransactionType.arbitrary);
      if (kind === 'missing') f.getOrder.mockResolvedValue(null);
      if (kind === 'id') Object.assign(f.order, { id: 'ab'.repeat(32) });
      if (kind === 'chain') Object.assign(f.order, { chain: 'ethereum' });
      if (kind === 'status') Object.assign(f.order, { status: 'completed' });
      if (kind === 'amount')
        Object.assign(f.order, {
          orderJson: f.order.orderJson.replace('750000', '750001'),
        });
      if (kind === 'competing transaction')
        f.getOrderTxIds.mockResolvedValue(['0x' + 'ab'.repeat(32)]);
      if (kind === 'missing owner') f.getOrderTxIds.mockResolvedValue([]);
      await expect(f.authorization.bind(f.intent())).rejects.toThrow(
        'approved order',
      );
    });

    /**
     * @target AvalancheManagementAuthorization.bind permits the pending to in-process order lifecycle
     * @dependencies
     * - Actual native order identity and current database lifecycle ports.
     * @scenario
     * - Capture a pending order, then mark it in-process while retaining this admitted transaction.
     * @expected
     * - Static authority remains valid; non-content status progression is not a fingerprint failure.
     */
    it('permits the pending to in-process order lifecycle', async () => {
      const f = await setup(TransactionType.arbitrary);
      Object.assign(f.order, { status: 'pending' });
      const authority = await f.authorization.bind(f.intent());
      Object.assign(f.order, { status: 'in-process' });
      await expect(
        authority.checkUnderScannerLease('signing'),
      ).resolves.toBeUndefined();
    });

    /**
     * @target AvalancheManagementAuthorization.bind rejects isolated cold eligibility %s before new effects
     * @dependencies
     * - Actual wrapped native input assets including gasLimit multiplied by maxFeePerGas.
     * - Mutable current cold balance, waiting-asset and active-transaction ports.
     * @scenario
     * - Change only one trigger, reserve, forbidden asset or competing transaction condition.
     * @expected
     * - Signing refuses while identity observation remains available.
     */
    it.each([
      'below high',
      'fee crosses low',
      'remaining above high',
      'forbidden AVAX',
      'competing cold',
      'nonnative assets',
    ])(
      'rejects isolated cold eligibility %s before new effects',
      async (kind) => {
        const f = await setup();
        const authority = await f.authorization.bind(f.intent());
        if (kind === 'below high')
          Object.assign(f.cold, {
            locked: { nativeToken: 1000000n, tokens: [] },
          });
        if (kind === 'fee crosses low')
          Object.assign(f.cold, {
            locked: { nativeToken: 1600000n, tokens: [] },
          });
        if (kind === 'remaining above high')
          Object.assign(f.cold, {
            locked: { nativeToken: 3000000n, tokens: [] },
          });
        if (kind === 'forbidden AVAX')
          Object.assign(f.cold, { forbiddenTokens: ['avax'] });
        if (kind === 'competing cold')
          Object.assign(f.cold, { activeTxIds: ['0x' + 'ab'.repeat(32)] });
        if (kind === 'nonnative assets')
          Object.assign(f.cold, {
            required: {
              ...f.cold.required,
              tokens: [{ id: 'token', value: 1n }],
            },
          });
        await expect(
          authority.checkUnderScannerLease('signing'),
        ).rejects.toThrow('reserve');
        await expect(
          authority.checkUnderScannerLease('identity'),
        ).resolves.toBeUndefined();
      },
    );

    /**
     * @target AvalancheManagementAuthorization.bind preserves cold identity after the transferred balance is consumed
     * @dependencies
     * - Actual native signed envelope and current admitted-row/cold-state ports.
     * @scenario
     * - Capture a signed cold transaction, then expose the post-transfer balance below its high trigger.
     * @expected
     * - Identity checks remain valid without replaying cold eligibility; another POST refuses.
     */
    it('preserves cold identity after the transferred balance is consumed', async () => {
      const f = await setup();
      f.sign();
      const authority = await f.authorization.bind(f.intent());
      Object.assign(f.cold, { locked: { nativeToken: 410000n, tokens: [] } });
      f.row.status = 'sent';
      await expect(
        authority.checkUnderScannerLease('identity'),
      ).resolves.toBeUndefined();
      await expect(
        authority.checkUnderScannerLease('submission'),
      ).rejects.toThrow('reserve');
    });

    /**
     * @target AvalancheManagementAuthorization.bind refuses captured %s authority changes
     * @dependencies
     * - Admitted native cold model and independently mutable public policy/row ports.
     * @scenario
     * - Change a static confirmation policy or required signing threshold after binding.
     * @expected
     * - Identity action refuses the altered authority.
     */
    it.each(['confirmation', 'threshold'])(
      'refuses captured %s authority changes',
      async (kind) => {
        const f = await setup();
        const authority = await f.authorization.bind(f.intent());
        if (kind === 'confirmation') f.policy.config.confirmations.cold += 1;
        else f.row.requiredSign += 1;
        await expect(
          authority.checkUnderScannerLease('identity'),
        ).rejects.toThrow('static authority');
      },
    );
  });
});
