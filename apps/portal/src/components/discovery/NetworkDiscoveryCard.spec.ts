import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import NetworkDiscoveryCard from './NetworkDiscoveryCard.vue';

const device = { id: 'lan-host', hostname: 'kitchen.local', ipAddress: '192.168.1.20', vendor: 'Shelly', model: 'Plus 1', protocol: 'http', networkZoneName: 'Home', networkZoneId: 'home', status: 'online', reason: 'HTTP response', settingsUrl: 'http://192.168.1.20' };
const props = { device, badge: 'gateway ready', badgeClass: 'approved', hasSsh: true, hasChannels: true, proxyUrl: '/portal/device-proxy/lan-host' };

describe('network discovery card', () => {
  it('keeps identity and connectivity visible with secondary details initially collapsed', () => {
    const card = mount(NetworkDiscoveryCard, { props });
    expect(card.get('article').attributes('aria-label')).toContain(device.ipAddress);
    expect(card.get('.network-device-identity').text()).toContain(device.hostname);
    expect(card.get('.connectivity').text()).toBe('online');
    expect(card.get('.network-device-inspect button').classes()).toContain('primary');
    expect(card.get('details').attributes('open')).toBeUndefined();
    expect(card.get('summary').attributes('aria-label')).toContain(device.ipAddress);
    card.unmount();
  });

  it('forwards every action separately and preserves link destinations', async () => {
    const card = mount(NetworkDiscoveryCard, { props });
    const click = async (text: string) => card.findAll('button').find(b => b.text() === text)!.trigger('click');
    await click('Review intelligence');
    expect(card.emitted('review')).toHaveLength(1);
    expect(card.emitted('investigate')).toBeUndefined();
    await click('Investigate with AI');
    await click('Review channels');
    await click('Copy SSH');
    for (const event of ['investigate', 'channels', 'copySsh']) expect(card.emitted(event)).toHaveLength(1);
    expect(card.findAll('a').map(a => a.attributes('href'))).toEqual(['ssh://192.168.1.20', 'http://192.168.1.20', '/portal/device-proxy/lan-host']);
    card.unmount();
  });

  it('retains unavailable-action states and disables repeat AI investigation', () => {
    const card = mount(NetworkDiscoveryCard, { props: { ...props, hasSsh: false, hasChannels: false, proxyUrl: undefined, investigating: true } });
    expect(card.text()).toContain('Channels unavailable');
    expect(card.text()).not.toContain('Copy SSH');
    expect(card.findAll('button').find(b => b.text() === 'Investigating…')!.attributes('disabled')).toBeDefined();
    expect(card.findAll('a')).toHaveLength(1);
    card.unmount();
  });

  it('makes conflicting MAC evidence visible without presenting it as a verified identity', () => {
    const card = mount(NetworkDiscoveryCard, {
      props: {
        ...props,
        device: {
          ...device,
          identityConflict: {
            reason: 'multiple_macs_for_endpoint',
            macAddresses: ['00:11:22:33:44:55', '3c:71:bf:32:54:b7'],
          },
        },
      },
    });

    expect(card.text()).toContain('Multiple MAC addresses were observed');
    expect(card.text()).toContain('00:11:22:33:44:55, 3c:71:bf:32:54:b7');
    card.unmount();
  });

  it('closes secondary actions with Escape and returns focus to their disclosure', async () => {
    const card = mount(NetworkDiscoveryCard, { props, attachTo: document.body });
    (card.get('details').element as HTMLDetailsElement).open = true;
    await card.get('details').trigger('keydown', { key: 'Escape' });
    expect((card.get('details').element as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(card.get('summary').element);
    card.unmount();
  });
});
