export interface PrivateReceiptStoragePort {
  put(accountId: string, mediaType: string, bytes: Uint8Array): Promise<string>;
  get(accountId: string, storageKey: string): Promise<Uint8Array>;
  delete(accountId: string, storageKey: string): Promise<void>;
}

export const PRIVATE_RECEIPT_STORAGE = Symbol('PRIVATE_RECEIPT_STORAGE');
