import {sameWorkerRun} from '@godot-js/engine/browser/dedicated/worker-protocol';
import type {GameProbeResult, InputScriptResult} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {DebugRun} from '../debug-api';
import type {PlaygroundApi, SummerDebuggerErrorsData, SummerProjectContextData, SummerScriptErrorsData} from '../playground-api';
import type {ProjectFileRead, ProjectFileReceipt} from '../project-file-access';
import type {PlayData, StopData} from '../summer-adapter';
import {RUNTIME_RECOVERY_ERROR, RUNTIME_RECOVERY_PLAYER_PATH, RUNTIME_RECOVERY_START_FILE} from '../runtime-recovery-demo.ts';
import type {ConsoleOperationId} from './api-console-catalog';
import type {SummerOperation} from '../summer-operation-spec';
import {hasCleanRuntimeExit} from './runtime-properties-replay.ts';

const scriptPath = 'res:/' + RUNTIME_RECOVERY_START_FILE;
const brokenLine = 'const startupBroken = true;';
const timeoutMs = 60_000;

type WaitReceipt = Extract<Awaited<ReturnType<PlaygroundApi['wait_for_event']>>, {ok: true}>['result'];

interface RecoveryActions {
  invoke(id: ConsoleOperationId, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  cancelLaunch(attemptId: string): void;
  progress(message: string): void;
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function result<T>(reply: unknown): T {
  const value = reply as {ok: boolean; result: T; error?: {message?: string}};
  requireFact(value.ok, value.error?.message ?? 'API 调用失败');
  return value.result;
}

export async function runRuntimeRecoveryReplay(
  api: PlaygroundApi, actions: RecoveryActions, projectId: string, signal: AbortSignal,
) {
  let latestAttemptId: string | null;
  let ownedAttemptId: string | undefined;
  let editorRevision: number;

  function currentProject() {
    const context = api.get_project_context().result;
    requireFact(context.projectId === projectId, '示例项目已切换');
    return context;
  }

  function assertTarget(run?: DebugRun) {
    signal.throwIfAborted();
    const context = currentProject();
    requireFact(context.editorRevision === editorRevision, '示例项目已被编辑');
    requireFact(context.latestBuildAttemptId === latestAttemptId, '示例的构建已被替换');
    if (run) requireFact(context.activeRunId === run.runId, '示例运行已被替换或停止');
  }

  async function summer<T>(id: SummerOperation, input = {}, run?: DebugRun) {
    assertTarget(run);
    const reply = await actions.invoke(id, input, signal);
    // An accepted Play needs to be captured even if cancellation arrives before its reply.
    if (id !== 'engine.play') signal.throwIfAborted();
    return result<{data: T}>(reply).data;
  }

  async function wait(target: {attemptId: string} | {runId: string}, until: 'running' | 'exited') {
    const reply = await actions.invoke('wait_for_event', {...target, until, timeoutMs}, signal);
    signal.throwIfAborted();
    return result<WaitReceipt>(reply);
  }

  async function launch(until: 'running' | 'exited', expectedSourceHash?: string) {
    requireFact(currentProject().activeRunId === null, '当前有其他预览正在运行');
    const ticket = await summer<PlayData>('engine.play');
    const attemptId = ticket.attemptId;
    latestAttemptId = ownedAttemptId = attemptId;
    requireFact(ticket.projectId === projectId && ticket.editorRevision === editorRevision, '启动回执属于其他项目版本');
    signal.throwIfAborted();
    const receipt = await wait({attemptId}, until);
    const {run, build} = receipt;
    requireFact(receipt.outcome === 'reached' && run && build?.artifact && build.sourceHash &&
      run.attemptId === attemptId && run.projectId === projectId && run.revision === editorRevision &&
      run.buildKey === build.artifact.buildKey, '未取得对应版本的运行回执');
    assertTarget(until === 'running' ? run : undefined);
    requireFact(expectedSourceHash === undefined || expectedSourceHash === build.sourceHash, '构建使用了不同的源码');
    if (until === 'running') {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        assertTarget(run);
        const live = api.get_run({runId: run.runId});
        requireFact(live.ok && sameWorkerRun(live.result, run) && !live.result.exit, '示例运行已经退出');
        if (live.result.gameProbe.ready && live.result.inputScript.ready) break;
        requireFact(performance.now() < deadline, '等待帧探测和输入就绪超时');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return {run, sourceHash: build.sourceHash};
  }

  async function probe(run: DebugRun, x: number, afterIteration?: number) {
    const frame = await summer<Extract<GameProbeResult, {ok: true}>['result']>('engine.game_probe', {
      props: [RUNTIME_RECOVERY_PLAYER_PATH + ':position'],
    }, run);
    const position = frame.properties.find(item => item.path === RUNTIME_RECOVERY_PLAYER_PATH && item.property === 'position');
    requireFact(sameWorkerRun(frame.run, run) && position?.status === 'value' &&
      typeof position.value === 'object' && position.value.x === x && position.value.y === 256, `未观察到玩家位置 (${x}, 256)`);
    requireFact(frame.mode === 'rendered' && frame.image.bytes.byteLength > 0 &&
      frame.image.iteration === frame.frame.iteration && frame.image.renderSerial === frame.frame.renderSerial &&
      (afterIteration === undefined || frame.frame.iteration > afterIteration), '未取得对应迭代的 PNG');
  }

  async function stop(run: DebugRun) {
    const ticket = await summer<StopData>('engine.stop', {}, run);
    requireFact(ticket.capturedRunId === run.runId &&
      ticket.runs.some(item => item.runId === run.runId && item.receipt.ok), '未受理示例运行的停止请求');
    const receipt = await wait({runId: run.runId}, 'exited');
    requireFact(receipt.outcome === 'reached' && receipt.run && sameWorkerRun(receipt.run, run) &&
      hasCleanRuntimeExit(receipt.run.exit), '未确认示例运行正常退出并完成清理');
    ownedAttemptId = undefined;
  }

  const initial = currentProject();
  requireFact(initial.editorRevision !== null, '示例项目尚未就绪');
  editorRevision = initial.editorRevision;
  // Opening a pristine sample can reuse a previous project and its retained history.
  latestAttemptId = initial.latestBuildAttemptId;
  const capability = await summer<SummerProjectContextData>('engine.get_project_context', {include: ['capabilities']});
  requireFact(capability.capabilities.play === 'available', '当前预览无法运行示例');
  let failure: unknown;
  try {
    actions.progress('启动故障版并读取诊断');
    const failed = await launch('exited');
    const diagnostic = await summer<SummerDebuggerErrorsData>('engine.get_debugger_errors', {include_stack: true});
    requireFact(failed.run.exit?.evidence === 'host-report' && diagnostic.status === 'observed' &&
      diagnostic.projectId === projectId && diagnostic.editorRevision === editorRevision &&
      diagnostic.runId === failed.run.runId && diagnostic.build?.attemptId === failed.run.attemptId &&
      diagnostic.build.sourceHash === failed.sourceHash && diagnostic.entries[0].diagnostic.message === RUNTIME_RECOVERY_ERROR &&
      failed.run.exit.report.sessionFacts?.hostCleanup === 'complete',
      '未确认本次运行的预期启动错误与清理');
    ownedAttemptId = undefined;

    actions.progress('读取脚本并提交受保护的修复');
    const source = await summer<ProjectFileRead>('engine.read_file', {path: scriptPath});
    requireFact(source.projectId === projectId && source.editorRevision === editorRevision && source.path === scriptPath &&
      source.content.split(brokenLine).length === 2, '启动脚本已变化');
    const write = await summer<ProjectFileReceipt>('engine.write_file', {
      path: source.path, content: source.content.replace(brokenLine, 'const startupBroken = false;'),
      expected_sha256: source.sha256, projectId, expectedEditorRevision: editorRevision,
    });
    requireFact(write.projectId === projectId && write.path === scriptPath && write.editorRevision === editorRevision + 1,
      '修复回执属于其他项目版本');
    editorRevision = write.editorRevision;
    // The latest attempt is tracked per project, including across editor revisions.
    const check = await summer<SummerScriptErrorsData>('engine.get_script_errors', {path: scriptPath});
    requireFact(check.status === 'completed' && check.projectId === projectId && check.editorRevision === editorRevision &&
      check.path === scriptPath && check.diagnostics.counts?.error === 0 && check.sourceHash,
      '修复版未通过脚本检查');

    actions.progress('运行修复版，验证四帧输入与同帧 PNG');
    const fixed = await launch('running', check.sourceHash);
    requireFact(fixed.sourceHash !== failed.sourceHash, '修复前后源码身份相同');
    await probe(fixed.run, 64);
    const input = await summer<Extract<InputScriptResult, {ok: true}>>('engine.game_input', {
      action: 'script', events: [
        {type: 'action', action: 'move_right', pressed: true, at_frame: 0},
        {type: 'action', action: 'move_right', pressed: false, at_frame: 4},
      ],
    }, fixed.run);
    requireFact(sameWorkerRun(input.receipt.run, fixed.run) && input.result.releaseStepCompleted &&
      BigInt(input.result.up.physics) - BigInt(input.result.down.physics) === 4n, '未确认四个物理帧的输入与释放');
    await probe(fixed.run, 128, input.result.finishedIteration);
    await stop(fixed.run);

    actions.progress('重启并验证初始位置与退出清理');
    const restarted = await launch('running', check.sourceHash);
    requireFact(restarted.run.runId !== fixed.run.runId && restarted.run.workerId !== fixed.run.workerId,
      '未取得新的 Worker 运行');
    await probe(restarted.run, 64);
    await stop(restarted.run);
  } catch (caught) {
    failure = caught;
    throw caught;
  } finally {
    if (ownedAttemptId) {
      actions.progress('等待示例运行清理');
      actions.cancelLaunch(ownedAttemptId);
      const settled = await api.wait_for_event({attemptId: ownedAttemptId, until: 'exited', timeoutMs: 10_000});
      requireFact(settled.ok && (settled.result.outcome === 'no_session' ||
        settled.result.outcome === 'reached' && settled.result.run?.exit?.evidence === 'host-report' &&
        settled.result.run.exit.report.sessionFacts?.hostCleanup === 'complete'),
        (failure instanceof Error ? failure.message + '。' : '') + '未确认示例运行完成清理');
    }
  }
}
