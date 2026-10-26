import { defineConfig } from 'vitepress';

const handbook = [
  { text: 'Start here', items: [
    { text: 'Handbook index', link: '/docs/index' },
    { text: 'Architecture overview', link: '/docs/architecture-overview' },
    { text: 'Device model and lifecycle', link: '/docs/device-model-lifecycle' },
    { text: 'Observation and identity flows', link: '/docs/observation-pipelines' },
    { text: 'Commands, authorization and audit', link: '/docs/commands-and-authority' },
    { text: 'Persistence map', link: '/docs/persistence' },
    { text: 'Operations and deployment', link: '/docs/operations' },
    { text: 'Device Lab integration', link: '/docs/device-lab-integration' },
    { text: 'Audit and remaining gaps', link: '/docs/audit-and-gaps' },
  ] },
  { text: 'Devices and operations', items: [
    { text: 'Device control', link: '/docs/device-control' },
    { text: 'Device Health history V1', link: '/docs/device-health-history' },
    { text: 'Installation Passport', link: '/docs/installation-passport' },
    { text: 'Site gateway bootstrap', link: '/docs/site-gateway-bootstrap' },
    { text: 'HTTP observation ingestion', link: '/docs/energrid-http-observation-ingestion' },
    { text: 'Residential pilot', link: '/docs/residential-pilot' },
    { text: 'Portal authentication', link: '/docs/portal-authentication' },
    { text: 'Deployment procedures', link: '/docs/portal-cloudflare-pi-deploy' },
    { text: 'API docs and OpenAPI', link: '/docs/api-docs' },
  ] },
  { text: 'Energy, estimator and voice', items: [
    { text: 'Electrical telemetry', link: '/docs/electrical-telemetry' },
    { text: 'Legacy power history', link: '/docs/legacy-power-history' },
    { text: 'Local estimator testing', link: '/docs/local-estimator-testing' },
    { text: 'Estimator revision', link: '/docs/estimator-revision' },
    { text: 'Estimator assistant integration', link: '/docs/estimator-assistant-integration' },
    { text: 'Forecast verification', link: '/docs/forecast-verification' },
    { text: 'Weather Investigator V1', link: '/docs/M3-weather-investigator-v1' },
    { text: 'Voice local STT', link: '/docs/voice-local-stt' },
    { text: 'Voice deployment', link: '/docs/voice-pi-browser-deploy' },
    { text: 'Conversation testing', link: '/docs/conversation-testing' },
    { text: 'Conversation refactor review', link: '/docs/conversation-refactor-review' },
  ] },
];

export default defineConfig({
  title: 'Energrid Engineering Handbook',
  description: 'Architecture, operations and integration documentation for Energrid.',
  cleanUrls: true,
  srcExclude: ['AGENTS.md'],
  markdown: {
    config(md) {
      const renderFence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() === 'mermaid') {
          return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
        }
        return renderFence
          ? renderFence(tokens, index, options, env, self)
          : self.renderToken(tokens, index, options);
      };
    },
  },
  themeConfig: {
    siteTitle: 'Energrid Handbook',
    nav: [
      { text: 'Handbook', link: '/docs/index' },
      { text: 'API docs', link: '/docs/api-docs' },
    ],
    sidebar: { '/': handbook },
    search: { provider: 'local' },
    socialLinks: [],
    outline: { level: [2, 3] },
  },
});
