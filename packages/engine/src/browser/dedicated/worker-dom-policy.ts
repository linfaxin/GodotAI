/** One run owns at most sixteen mirrored elements, one pointer/fullscreen
 * lease, speech cancellation and one drop credit. Cleanup has its own bounded
 * transport lane; outstanding business commands never consume its credits. */
export const DOM_ELEMENT_LIMIT = 16;
export const DOM_CLEANUP_COMMAND_LIMIT = DOM_ELEMENT_LIMIT + 4;
export function isDomCleanupOperation(operation: string): boolean {
  return operation === 'remove' || operation === 'pointer-unlock' || operation === 'exit-fullscreen'
    || operation === 'tts-cancel' || operation === 'drop-release';
}
