// ============================================================================
// Entry point. The page (with its "Loading physics…" text) is already painted; this small module checks the browser
// can run the game, then loads the game itself (three.js, Rapier) with a dynamic import, so a missing feature or a
// failed download ends in a message with a retry button instead of a page stuck on "Loading". The production build
// preloads those chunks from index.html, so the extra step costs no round trip (see vite.config.ts).
// ============================================================================
import { showStartupError, StartupError, unsupportedReason } from './startup';

// Offline support (see src/sw.js), registered once the page has loaded so it doesn't compete with the game download.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => { /* works without it */ }); });
}

const reason = unsupportedReason();
if (reason) showStartupError(new StartupError('unsupported', reason));
else {
  import('./main')
    .catch((err: unknown) => { throw new StartupError('download', 'game modules failed to load', { cause: err }); })
    .then(({ main }) => main())
    .catch(showStartupError);
}
