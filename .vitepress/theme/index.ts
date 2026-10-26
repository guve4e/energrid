import DefaultTheme from 'vitepress/theme';
import { nextTick } from 'vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return;

    let mermaidPromise: Promise<typeof import('mermaid').default> | undefined;
    const renderDiagrams = async () => {
      await nextTick();
      const diagrams = document.querySelectorAll(
        '.vp-doc pre.mermaid:not([data-processed])',
      );
      if (diagrams.length > 0) {
        mermaidPromise ??= import('mermaid').then(({ default: engine }) => {
          engine.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
          });
          return engine;
        });
        const engine = await mermaidPromise;
        await engine.run({ nodes: Array.from(diagrams) });
      }
    };

    router.onAfterRouteChanged(() => void renderDiagrams());
    void renderDiagrams();
  },
};
