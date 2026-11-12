/** Keep WebKit's compositor at the default framebuffer between engine loops.
 * Godot's renderer caches its bindings, so restore both targets before the
 * next loop instead of changing Emscripten's internal presentation restore. */
import {createHash} from 'node:crypto';

export const PRESENTATION_BOUNDARY_PATCH='godotjs-webkit-presentation-boundary-v1';
export const PRESENTATION_CONFIG_SHA256='de51f251ddc7938b64b126144f16a90e587a3a430766cf2e71920296b5535398';
const marker='GODOTJS_WEBKIT_PRESENTATION_BOUNDARY_V1';
const digest=source=>createHash('sha256').update(source).digest('hex');
const count=(source,value)=>source.split(value).length-1;
const replacements=[
 ['const InternalConfig = function (initConfig) { // eslint-disable-line no-unused-vars',String.raw`const InternalConfig = function (initConfig) { // eslint-disable-line no-unused-vars
	// GODOTJS_WEBKIT_PRESENTATION_BOUNDARY_V1
	let releasePresentation = null;`],
 [String.raw`		const gdext = this.gdextensionLibs;
		return {`,String.raw`		const gdext = this.gdextensionLibs;
		const cfg = this;
		if (releasePresentation) {
			releasePresentation();
			releasePresentation = null;
		}
		const ua = typeof navigator === 'object' ? String(navigator.userAgent || '') : '';
		const ios = /iPad|iPhone|iPod|CriOS\/|FxiOS\/|EdgiOS\//.test(ua)
			|| (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1);
		const webkitPresentation = /AppleWebKit\//.test(ua)
			&& (ios || !/(?:Chrome|Chromium|HeadlessChrome|Edg|OPR|Vivaldi|SamsungBrowser|YaBrowser)\//.test(ua));
		let pending = null;
		let presentationExited = false;
		let presentationOwner = null;
		const currentPresentationContext = function () {
			const context = cfg.canvas && cfg.canvas['GLctxObject'];
			if (presentationOwner && presentationOwner !== context) {
				// A different Engine may now own this canvas. Retire these hooks.
				presentationExited = true;
				pending = null;
				presentationOwner = null;
				return null;
			}
			const gl = context && context['GLctx'];
			if (!gl || typeof gl.isContextLost !== 'function' || gl.isContextLost()
					|| typeof gl.READ_FRAMEBUFFER !== 'number') {
				return null;
			}
			presentationOwner = context;
			return gl;
		};
		const restorePresentation = function () {
			const saved = pending;
			pending = null;
			if (presentationExited) {
				return;
			}
			const gl = currentPresentationContext();
			if (!saved) {
				return;
			}
			// A restored context may reuse its JS object but all old FBOs are invalid.
			if (saved.gl !== gl || (saved.read && !gl.isFramebuffer(saved.read))
					|| (saved.draw && !gl.isFramebuffer(saved.draw))) {
				return;
			}
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
		};
		const parkPresentation = function () {
			const gl = !presentationExited && currentPresentationContext();
			if (!gl) {
				pending = null;
				return;
			}
			// Preserve the owned renderer's bindings across presentation boundaries.
			// Public JavaScriptBridge callbacks may perform native resource/viewport
			// operations between frames; they require no new scheduling contract.
			// Host raw WebGL drawing must still respect engine context ownership.
			if (!pending || pending.gl !== gl) {
				pending = { gl: gl, read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) };
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		};
		if (webkitPresentation) {
			releasePresentation = function () {
				presentationExited = true;
				pending = null;
				presentationOwner = null;
			};
		}
		return {`],
 [String.raw`			'emscriptenPoolSize': this.emscriptenPoolSize,`,String.raw`			'emscriptenPoolSize': this.emscriptenPoolSize,
			'preMainLoop': webkitPresentation ? restorePresentation : undefined,
			'postMainLoop': webkitPresentation ? parkPresentation : undefined,`],
 [String.raw`		const onExit = this.onExit;`,String.raw`		const onExit = this.onExit;
		const endPresentation = releasePresentation;`],
 [String.raw`			'onExit': function (p_code) {
				cleanup();`,String.raw`			'onExit': function (p_code) {
				if (endPresentation) {
					endPresentation();
					if (releasePresentation === endPresentation) {
						releasePresentation = null;
					}
				}
				cleanup();`],
];

export function patchPresentationBoundary(source){
 if(typeof source!=='string')throw Error('E_PRESENTATION_PATCH_UNSUPPORTED: expected pinned Godot config.js');
 if(count(source,marker)===1){
  let original=source;
  for(const [before,after]of [...replacements].reverse()){
   if(count(original,after)!==1)throw Error('E_PRESENTATION_PATCH_UNSUPPORTED: changed or partial presentation patch');
   original=original.replace(after,before);
  }
  if(digest(original)!==PRESENTATION_CONFIG_SHA256)throw Error('E_PRESENTATION_PATCH_UNSUPPORTED: changed patched config.js');
  return {code:source,changed:false,patchId:PRESENTATION_BOUNDARY_PATCH};
 }
 if(count(source,marker)!==0||digest(source)!==PRESENTATION_CONFIG_SHA256)throw Error('E_PRESENTATION_PATCH_UNSUPPORTED: unknown config.js source');
 let code=source;
 for(const [before,after]of replacements){
  if(count(code,before)!==1)throw Error('E_PRESENTATION_PATCH_UNSUPPORTED: config.js anchor');
  code=code.replace(before,after);
 }
 return {code,changed:true,patchId:PRESENTATION_BOUNDARY_PATCH};
}
