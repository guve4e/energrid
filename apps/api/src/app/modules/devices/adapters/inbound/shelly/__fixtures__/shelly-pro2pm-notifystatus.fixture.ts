/**
 * Sanitized fixture based on the accepted read-only Shelly Pro 2PM RPC and
 * observed NotifyStatus shape. Credentials and unrelated status fields are
 * intentionally omitted. The reported physical switch/energy values were 0.
 */
export const shellyPro2PmNotifyStatusFixture = {
  src: 'shellypro2pm-ec6260888084',
  method: 'NotifyStatus',
  params: {
    ts: 1793090040, // observed UTC timestamp; receipt time is assigned by Energrid
    'switch:0': {
      id: 0,
      output: false,
      apower: 0,
      aenergy: { total: 0 },
      ret_aenergy: { total: 0 },
    },
    'switch:1': {
      id: 1,
      output: false,
      apower: 0,
      aenergy: { total: 0 },
      ret_aenergy: { total: 0 },
    },
  },
};
