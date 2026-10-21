import { macOuiDatabaseSource, macOuiDatabaseVersion, macOuiRecords, macOuiSourceSha256 } from './mac-oui-database';

/** Versioned local snapshot of IEEE's public MA-L registry; no runtime lookup. */
export const macOuiDatabase = {
  version: macOuiDatabaseVersion,
  source: macOuiDatabaseSource,
  sourceSha256: macOuiSourceSha256,
  assignmentType: 'MA-L',
} as const;

export type MacVendorLookup =
  | { status: 'matched'; vendor: string; prefix: string; assignmentType: string; databaseVersion: string; source: string; sourceSha256: string; classification: 'network_interface_vendor_clue' }
  | { status: 'locally_administered' | 'multicast' | 'unknown' | 'invalid'; databaseVersion: string; source: string };

export function lookupMacVendor(value: string | undefined): MacVendorLookup {
  const source = macOuiDatabase.source;
  const databaseVersion = macOuiDatabase.version;
  if (!value || !/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value)) return { status: 'invalid', source, databaseVersion };
  const octets = value.replace(/[:-]/g, '').match(/.{2}/g)!.map(octet => Number.parseInt(octet, 16));
  if ((octets[0] & 0x01) !== 0) return { status: 'multicast', source, databaseVersion };
  if ((octets[0] & 0x02) !== 0) return { status: 'locally_administered', source, databaseVersion };
  const prefix = octets.slice(0, 3).map(octet => octet.toString(16).padStart(2, '0')).join(':').toUpperCase();
  const vendor = macOuiRecords[prefix];
  return vendor
    ? { status: 'matched', vendor, prefix, assignmentType: macOuiDatabase.assignmentType, databaseVersion, source, sourceSha256: macOuiDatabase.sourceSha256, classification: 'network_interface_vendor_clue' }
    : { status: 'unknown', source, databaseVersion };
}
