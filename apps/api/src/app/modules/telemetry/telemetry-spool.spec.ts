import { testReading, testSpool } from './telemetry-test.fixture';

describe('local durable outbox policies', () => {
  it('is lazy and uses one exclusive database open for concurrent operations', async () => {
    const { spool, factory, db } = testSpool();
    expect(factory).not.toHaveBeenCalled();
    expect(spool.status().pending).toBeNull();
    await Promise.all([spool.open(), spool.open()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(db.open).toHaveBeenCalledTimes(1);
    await spool.close();
    expect(db.close).toHaveBeenCalledTimes(1);
    await expect(spool.open()).rejects.toThrow('closed');
  });
  it('commits a whole message and metadata atomically with fsync, in stable FIFO order', async () => {
    const { spool, db, data } = testSpool();
    await Promise.all([
      spool.enqueue([testReading({ value: 1 }), testReading({ value: 2 })]),
      spool.enqueue([testReading({ value: 3 })]),
    ]);
    expect(spool.status().pending).toBe(3);
    expect(db.batch.mock.calls).toHaveLength(3);
    expect((db.batch.mock.calls as unknown[][])[1][1]).toEqual({ sync: true });
    expect((db.batch.mock.calls as unknown[][])[1][0]).toHaveLength(3);
    expect((await spool.peek())!.value).toEqual(testReading({ value: 1 }));
    await spool.finish((await spool.peek())!);
    expect((await spool.peek())!.value).toEqual(testReading({ value: 2 }));
    expect(data.get('metadata')).toEqual({
      version: 1,
      pending: 2,
      next: 3,
      quarantined: 0,
    });
  });
  it('restores counts and monotonically increasing IDs on reopen', async () => {
    const first = testSpool();
    await first.spool.enqueue([testReading()]);
    await first.spool.close();
    const next = testSpool(100_000, true, first.data);
    await next.spool.enqueue([testReading()]);
    expect([...first.data.keys()]).toEqual(
      expect.arrayContaining(['p:0000000000000000', 'p:0000000000000001']),
    );
    expect(next.spool.status().pending).toBe(2);
  });
  it('preserves quarantined data and counts it against the capacity', async () => {
    const { spool, data } = testSpool(1);
    await spool.enqueue([testReading()]);
    const entry = (await spool.peek())!;
    await spool.finish(entry, 'conflicting-reading');
    expect(data.get('q:0000000000000000')).toEqual({
      reason: 'conflicting-reading',
      reading: testReading(),
    });
    expect(await spool.peek()).toBeUndefined();
    await expect(spool.enqueue([testReading()])).rejects.toThrow();
    expect(spool.status().quarantined).toBe(1);
  });
  it('rejects overflow atomically and can accept again after draining', async () => {
    const { spool } = testSpool(2);
    await spool.enqueue([testReading()]);
    await expect(
      spool.enqueue([testReading(), testReading()]),
    ).rejects.toThrow();
    expect(spool.status().pending).toBe(1);
    await spool.finish((await spool.peek())!);
    await spool.enqueue([testReading(), testReading()]);
    expect(spool.status().pending).toBe(2);
  });
  it.each(
    [
      [],
      Array(33).fill(testReading()),
      [testReading(), testReading({ value: NaN })],
    ].map((readings) => [readings]),
  )('validates the entire bounded batch before writing', async (readings) => {
    const { spool, db } = testSpool();
    await expect(spool.enqueue(readings)).rejects.toThrow();
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(spool.status().pending).toBe(0);
  });
  it('fails closed after an uncertain disk write, never reusing stale sequence numbers', async () => {
    const { spool, db } = testSpool();
    await spool.open();
    db.batch.mockRejectedValueOnce(new Error('secret-directory disk full'));
    await expect(spool.enqueue([testReading()])).rejects.toThrow(
      'spool operation failed',
    );
    await expect(spool.enqueue([testReading()])).rejects.toThrow();
    expect(db.batch).toHaveBeenCalledTimes(2);
    expect(spool.status().state).toBe('blocked');
    await spool.close();
  });
  it('reports lock/open failures without leaking paths and still allows cleanup', async () => {
    const { spool, db } = testSpool();
    db.open.mockRejectedValueOnce(new Error('private path LEVEL_LOCKED'));
    await expect(spool.open()).rejects.toThrow('exclusive ownership');
    await spool.close();
    expect(db.close).toHaveBeenCalled();
  });

  it('recovers an uncertain successful disk commit without overwriting its readings', async () => {
    const first = testSpool();
    await first.spool.open();
    const batch = first.db.batch.getMockImplementation()!;
    first.db.batch.mockImplementationOnce(async (operations) => {
      await batch(operations);
      throw new Error('Uncertain fsync result');
    });
    await expect(
      first.spool.enqueue([testReading({ value: 11 })]),
    ).rejects.toThrow();
    expect(first.spool.status().restartRequired).toBe(true);
    await expect(
      first.spool.enqueue([testReading({ value: 22 })]),
    ).rejects.toThrow();
    await first.spool.close();
    const next = testSpool(100_000, true, first.data);
    await next.spool.enqueue([testReading({ value: 22 })]);
    expect(next.spool.status().pending).toBe(2);
    expect((await next.spool.peek())!.value).toEqual(
      testReading({ value: 11 }),
    );
    await next.spool.finish((await next.spool.peek())!);
    expect((await next.spool.peek())!.value).toEqual(
      testReading({ value: 22 }),
    );
  });
  it.each([
    null,
    {},
    { version: 2 },
    { version: 1, next: 0, pending: 1, quarantined: 0 },
    { version: 1, next: -1, pending: 0, quarantined: 0 },
  ])('rejects invalid metadata %j without overwriting it', async (metadata) => {
    const { spool, data, db } = testSpool(
      100,
      true,
      new Map([['metadata', metadata]]),
    );
    await expect(spool.open()).rejects.toThrow();
    expect(db.batch).not.toHaveBeenCalled();
    expect(data.get('metadata')).toEqual(metadata);
    await spool.close();
  });
  it('does not initialize over orphaned data or exhausted sequence numbers', async () => {
    const orphan = testSpool(
      100,
      true,
      new Map([['p:0000000000000000', testReading()]]),
    );
    await expect(orphan.spool.open()).rejects.toThrow();
    const exhausted = testSpool(
      100,
      true,
      new Map([
        [
          'metadata',
          {
            version: 1,
            next: Number.MAX_SAFE_INTEGER,
            pending: 0,
            quarantined: 0,
          },
        ],
      ]),
    );
    await expect(exhausted.spool.enqueue([testReading()])).rejects.toThrow();
  });
  it('detects missing pending data and cannot finish arbitrary/nonexistent entries', async () => {
    const { spool, data } = testSpool();
    await spool.enqueue([testReading()]);
    await expect(
      spool.finish({ key: 'metadata', value: {} }),
    ).rejects.toThrow();
    await expect(
      spool.finish({ key: 'p:0000000000009999', value: {} }),
    ).rejects.toThrow();
    data.delete('p:0000000000000000');
    await expect(spool.peek()).rejects.toThrow();
  });
  it('does not consume unaccounted pending entries or fabricate negative counts', async () => {
    const { spool, data } = testSpool();
    await spool.open();
    data.set('p:0000000000000000', testReading());
    await expect(spool.peek()).rejects.toThrow();
    expect(data.has('p:0000000000000000')).toBe(true);
  });
  it('does not open any files when recording is disabled', async () => {
    const { spool, factory } = testSpool(1, false);
    await spool.open();
    await spool.close();
    expect(factory).not.toHaveBeenCalled();
    expect(spool.status().state).toBe('disabled');
    expect(spool.status().pending).toBeNull();
  });
});
