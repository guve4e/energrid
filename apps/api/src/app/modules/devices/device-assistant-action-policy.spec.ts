import {
  authorizeInstantLightingAction,
  type AssistantActionDevice,
} from './device-assistant-action-policy';

const scope = { tenantId: 'home', siteId: 'house' };

function device(): AssistantActionDevice {
  return {
    id: 'kitchen-ceiling',
    tenantId: 'home',
    siteId: 'house',
    kind: 'physical',
    trustStatus: 'approved',
    assistantEnabled: true,
    metadata: { loadType: 'lighting' },
    capabilities: [{ kind: 'switch' }],
    control: { binding: { enabled: true } },
  };
}

const allowlist = new Set(['kitchen-ceiling']);

function authorize(
  candidate = device(),
  action = 'turn_on',
  enrolled = true,
  ids: ReadonlySet<string> = allowlist,
) {
  return authorizeInstantLightingAction(
    scope, candidate, action, enrolled, ids,
  );
}

describe('Instant assistant lighting authorization', () => {
  it('allows approved lighting without confirmation', () => {
    expect(authorize()).toEqual({
      allowed: true,
      confirmation: 'none',
    });
  });

  it('allows turning an approved light off', () => {
    expect(authorize(device(), 'turn_off').allowed).toBe(true);
  });

  it('rejects unsupported actions', () => {
    expect(authorize(device(), 'set_temperature').allowed).toBe(false);
  });

  it('rejects devices outside the authorized site', () => {
    expect(authorize({
      ...device(), siteId: 'other-house',
    }).allowed).toBe(false);
  });

  it('rejects unenrolled devices', () => {
    expect(authorize(device(), 'turn_on', false).allowed).toBe(false);
  });

  it('rejects assistant-disabled devices', () => {
    expect(authorize({
      ...device(), assistantEnabled: false,
    }).allowed).toBe(false);
  });

  it('rejects devices without approved lighting purpose', () => {
    expect(authorize({
      ...device(), metadata: { loadType: 'heating' },
    }).allowed).toBe(false);
  });

  it('rejects disabled control routes', () => {
    expect(authorize({
      ...device(), control: { binding: { enabled: false } },
    }).allowed).toBe(false);
  });

  it('rejects devices without explicit instant-control opt-in', () => {
    expect(authorize(
      device(), 'turn_on', true, new Set(),
    ).allowed).toBe(false);
  });
});
