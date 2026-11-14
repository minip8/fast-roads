// ============================================================================
// Startup failures: what the loading screen says when the game can't start
// ============================================================================
type StartupProblem = 'unsupported' | 'download' | 'physics';

export class StartupError extends Error {
  constructor(readonly problem: StartupProblem, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StartupError';
  }
}

const RETRY_HINT = ' Check your connection and try again.';

// The browser can't run the game at all: a reason to show, or null if it can.
export function unsupportedReason(): string | null {
  if (typeof WebAssembly !== 'object') return 'This browser doesn’t support WebAssembly, which the physics engine needs.';
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'WebGL 2 isn’t available. Turn on hardware acceleration, or try another browser.';
  gl.getExtension('WEBGL_lose_context')?.loseContext();   // only a probe; free it
  return null;
}

// Replace the loading text with what went wrong, plus a retry button when retrying can help.
export function showStartupError(err: unknown) {
  console.error(err);
  const problem = err instanceof StartupError ? err.problem : null;
  const detail = err instanceof Error ? err.message : String(err);
  const text =
    problem === 'unsupported' ? detail
    : problem === 'download' ? 'Couldn’t download the game.' + RETRY_HINT
    : problem === 'physics' ? 'Couldn’t load the physics engine.' + RETRY_HINT
    : /webgl/i.test(detail) ? 'Couldn’t start WebGL graphics (' + detail + '). Turn on hardware acceleration, or try another browser.'
    : 'Something went wrong while starting the game: ' + detail;
  const ls = document.getElementById('loadState');
  if (!ls) return;
  ls.hidden = false;
  ls.className = 'err';
  ls.textContent = text + ' ';
  if (problem === 'unsupported') return;
  const retry = document.createElement('button');
  retry.type = 'button'; retry.className = 'link'; retry.textContent = 'Try again';
  retry.addEventListener('click', () => location.reload());
  ls.append(retry);
  retry.focus();
}
