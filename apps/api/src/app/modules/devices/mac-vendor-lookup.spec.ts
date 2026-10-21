import { lookupMacVendor, macOuiDatabase } from './mac-vendor-lookup';

describe('lookupMacVendor', () => {
  it('resolves a globally assigned prefix with explicit clue provenance', () => {
    expect(lookupMacVendor('3c:71:bf:32:4b:44')).toEqual({
      status: 'matched', vendor: 'Espressif Inc.', prefix: '3C:71:BF', assignmentType: 'MA-L',
      databaseVersion: macOuiDatabase.version, source: macOuiDatabase.source,
      sourceSha256: macOuiDatabase.sourceSha256,
      classification: 'network_interface_vendor_clue',
    });
  });

  it('does not claim a vendor for locally administered or randomized MAC addresses', () => {
    expect(lookupMacVendor('3E:71:BF:32:4B:44').status).toBe('locally_administered');
  });

  it('does not perform an OUI lookup for multicast or invalid values', () => {
    expect(lookupMacVendor('3D:71:BF:32:4B:44').status).toBe('multicast');
    expect(lookupMacVendor('not-a-mac').status).toBe('invalid');
  });

  it('reports unknown globally administered prefixes without guessing', () => {
    expect(lookupMacVendor('AA:BB:CC:DD:EE:FF').status).toBe('locally_administered');
    expect(lookupMacVendor('00:BB:CC:DD:EE:FF').status).toBe('unknown');
  });
});
