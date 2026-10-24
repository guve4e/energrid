import {
  EnergridHttpIdentityAdapter,
  parseEnergridIdentity,
  type EnergridIdentityTransport,
} from './energrid-http-identity.adapter';

const validPayload = {
  schemaVersion: 1,
  id: 'esp8266:324864',
  model: 'Energrid ESP8266 DHT22',
  firmwareVersion: '0.2.0',
  capabilities: ['temperature', 'humidity'],
};

describe('EnergridHttpIdentityAdapter', () => {
  it('accepts only the expected stable identity and read-only sensor capabilities', () => {
    expect(parseEnergridIdentity(validPayload)).toEqual({
      id: 'esp8266:324864',
      model: 'Energrid ESP8266 DHT22',
      firmwareVersion: '0.2.0',
      capabilities: ['temperature', 'humidity'],
    });
    expect(parseEnergridIdentity({ ...validPayload, id: '192.168.1.198' })).toBeNull();
    expect(parseEnergridIdentity({ ...validPayload, capabilities: ['control'] })).toBeNull();
    expect(parseEnergridIdentity({ ...validPayload, schemaVersion: 2 })).toBeNull();
  });

  it('reads only private IPv4 hosts with the adapter response bounds', async () => {
    const transport: EnergridIdentityTransport = { get: jest.fn().mockResolvedValue(validPayload) };
    const adapter = new EnergridHttpIdentityAdapter(transport);

    await expect(adapter.identify('192.168.1.198')).resolves.toMatchObject({ id: 'esp8266:324864' });
    expect(transport.get).toHaveBeenCalledWith('192.168.1.198', 2_000, 4_096);
    await expect(adapter.identify('203.0.113.10')).resolves.toBeNull();
    expect(transport.get).toHaveBeenCalledTimes(1);
  });

  it('treats invalid or unavailable endpoint responses as unidentified hosts', async () => {
    const transport: EnergridIdentityTransport = { get: jest.fn().mockResolvedValue({ ...validPayload, id: 'wrong' }) };
    const adapter = new EnergridHttpIdentityAdapter(transport);
    await expect(adapter.identify('192.168.1.198')).resolves.toBeNull();
    jest.mocked(transport.get).mockRejectedValueOnce(new Error('timeout'));
    await expect(adapter.identify('192.168.1.198')).resolves.toBeNull();
  });
});
