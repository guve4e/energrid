import { refreshLocalNeighborIdentity } from './targeted-neighbor-identity.adapter';

describe('refreshLocalNeighborIdentity', () => {
  it('requires a direct route and issues an ARP ping for exactly the selected endpoint on Linux', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: '192.168.7.48 dev en0 src 192.168.7.20 uid 501' })
      .mockResolvedValueOnce({ stdout: '<nmaprun><host><status state="up"/><address addr="192.168.7.48" addrtype="ipv4"/><address addr="3c:71:bf:32:4b:44" addrtype="mac"/></host></nmaprun>' });

    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'linux', run)).resolves.toEqual({
      reachable: true,
      macAddress: '3c:71:bf:32:4b:44',
      interfaceName: 'en0',
    });
    expect(run).toHaveBeenNthCalledWith(1, 'ip', ['-4', 'route', 'get', '192.168.7.48'], expect.objectContaining({ timeout: 1000 }));
    expect(run).toHaveBeenNthCalledWith(2, 'nmap', ['-sn', '-PR', '-n', '-e', 'en0', '-oX', '-', '192.168.7.48'], expect.objectContaining({ timeout: 5000 }));
  });

  it('rejects a routed target on Linux without sending an ARP probe', async () => {
    const run = jest.fn().mockResolvedValue({ stdout: '192.168.7.48 via 192.168.7.1 dev en0 src 192.168.7.20' });

    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'linux', run)).resolves.toEqual({ reachable: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('supports directly connected macOS routes and rejects gateway routes', async () => {
    const direct = jest.fn()
      .mockResolvedValueOnce({ stdout: 'interface: en0\nflags: <UP,DONE,LLINFO>' })
      .mockResolvedValueOnce({ stdout: '<nmaprun><host><status state="up"/><address addr="192.168.7.48" addrtype="ipv4"/><address addr="3c:71:bf:32:4b:44" addrtype="mac"/></host></nmaprun>' });
    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'darwin', direct)).resolves.toMatchObject({ reachable: true, interfaceName: 'en0' });
    expect(direct).toHaveBeenNthCalledWith(1, 'route', ['-n', 'get', '192.168.7.48'], expect.any(Object));

    const routed = jest.fn().mockResolvedValue({ stdout: 'interface: en0\ngateway: 192.168.7.1' });
    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'darwin', routed)).resolves.toEqual({ reachable: false });
    expect(routed).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an up host without a MAC response for verified identity evidence', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: '192.168.7.48 dev en0 src 192.168.7.20' })
      .mockResolvedValueOnce({ stdout: '<nmaprun><host><status state="up"/><address addr="192.168.7.48" addrtype="ipv4"/></host></nmaprun>' });

    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'linux', run)).resolves.toEqual({
      reachable: true,
      interfaceName: 'en0',
    });
  });

  it('rejects malformed Nmap output, unsupported platforms, and invalid addresses', async () => {
    const malformed = jest.fn()
      .mockResolvedValueOnce({ stdout: '192.168.7.48 dev en0 src 192.168.7.20' })
      .mockResolvedValueOnce({ stdout: '<not-xml' });
    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'linux', malformed)).resolves.toEqual({ reachable: false });

    const unsupported = jest.fn();
    await expect(refreshLocalNeighborIdentity('192.168.7.48', 'win32', unsupported)).resolves.toEqual({ reachable: false });
    await expect(refreshLocalNeighborIdentity('192.168.7.999', 'linux', unsupported)).resolves.toEqual({ reachable: false });
    expect(unsupported).not.toHaveBeenCalled();
  });
});
