import { normalizedOrigin } from '../../scripts/jsb.react-browser/src/protocol.js';
import { WORKER_PROTOCOL, isWorkerEnvelope } from '../../scripts/jsb.react-browser/src/worker-protocol.js';
import { startWorkerPreviewHost } from '../../scripts/jsb.react-browser/src/worker-host.js';
import { assertCompiledRelease, type ReleaseContext } from './src/release-context';
import { verifyPreviewReleaseContext } from './src/preview-release-context';
import { suppressBrowserSave } from './src/browser-shortcuts';

suppressBrowserSave(window);
const configuredOrigin = new URL(location.href).searchParams.get('editorOrigin');
const editorOrigin = configuredOrigin ? normalizedOrigin(configuredOrigin) : undefined;
let connected = false;
let runtimeSnapshot: Readonly<Record<string, unknown>> | null = null;
Object.defineProperty(globalThis, '__playgroundRuntimeSession', { configurable: false, get: () => runtimeSnapshot });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && event.isTrusted && editorOrigin && parent !== window)
    parent.postMessage({ type: 'godotjs-preview-escape', protocolVersion: WORKER_PROTOCOL }, editorOrigin);
});
addEventListener('message', event => {
  const message = event.data;
  if (!editorOrigin || connected || event.origin !== editorOrigin || event.source !== parent || !isWorkerEnvelope(message) ||
      message.type !== 'connect' || message.editorOrigin !== editorOrigin || event.ports.length !== 1) return;
  connected = true;
  document.getElementById('connection-status')!.hidden = true;
  startWorkerPreviewHost(message, event.ports[0], {
    canvas: document.getElementById('canvas') as HTMLCanvasElement,
    async verifyRelease(release, manifest, signal) {
      const context = (release as typeof release & { releaseContext?: ReleaseContext }).releaseContext;
      if (!context?.candidateId) throw Error('E_WORKER_CANDIDATE_ID');
      if (context.engineReleaseId !== release.releaseId || context.engineProfile !== release.profile) throw Error('E_PREVIEW_RELEASE_CONTEXT');
      assertCompiledRelease(context, manifest);
      await verifyPreviewReleaseContext(context, { signal, release });
    },
    onSnapshot(snapshot) {
      runtimeSnapshot = snapshot;
      dispatchEvent(new CustomEvent('playground-runtime-session', { detail: snapshot }));
    },
  });
});
