#!/usr/bin/env node
import process from 'node:process';
import {checkNodeProject, compileNodeProject, type NodeCompileOptions} from './compiler.js';

const args = process.argv.slice(2), operation = args.shift() ?? 'help';
const flags: Record<string, string> = Object.create(null);
try {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw Error('Expected --name value arguments');
    if (!['project', 'release', 'output', 'mode', 'startup-adapter', 'entry', 'export', 'main-scene','artifact-set','resource-cache'].includes(name.slice(2))) throw Error('Unknown option ' + name);
    flags[name.slice(2)] = value;
  }
  if (operation === 'help') console.log('godotjs check|build|export-pck --project project.json|DIR --release engine-release.json [--output application.pck | --artifact-set DIR] [--resource-cache DIR] [--mode development|production] [--startup-adapter MODULE]\nDirectory startup: default project main_scene; --entry src/start.ts [--export start] or --main-scene main.tscn');
  else {
    if (!['check', 'build', 'export-pck'].includes(operation)) throw Error('Unknown operation ' + operation);
    if (!flags.project || !flags.release) throw Error('--project and --release are required');
    if (flags.mode && !['development', 'production'].includes(flags.mode)) throw Error('Unsupported --mode');
    if (operation !== 'check' && !flags.output&&!flags['artifact-set']) throw Error('--output or --artifact-set is required for build/export-pck');
    if(flags.output&&flags['artifact-set'])throw Error('Choose --output or --artifact-set');
    if (flags.entry && flags['main-scene'] || flags.export && !flags.entry) throw Error('Use one directory startup: --entry [--export] or --main-scene');
    const options: NodeCompileOptions = {project: flags.project, release: flags.release,
      output: flags.output, mode: flags.mode as NodeCompileOptions['mode'], startupAdapter: flags['startup-adapter'],
      artifactSetDirectory:flags['artifact-set'],resourceCacheDirectory:flags['resource-cache'],
      ...(flags.entry ? {launch: {kind: 'script', module: flags.entry, export: flags.export ?? 'start'}}
        : flags['main-scene'] ? {launch: {kind: 'scene', source: 'override', path: flags['main-scene']}} : {})};
    if (operation === 'check') {
      const result = await checkNodeProject(options); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
    } else {
      const result = await compileNodeProject(options);
      console.log(JSON.stringify({ok: true, output: flags.output, buildKey: result.buildKey,sourceHash:result.sourceHash,importReceipts:result.importReceipts, artifactId: result.artifactId,
        variant:result.variant,diagnostics: result.diagnostics,...(result.variant==='pack-set'?{artifactSetId:result.artifactSet.manifest.artifactSetId,artifactSetDirectory:flags['artifact-set']}:{packBytes:result.pack.byteLength})}));
    }
  }
} catch (error) {
  const value = error as {code?: string; diagnostics?: unknown};
  console.error(JSON.stringify({ok: false, code: value.code ?? 'E_COMPILE', error: String(error), ...(value.diagnostics ? {diagnostics: value.diagnostics} : {})}));
  process.exitCode = 1;
}
