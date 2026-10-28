import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readFile, realpath, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrivateReceiptStoragePort } from '../application/ports/private-receipt-storage.port';

const extension = (mediaType: string) => mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/png' ? '.png' : null;

/** Private local-first storage. Keys are opaque, account-scoped relative paths, never URLs. */
export class LocalPrivateReceiptStorageAdapter implements PrivateReceiptStoragePort {
  private root() { return resolve(process.env.PERSONAL_FINANCE_RECEIPTS_DIR?.trim() || join(homedir(), '.energrid', 'private-receipts')); }

  async put(accountId: string, mediaType: string, bytes: Uint8Array): Promise<string> {
    const suffix = extension(mediaType);
    if (!suffix) throw new Error('Only JPEG and PNG receipt images are supported');
    const root = this.root();
    const segment = this.accountSegment(accountId);
    const accountDirectory = join(root, segment);
    await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(accountDirectory, 0o700);
    const safeRoot = await realpath(root);
    const safeDirectory = await realpath(accountDirectory);
    if (!safeDirectory.startsWith(`${safeRoot}${sep}`)) throw new ForbiddenException('Receipt storage path is invalid');
    const name = `${randomUUID()}${suffix}`;
    const handle = await open(join(safeDirectory, name), 'wx', 0o600);
    try { await handle.writeFile(Buffer.from(bytes)); } finally { await handle.close(); }
    return `${segment}/${name}`;
  }

  async get(accountId: string, storageKey: string): Promise<Uint8Array> {
    const file = await this.resolveOwnedFile(accountId, storageKey);
    try { return await readFile(file); } catch { throw new NotFoundException('Receipt file not found'); }
  }

  async delete(accountId: string, storageKey: string): Promise<void> {
    const file = await this.resolveOwnedFile(accountId, storageKey);
    try { await unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async resolveOwnedFile(accountId: string, storageKey: string) {
    const segment = this.accountSegment(accountId);
    const parts = storageKey.split('/');
    if (parts.length !== 2 || parts[0] !== segment || !/^[0-9a-f-]{36}\.(jpg|png)$/.test(parts[1])) throw new ForbiddenException('Receipt does not belong to this account');
    const directory = await realpath(join(this.root(), segment)).catch(() => { throw new NotFoundException('Receipt file not found'); });
    const expectedRoot = await realpath(this.root()).catch(() => { throw new NotFoundException('Receipt file not found'); });
    if (!directory.startsWith(`${expectedRoot}${sep}`)) throw new ForbiddenException('Receipt storage path is invalid');
    const file = join(directory, parts[1]);
    const info = await lstat(file).catch(() => { throw new NotFoundException('Receipt file not found'); });
    if (!info.isFile() || info.isSymbolicLink()) throw new ForbiddenException('Receipt file is not a regular private file');
    return file;
  }

  private accountSegment(value: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ForbiddenException('Verified finance account ID is invalid');
    return value.toLowerCase();
  }
}
