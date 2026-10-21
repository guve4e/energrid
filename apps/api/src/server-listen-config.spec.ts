import { apiListenHost } from './server-listen-config';

describe('apiListenHost', () => {
  it('uses an explicitly configured host such as loopback', () => {
    expect(apiListenHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('preserves the existing all-interface default when no host is configured', () => {
    expect(apiListenHost({})).toBe('0.0.0.0');
  });
});
