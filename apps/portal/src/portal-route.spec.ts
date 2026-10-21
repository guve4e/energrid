import { describe, expect, it } from 'vitest';
import { pageFromPath, pathForPage } from './portal-route';

describe('portal route helpers', () => {
  it.each([
    ['/', 'assistant'],
    ['/weather', 'weather'],
    ['/weather/', 'weather'],
    ['/energy/', 'energy'],
    ['/devices/shelly', 'devices'],
    ['/network-intelligence/', 'network-intelligence'],
    ['/not-a-page', 'assistant'],
  ])('maps %s to %s', (path, page) => {
    expect(pageFromPath(path)).toBe(page);
  });

  it('creates stable shareable paths for portal pages', () => {
    expect(pathForPage('assistant')).toBe('/');
    expect(pathForPage('weather')).toBe('/weather/');
    expect(pathForPage('energy')).toBe('/energy/');
    expect(pathForPage('logs')).toBe('/logs/');
    expect(pathForPage('network-intelligence')).toBe('/network-intelligence/');
  });
});
