import { UnauthorizedException } from '@nestjs/common';
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
});
