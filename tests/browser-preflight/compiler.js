// A classic Worker: esbuild-wasm itself runs here, with no nested Worker or Node shim.
const cdn = 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.12/';
const local = new URL(self.location.href).searchParams.has('local');
importScripts(local ? './assets/esbuild-browser.js' : cdn + 'lib/browser.min.js');
importScripts('https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js', './pck.js');
const initialized = esbuild.initialize({ wasmURL: local ? './assets/esbuild.wasm' : cdn + 'esbuild.wasm', worker: false });
const json = async path => { const response = await fetch(path); if (!response.ok) throw Error(`${response.status}: ${path}`); return response.json(); };
const inputs = Promise.all([import('./assets/contracts.mjs'), json('./assets/runtime.json'), json('./assets/bootstrap.json'), json('./assets/target.json')]);
// One pinned, single-file npm package probes CDN loading. This is not a general npm resolver.
const npmUrl = 'https://cdn.jsdelivr.net/npm/clsx@2.1.1/dist/clsx.mjs';
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

async function compile(source, options = {}) {
  await initialized;
  const [contracts, vendor, bootstrap, target] = await inputs;
  const generation = 'browser-' + crypto.randomUUID();
  const base = `res://.godot/GodotJS/react-build/${generation}`;
  const runtimeUri = `${base}/runtime/runtime.js`;
  const aliases = { react: 'React', 'react/jsx-runtime': 'jsxRuntime', 'react/jsx-dev-runtime': 'jsxDevRuntime', '@godot-js/react': 'sdk', '@godot-js/react/godot': 'godot', scheduler: 'scheduler', '@godot-js/react/contracts': 'contracts', '@godot-js/react/schema': 'schema', '@godot-js/react/native-interfaces': 'nativeInterfaces' };
  const files = { [runtimeUri]: vendor.code };
  const modules = { runtime: { uri: runtimeUri, sha256: await hash(vendor.code), dependencies: [], kind: 'vendor' } };
  const shims = {};
  for (const [specifier, member] of Object.entries(aliases)) {
    const id = `shim-${Object.keys(shims).length}`, uri = `${base}/runtime/${id}.js`;
    const code = `module.exports=require(${JSON.stringify(runtimeUri)}).${member};\n`;
    shims[specifier] = uri; files[uri] = code;
    modules[id] = { uri, sha256: await hash(code), dependencies: ['runtime'], kind: 'vendor' };
  }
  const fetched = [];
  const result = await esbuild.build({
    stdin: { contents: source, sourcefile: options.sourcefile ?? 'src/Counter.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'neutral', format: 'cjs', target: 'es2022',
    jsx: 'automatic', sourcemap: 'external', sourcesContent: true, outfile: '/entry.js', minify: options.minify === true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'canonical-sdk-only', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (shims[args.path]) return { path: shims[args.path], external: true };
        if (args.path === 'clsx') return { path: npmUrl, namespace: 'pinned-npm' };
        throw Error(`E_PREFLIGHT_IMPORT: this initial probe only supports the canonical SDK: ${args.path}`);
      });
      b.onLoad({ filter: /.*/, namespace: 'pinned-npm' }, async args => {
        const response = await fetch(args.path);
        if (!response.ok) throw Error(`E_NPM_FETCH: ${response.status} ${args.path}`);
        const contents = await response.text();
        fetched.push({ url: response.url, sha256: await hash(contents) });
        return { contents, loader: 'js' };
      });
    } }],
  });
  for (const output of result.outputFiles) files[`${base}/modules${output.path}`] = output.text;
  const appUri = `${base}/modules/entry.js`;
  const appMap = JSON.parse(files[appUri + '.map']);
  appMap.sourceRoot = '';
  appMap.sources = appMap.sources.map(source => source.startsWith('src/') ? 'res://' + source : source);
  files[appUri + '.map'] = JSON.stringify(appMap);
  modules.app = { uri: appUri, sha256: await hash(files[appUri]), dependencies: Object.keys(modules), kind: 'view' };
  const script = 'res://generated/react/entries/app.ts';
  const output = 'res://.godot/GodotJS/generated/react/entries/app.js';
  const scene = 'res://generated/react/scenes/app.tscn';
  const emitted = await esbuild.transform(bootstrap.source, { loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: script, sourcemap: 'external' });
  files[script] = bootstrap.source; files[output] = emitted.code; files[output + '.map'] = emitted.map;
  // Intentional negative fixture: run through the genuine NativeScript module
  // evaluator and native formatter, before the regular React bootstrap mounts.
  if (options.sourceMapProbe === 'caught' || options.sourceMapProbe === 'uncaught') {
    const call = `require(${JSON.stringify(appUri)}).crash()`;
    files[output] += options.sourceMapProbe === 'caught'
      ? `\ntry{${call};}catch(error){const raw=String(error.stack||error);console.log('PREFLIGHT_SOURCE_MAP '+JSON.stringify({raw,mapped:require('godot-jsb').internal.react.formatStack(raw)}));}\n`
      : `\n{const G=require('godot');const getLoop=G.Engine.get_main_loop||G.Engine.getMainLoop;getLoop.call(G.Engine).quit(0);${call};}\n`;
  }
  files[scene] = `[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="${script}" id="1"]\n[node name="app" type="Node"]\nscript = ExtResource("1")\nmetadata/_react_generation = "${generation}"\nmetadata/_react_props = "{}"\n`;
  const artifacts = {};
  for (const [uri, bytes] of Object.entries(files)) artifacts[uri] = { sha256: await hash(bytes), owner: 'compiler', kind: uri.endsWith('.ts') ? 'native-script-source' : uri.endsWith('.tscn') ? 'scene' : uri.endsWith('.map') ? 'source-map' : 'javascript' };
  const profile = contracts.profileReference('core-ui-v1');
  const manifest = {
    schemaVersion: 1, generation, sourceSnapshotHash: await hash(source), compilerVersion: 'browser-preflight/0.1',
    runtimeAbi: contracts.RUNTIME_ABI, nativeBridgeAbi: contracts.NATIVE_BRIDGE_ABI,
    entryInterfaceHash: await hash('app:default'), mode: 'production',
    target: { sourceCommit: 'unknown', sourceDiffHash: '0'.repeat(64), godotVersion: target.godotVersion, engine: target.engine, platform: 'web', arch: 'wasm32', buildFlags: { threads: false }, godotSchemaHash: profile.hash },
    react: { ...contracts.REACT_VERSIONS }, profile,
    entries: { app: { id: 'app', module: 'app', exportName: 'default', script, scene, startupAssets: [] } },
    modules, resources: {}, nativeScripts: { app: { source: script, output, sha256: artifacts[output].sha256, dependencies: [] } }, artifacts,
    sourceOrigins: { [appUri]: { source: 'res://src/Counter.tsx', line: 0, column: 0 } },
  };
  contracts.validateRuntimeManifest(manifest);
  const manifestPath = `res://generated/react/manifests/${generation}.json`;
  files[manifestPath] = JSON.stringify(manifest);
  files['res://generated/react/active.json'] = JSON.stringify({ schemaVersion: 1, generation, manifestPath, manifestSha256: await hash(files[manifestPath]), state: 'READY' });
  files['res://project.godot'] = `config_version=5\n[application]\nconfig/name="Browser TSX preflight"\nrun/main_scene="${scene}"\n[display]\nwindow/size/viewport_width=640\nwindow/size/viewport_height=360\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[physics]\n2d/physics_engine="Dummy"\n3d/physics_engine="Dummy"\n[godotjs]\nreact/enabled=true\n[GodotJS]\nruntime/debugger/debugger_port=0\n`;
  // No global script classes are declared by this code-only project. Exported
  // templates require this cache even when its class list is empty.
  files['res://.godot/global_script_class_cache.cfg'] = 'list=Array[Dictionary]([])\n';
  return { files, generation, manifest, ...packProject(files), compiler: { location: 'browser-worker', crossOriginIsolated, esbuildVersion: esbuild.version, fetched, sourceMap: JSON.parse(files[appUri + '.map']) } };
}
self.onmessage = async ({ data }) => {
  try { self.postMessage({ id: data.id, ok: true, result: await compile(data.source, data.options) }); }
  catch (error) { self.postMessage({ id: data.id, ok: false, error: String(error), diagnostics: error.errors ?? [] }); }
};
