const $ = id => document.getElementById(id);
const worker = new Worker('./compiler.js' + location.search);
const pending = new Map();
const state = window.preflight = { runs: [], errors: [], compiler: null, crossOriginIsolated, events: [] };
let serial = 0, frame;
let workerFailure;
worker.onmessage = ({ data }) => {
  const task = pending.get(data.id); if (!task) return;
  pending.delete(data.id);
  data.ok ? task.resolve(data.result) : task.reject(Object.assign(Error(data.error), { diagnostics: data.diagnostics }));
};
worker.onerror = event => { workerFailure = Error(event.message); for (const task of pending.values()) task.reject(workerFailure); pending.clear(); };
function log(line) { $('log').textContent += line + '\n'; }
function compile(source) { return new Promise((resolve, reject) => {
  if (workerFailure) { reject(workerFailure); return; }
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('Browser compile timed out')); }, 60000);
  pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
  worker.postMessage({ id, source });
}); }
state.compile = compile;
async function stop() {
  if (!frame) return;
  const previous = frame;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(); };
    const timer = setTimeout(finish, 3000);
    const onMessage = event => { if (event.origin === location.origin && event.source === previous.contentWindow && event.data?.type === 'exited') finish(); };
    window.addEventListener('message', onMessage);
    previous.contentWindow.postMessage({ type: 'stop' }, location.origin);
  });
  previous.remove(); frame = null;
}
state.stop = stop;
state.run = async () => {
  $('run').disabled = true;
  try {
    $('status').textContent = '浏览器编译中';
    const result = await compile($('source').value);
    await stop();
    state.compiler = result.compiler;
    const record = { generation: result.generation, events: [], files: Object.keys(result.files).length };
    state.runs.push(record);
    frame = document.createElement('iframe'); frame.src = './preview.html'; frame.title = 'Godot WASM preview';
    await new Promise(resolve => { frame.onload = resolve; $('preview').replaceChildren(frame); });
    frame.contentWindow.postMessage({ type: 'run', result }, location.origin);
    $('status').textContent = '引擎启动中';
  } catch (error) { state.errors.push(String(error)); $('status').textContent = '失败'; log(String(error)); throw error; }
  finally { $('run').disabled = false; }
};
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
  const data = event.data;
  state.events.push(data); state.runs.at(-1)?.events.push(data);
  if (data.type === 'log') { log(data.text); if (data.text.includes('GODOT_REACT_BOOT_REPORT')) $('status').textContent = '运行中'; }
  if (data.type === 'error') { state.errors.push(data.text); log(data.text); $('status').textContent = '失败'; }
});
$('run').onclick = () => state.run().catch(() => {});
$('stop').onclick = () => stop().then(() => { $('status').textContent = '已停止'; });
$('source').value = await (await fetch('./Counter.tsx')).text();
$('status').textContent = '就绪';
