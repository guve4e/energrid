import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  InteractionScope,
  InteractionTraceRecord,
  InteractionTraceStore,
} from './interaction-trace';

const FILE_PATTERN = /^\d{13}-[a-f0-9-]{36}\.json$/;

export class FileInteractionTraceStore implements InteractionTraceStore {
  constructor(
    private readonly root = process.env.HOME_INTERACTION_TRACE_DIRECTORY ||
      join(homedir(), '.energrid', 'interaction-traces'),
    private readonly maxRecordsPerSite = 300,
  ) {}

  private directory(scope: InteractionScope): string {
    const scopedKey = createHash('sha256')
      .update(JSON.stringify([scope.tenantId, scope.siteId]))
      .digest('hex')
      .slice(0, 24);

    return join(this.root, scopedKey);
  }

  async save(trace: InteractionTraceRecord): Promise<void> {
    const directory = this.directory(trace.scope);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const filename = `${Date.now()}-${trace.traceId}.json`;
    const finalPath = join(directory, filename);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(trace),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    const files = (await readdir(directory))
      .filter(name => FILE_PATTERN.test(name))
      .sort()
      .reverse();

    for (const oldFile of files.slice(
      Math.max(1, this.maxRecordsPerSite),
    )) {
      await unlink(join(directory, oldFile)).catch(() => undefined);
    }
  }

  async list(
    scope: InteractionScope,
    limit = 50,
  ): Promise<InteractionTraceRecord[]> {
    const directory = this.directory(scope);
    const files = await readdir(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      },
    );

    const selected = files
      .filter(name => FILE_PATTERN.test(name))
      .sort()
      .reverse()
      .slice(0, Math.max(0, Math.min(limit, 100)));

    return Promise.all(
      selected.map(async name => {
        const content = await readFile(join(directory, name), 'utf8');
        return JSON.parse(content) as InteractionTraceRecord;
      }),
    );
  }
}
