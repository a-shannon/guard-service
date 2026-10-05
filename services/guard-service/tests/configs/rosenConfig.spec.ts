import { NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import {
  readAvalancheBridgeContracts,
  readAvalancheContracts,
} from '../../src/configs/rosenConfig';
import { address, ergo, contracts } from './avalancheConfigTestUtils';

describe('readAvalancheContracts', () => {
  /**
   * @target readAvalancheContracts preserves the lock-only scanner contract
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply only a valid lock address.
   * @expected Return the lock-only contract.
   */
  it('preserves the lock-only scanner contract', () => {
    expect(
      readAvalancheContracts({
        addresses: { lock: contracts().addresses.lock },
      }),
    ).toEqual({ addresses: { lock: contracts().addresses.lock } });
  });
});

describe('readAvalancheBridgeContracts', () => {
  /**
   * @target readAvalancheBridgeContracts captures immutable complete contracts without fabricating management fields
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Mutate caller addresses and RWT after parsing.
   * @expected Retain frozen captured values and only declared fields.
   */
  it('captures immutable complete contracts without fabricating management fields', () => {
    const input = contracts();
    const output = readAvalancheBridgeContracts(input);
    input.addresses.WatcherPermit = 'changed';
    input.addresses.cold = '0x' + '56'.repeat(20);
    input.tokens.RWTId = 'changed';
    expect(output.addresses.WatcherPermit).toEqual(ergo);
    expect(output.addresses.cold).toEqual('0x' + '34'.repeat(20));
    expect(output.tokens.RWTId).toEqual('ab'.repeat(32));
    expect(Object.keys(output.addresses).sort()).toEqual([
      'Commitment',
      'Fraud',
      'WatcherPermit',
      'WatcherTriggerEvent',
      'cold',
      'lock',
    ]);
    expect(
      [output, output.addresses, output.tokens].every(Object.isFrozen),
    ).toEqual(true);
  });
  /**
   * @target readAvalancheBridgeContracts accepts syntactically valid Ergo addresses on either existing network prefix
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Use a mainnet-prefixed valid Ergo fraud address.
   * @expected Preserve the supplied valid address.
   */
  it('accepts syntactically valid Ergo addresses on either existing network prefix', () => {
    const input = contracts();
    input.addresses.Fraud = address.to_base58(NetworkPrefix.Mainnet);
    expect(readAvalancheBridgeContracts(input).addresses.Fraud).toEqual(
      input.addresses.Fraud,
    );
  });
  for (const field of [
    'lock',
    'cold',
    'WatcherPermit',
    'Fraud',
    'WatcherTriggerEvent',
    'Commitment',
  ]) {
    for (const bad of [undefined, 1, '', 'invalid']) {
      /**
       * @target readAvalancheBridgeContracts `rejects ${field} with value ${String(bad)}`
       * @dependencies Real configuration readers; synthetic input records.
       * @scenario Replace one address field with each invalid value.
       * @expected Throw for every invalid address independently.
       */
      it(`rejects ${field} with value ${String(bad)}`, () => {
        const input = contracts();
        Object.assign(input.addresses, { [field]: bad });
        expect(() => readAvalancheBridgeContracts(input)).toThrow();
      });
    }
  }
  /**
   * @target readAvalancheBridgeContracts rejects a zero lock address
   * @dependencies Real configuration readers; synthetic input records.
   * @scenario Supply a zero EVM lock address.
   * @expected Throw before accepting the contract.
   */
  it('rejects a zero lock address', () => {
    const input = contracts();
    input.addresses.lock = '0x' + '0'.repeat(40);
    expect(() => readAvalancheBridgeContracts(input)).toThrow();
  });
  /**
   * @target readAvalancheBridgeContracts rejects malformed cold address %s
   * @dependencies Real EVM address parser and complete synthetic contracts.
   * @scenario Change only cold to a zero address, invalid checksum, wrong-chain address or surrounding whitespace.
   * @expected Reject the cold field without exposing its value.
   */
  it.each([
    '0x' + '0'.repeat(40),
    '0x52908400098527886E0F7030069857D2E4169Ee7',
    ergo,
    ' 0x' + '34'.repeat(20),
    '0x' + '34'.repeat(20) + '\n',
  ])('rejects malformed cold address %s', (cold) => {
    const input = contracts();
    input.addresses.cold = cold;
    expect(() => readAvalancheBridgeContracts(input)).toThrow(
      'Invalid Avalanche cold address',
    );
  });
  /**
   * @target readAvalancheBridgeContracts normalizes an explicitly supplied valid cold address
   * @dependencies Real EVM checksum parser and complete synthetic contracts.
   * @scenario Supply a valid checksummed EVM cold address.
   * @expected Capture the normalized address without borrowing the lock address.
   */
  it('normalizes an explicitly supplied valid cold address', () => {
    const input = contracts();
    input.addresses.cold = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(readAvalancheBridgeContracts(input).addresses.cold).toEqual(
      input.addresses.cold.toLowerCase(),
    );
  });
  for (const bad of [
    undefined,
    1,
    '',
    '00'.repeat(32),
    'ab'.repeat(31),
    'gg'.repeat(32),
  ]) {
    /**
     * @target readAvalancheBridgeContracts `rejects malformed RWT ${String(bad)}`
     * @dependencies Real configuration readers; synthetic input records.
     * @scenario Replace RWTId with an invalid type, length or encoding.
     * @expected Throw for every malformed RWT identifier.
     */
    it(`rejects malformed RWT ${String(bad)}`, () => {
      const input = contracts();
      Object.assign(input.tokens, { RWTId: bad });
      expect(() => readAvalancheBridgeContracts(input)).toThrow();
    });
  }
});
