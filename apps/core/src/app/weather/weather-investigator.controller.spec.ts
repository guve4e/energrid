import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { WeatherInvestigatorController } from './weather-investigator.controller';

describe('weather investigator controller', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
    jest.restoreAllMocks();
  });

  it('requires the server-to-server token before returning site scoped data', async () => {
    process.env = {
      ...original,
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = { list: jest.fn().mockResolvedValue([]) };
    const controller = new WeatherInvestigatorController(investigator as never);
    expect(() => controller.findings(undefined, 'site-a', 'tenant-a')).toThrow(
      UnauthorizedException,
    );
    expect(investigator.list).not.toHaveBeenCalled();
    expect(
      await controller.findings('Bearer token', 'site-a', 'tenant-a'),
    ).toEqual([]);
    expect(investigator.list).toHaveBeenCalledWith('site-a', 'tenant-a');
  });

  it('restricts the manual run action to LAB mode', async () => {
    process.env = {
      ...original,
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      ENERGRID_LAB_MODE: 'false',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = { run: jest.fn() };
    const controller = new WeatherInvestigatorController(investigator as never);
    await expect(
      controller.run('Bearer token', {
        siteId: 'site-a',
        tenantId: 'tenant-a',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(investigator.run).not.toHaveBeenCalled();
    process.env.ENERGRID_LAB_MODE = 'true';
    investigator.run.mockResolvedValue({ status: 'completed' });
    await expect(
      controller.run('Bearer token', {
        siteId: 'site-a',
        tenantId: 'tenant-a',
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(investigator.run).toHaveBeenCalledWith('site-a', 'tenant-a');
  });
  it('enforces authentication and explicit scope on the read-only weather model', async () => {
    process.env = {
      ...original,
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = { readModel: jest.fn().mockResolvedValue({ version: 1 }) };
    const controller = new WeatherInvestigatorController(investigator as never);
    expect(() => controller.readModel(undefined, 'site-a', 'tenant-a')).toThrow(UnauthorizedException);
    expect(() => controller.readModel('Bearer token', undefined, 'tenant-a')).toThrow(BadRequestException);
    expect(() => controller.readModel('Bearer token', 'site-a', '../../tenant')).toThrow(BadRequestException);
    await expect(controller.readModel('Bearer token', 'site-a', 'tenant-a'))
      .resolves.toEqual({ version: 1 });
    expect(investigator.readModel).toHaveBeenCalledWith('site-a', 'tenant-a');
  });

  it('rejects cross-site access for every investigator endpoint', async () => {
    process.env = {
      ...original,
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = {
      list: jest.fn(), context: jest.fn(), readModel: jest.fn(),
      run: jest.fn(), acknowledge: jest.fn(),
    };
    const controller = new WeatherInvestigatorController(investigator as never);
    expect(() => controller.findings('Bearer token', 'site-b', 'tenant-a')).toThrow(ForbiddenException);
    expect(() => controller.context('Bearer token', 'site-a', 'tenant-b')).toThrow(ForbiddenException);
    expect(() => controller.readModel('Bearer token', 'site-b', 'tenant-a')).toThrow(ForbiddenException);
    await expect(controller.run('Bearer token', { siteId: 'site-b', tenantId: 'tenant-a' }))
      .rejects.toThrow(ForbiddenException);
    expect(() => controller.acknowledge('Bearer token', '42', {
      action: 'acknowledged', siteId: 'site-a', tenantId: 'tenant-b',
    })).toThrow(ForbiddenException);
    for (const fn of Object.values(investigator)) expect(fn).not.toHaveBeenCalled();
  });

  it('requires explicit scope and configured LAB binding for every read', () => {
    process.env = {
      ...original,
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = { list: jest.fn(), context: jest.fn(), readModel: jest.fn() };
    const controller = new WeatherInvestigatorController(investigator as never);
    expect(() => controller.findings('Bearer token', undefined, 'tenant-a')).toThrow(BadRequestException);
    expect(() => controller.context('Bearer token', 'site-a', undefined)).toThrow(BadRequestException);
    delete process.env.WEATHER_INVESTIGATOR_TENANT_ID;
    expect(() => controller.readModel('Bearer token', 'site-a', 'tenant-a'))
      .toThrow(ServiceUnavailableException);
    expect(investigator.list).not.toHaveBeenCalled();
    expect(investigator.context).not.toHaveBeenCalled();
    expect(investigator.readModel).not.toHaveBeenCalled();
  });

  it('allows explicitly scoped LAB reads and acknowledge with matching credentials', async () => {
    process.env = {
      ...original,
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_API_TOKEN: 'token',
      WEATHER_INVESTIGATOR_SITE_ID: 'site-a',
      WEATHER_INVESTIGATOR_TENANT_ID: 'tenant-a',
    };
    const investigator = {
      context: jest.fn().mockResolvedValue({ siteId: 'site-a' }),
      acknowledge: jest.fn().mockResolvedValue({ status: 'acknowledged' }),
    };
    const controller = new WeatherInvestigatorController(investigator as never);
    await expect(controller.context('Bearer token', 'site-a', 'tenant-a')).resolves.toEqual({ siteId: 'site-a' });
    await expect(controller.acknowledge('Bearer token', '42', {
      action: 'acknowledged', siteId: 'site-a', tenantId: 'tenant-a',
    })).resolves.toEqual({ status: 'acknowledged' });
    expect(investigator.acknowledge).toHaveBeenCalledWith('42', 'acknowledged', 'site-a', 'tenant-a');
  });

});
