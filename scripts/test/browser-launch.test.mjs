import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const type={executablePath:()=>'/playwright/pinned/chromium'};
const env={};
test('locked Playwright binary wins over available system browsers',()=>{
 assert.deepEqual(resolveBrowserExecutable(type,'chromium',{environment:env,exists:path=>['/playwright/pinned/chromium','/usr/bin/chromium'].includes(path)}),{executablePath:'/playwright/pinned/chromium',source:'playwright-managed'});
});
test('local system fallback requires a real detected executable',()=>{
 assert.deepEqual(resolveBrowserExecutable(type,'chromium',{environment:env,exists:path=>path==='/usr/bin/chromium'}),{executablePath:'/usr/bin/chromium',source:'system-fallback'});
 assert.throws(()=>resolveBrowserExecutable(type,'chromium',{environment:env,exists:()=>false}),/Install the locked Playwright browser/);
});
test('explicit override wins and missing override fails closed',()=>{
 assert.deepEqual(resolveBrowserExecutable(type,'chromium',{environment:{PLAYWRIGHT_CHROMIUM_EXECUTABLE:'/custom/chromium'},exists:()=>true}),{executablePath:'/custom/chromium',source:'override'});
 assert.throws(()=>resolveBrowserExecutable(type,'chromium',{environment:{PLAYWRIGHT_CHROMIUM_EXECUTABLE:'/missing'},exists:()=>false}),/Explicit browser does not exist/);
});
test('Firefox and WebKit cannot accidentally fall back to system Chromium',()=>{
 for(const name of ['firefox','webkit'])assert.throws(()=>resolveBrowserExecutable(type,name,{environment:env,exists:path=>path==='/usr/bin/chromium'}),new RegExp('install --with-deps '+name));
 assert.throws(()=>resolveBrowserExecutable(type,'__proto__',{environment:env}),/Unknown browser/);
});
