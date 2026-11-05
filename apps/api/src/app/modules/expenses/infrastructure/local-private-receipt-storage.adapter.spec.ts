import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrivateReceiptStorageAdapter } from './local-private-receipt-storage.adapter';

describe('LocalPrivateReceiptStorageAdapter', () => {
  const accountA = '11111111-1111-4111-8111-111111111111';
  const accountB = '22222222-2222-4222-8222-222222222222';
  let root: string;
  let previousRoot: string | undefined;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'finance-receipts-')); previousRoot = process.env.PERSONAL_FINANCE_RECEIPTS_DIR; process.env.PERSONAL_FINANCE_RECEIPTS_DIR = root; });
  afterEach(async () => { if (previousRoot === undefined) delete process.env.PERSONAL_FINANCE_RECEIPTS_DIR; else process.env.PERSONAL_FINANCE_RECEIPTS_DIR = previousRoot; await rm(root, { recursive: true, force: true }); });

  it('writes private account-scoped files and refuses cross-account reads', async () => {
    const storage = new LocalPrivateReceiptStorageAdapter();
    const content = new Uint8Array([1, 2, 3]);
    const key = await storage.put(accountA, 'image/jpeg', content);
    expect(await storage.get(accountA, key)).toEqual(content);
    await expect(storage.get(accountB, key)).rejects.toThrow();
    const permissions = (await stat(join(root, accountA, key.split('/')[1]))).mode & 0o777;
    expect(permissions).toBe(0o600);
    expect((await stat(join(root, accountA))).mode & 0o777).toBe(0o700);
    await storage.delete(accountA, key);
    await expect(storage.get(accountA, key)).rejects.toThrow();
  });

  it('accepts repeated deletion when the file or directories are missing', async () => {
    const storage = new LocalPrivateReceiptStorageAdapter();
    const key = await storage.put(accountA, 'image/png', new Uint8Array([1]));
    await storage.delete(accountA, key);
    await expect(storage.delete(accountA, key)).resolves.toBeUndefined();

    await rm(join(root, accountA), { recursive: true, force: true });
    await expect(storage.delete(accountA, key)).resolves.toBeUndefined();

    await rm(root, { recursive: true, force: true });
    await expect(storage.delete(accountA, key)).resolves.toBeUndefined();
  });

  it('rejects cross-account and invalid keys even when the file is absent', async () => {
    const storage = new LocalPrivateReceiptStorageAdapter();
    const key = await storage.put(accountA, 'image/jpeg', new Uint8Array([1]));
    await storage.delete(accountA, key);

    await expect(storage.delete(accountB, key)).rejects.toThrow('Receipt does not belong to this account');
    await expect(storage.delete(accountA, `${accountA}/../outside.jpg`)).rejects.toThrow('Receipt does not belong to this account');
  });

  it('refuses to delete symlinks', async () => {
    const storage = new LocalPrivateReceiptStorageAdapter();
    const key = await storage.put(accountA, 'image/jpeg', new Uint8Array([1]));
    const external = join(root, 'other-file.jpg');

    await writeFile(external, 'keep');
    await unlink(join(root, accountA, key.split('/')[1]));
    await symlink(external, join(root, accountA, key.split('/')[1]));

    await expect(storage.delete(accountA, key)).rejects.toThrow('not a regular private file');
    expect(await readFile(external, 'utf8')).toBe('keep');
  });

  it('propagates filesystem errors other than ENOENT', async () => {
    const storage = new LocalPrivateReceiptStorageAdapter();
    const key = await storage.put(accountA, 'image/jpeg', new Uint8Array([1]));

    await rm(join(root, accountA), { recursive: true, force: true });
    await writeFile(join(root, accountA), 'not a directory');

    await expect(storage.delete(accountA, key)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
