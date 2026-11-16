import { benchmarkNow, type WorkerBenchmark, type BenchmarkHostFrameTiming } from './worker-benchmark.js';
/** Presentation owns frame transport, never the Godot GL context or simulation. */
export type PresentationMode = 'direct' | 'bitmap';
export interface CanvasGeometry {
  width: number; height: number; dpr: number; epoch: number;
  left?: number; top?: number;
}
export interface PresentationLimits { maxDimension: number; maxPixels: number; maxAggregateBytes?: number }
export const DEFAULT_PRESENTATION_LIMITS: Readonly<PresentationLimits> = Object.freeze({ maxDimension: 16384, maxPixels: 16_777_216, maxAggregateBytes:268_435_456 });
export interface FrameTicket { runId: string; frameId: number; resizeEpoch: number }
export interface BitmapFrame extends FrameTicket {
  type: 'present-frame'; width: number; height: number; bitmap: ImageBitmap;
}
export interface FrameAck extends FrameTicket { type: 'present-ack';timing?:BenchmarkHostFrameTiming }
export interface PresentationCheckpoint {geometryEpoch:number;outstanding:(FrameTicket&{estimatedBytes:number})|null}
export interface PresentationStats {
  committed: number; captured: number; acknowledged: number; skipped: number;
  outstanding: number; peakOutstanding: number;
  geometry?: CanvasGeometry; drawingBuffer?: {width:number;height:number;estimatedBytes:number};
  currentBitmap?: {width:number;height:number;estimatedBytes:number}|null;
  inFlightEstimatedBytes?:number; renderBuffersEstimatedBytes?:number; aggregateEstimatedBytes?:number;
  memoryAccounting?:'estimate: three RGBA-sized render/display reserves plus in-flight bitmap';
}

export function drawingBufferSize(geometry: CanvasGeometry, limits: PresentationLimits = DEFAULT_PRESENTATION_LIMITS): { width: number; height: number } {
  if (!Number.isSafeInteger(geometry.epoch) || geometry.epoch < 0 ||
      !Number.isFinite(geometry.width) || geometry.width < 0 ||
      !Number.isFinite(geometry.height) || geometry.height < 0 ||
      !Number.isFinite(geometry.dpr) || geometry.dpr <= 0 || geometry.dpr > 16 ||
      !Number.isSafeInteger(limits.maxDimension) || limits.maxDimension <= 0 ||
      !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels <= 0 ||
      (geometry.left !== undefined && !Number.isFinite(geometry.left)) ||
      (geometry.top !== undefined && !Number.isFinite(geometry.top))) throw Error('E_WORKER_CANVAS_GEOMETRY');
  const width = Math.floor(geometry.width * geometry.dpr), height = Math.floor(geometry.height * geometry.dpr);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels)
    throw Error('E_WORKER_CANVAS_BUDGET');
  return { width, height };
}
export function sameFrameTicket(a: FrameTicket, b: FrameTicket): boolean {
  return a.runId === b.runId && a.frameId === b.frameId && a.resizeEpoch === b.resizeEpoch;
}
export function isFrameTicket(value: unknown): value is FrameTicket {
  const item = value as FrameTicket;
  return !!item && typeof item.runId === 'string' && item.runId.length > 0 && item.runId.length <= 256 &&
    Number.isSafeInteger(item.frameId) && item.frameId > 0 && Number.isSafeInteger(item.resizeEpoch) && item.resizeEpoch >= 0;
}
function validateMode(mode: PresentationMode): void {
  if (mode !== 'direct' && mode !== 'bitmap') throw Error('E_WORKER_PRESENTATION_MODE');
}
function presentationByteLimit(limits:PresentationLimits):number {
  const value=limits.maxAggregateBytes??DEFAULT_PRESENTATION_LIMITS.maxAggregateBytes!;
  if(!Number.isSafeInteger(value)||value<=0)throw Error('E_WORKER_PRESENTATION_BUDGET');return value;
}
function assertPresentationBytes(size:{width:number;height:number},limit:number,bitmapBytes=0):void {
  const bytes=size.width*size.height*12+bitmapBytes;
  if(!Number.isSafeInteger(bytes)||bytes>limit)throw Error('E_WORKER_PRESENTATION_BUDGET');
}

export interface WorkerPresentationOptions {
  runId: string; canvas: OffscreenCanvas; mode?: PresentationMode; geometry: CanvasGeometry;
  limits?: PresentationLimits;
  /** Must transfer frame.bitmap. A successful send transfers ownership to host. */
  sendFrame: (frame: BitmapFrame) => void;
  onFatal: (error: unknown) => void;
  /** XR owns its own presentation/credit path and must never wait for a 2D ACK. */
  isXRActive?: () => boolean;
  /** Resolve the live native reset hook. setup/cleanup can install/remove it
   * after this presenter was created; teardown must not retain a stale export. */
  resetDrawCredit?: () => void;
  benchmark?:WorkerBenchmark;benchmarkClock?:()=>number;
}
export function createWorkerPresentation(options: WorkerPresentationOptions) {
  const mode = options.mode ?? 'direct'; validateMode(mode);
  const limits = Object.freeze({ ...(options.limits ?? DEFAULT_PRESENTATION_LIMITS) });
  const runId = options.runId;
  if (!runId) throw Error('E_WORKER_PRESENTATION_ID');
  let geometry = { ...options.geometry }, size = drawingBufferSize(geometry, limits);
  const canvas = options.canvas;
  const aggregateLimit = presentationByteLimit(limits);
  let inFlightSize: {width:number;height:number;estimatedBytes:number}|undefined;
  function assertBudget(next: {width:number;height:number}, bitmapBytes = inFlightSize?.estimatedBytes ?? 0) {
    // The three RGBA-sized reserves include the host display backing image.
    // GPU implementation allocations are opaque; this fixed ABI accounting
    // estimate is never a claim about measured GPU process memory or its upper bound.
    assertPresentationBytes(next,aggregateLimit,bitmapBytes);
  }
  assertBudget(size);
  canvas.width = size.width; canvas.height = size.height;
  let closed = false, visible = true, iterating = false, committedThisIteration = false;
  let commitSerial = 0, frameSerial = 0, iteration = 0, outstanding: FrameTicket | undefined;
  const counters: PresentationStats = { committed: 0, captured: 0, acknowledged: 0, skipped: 0, outstanding: 0, peakOutstanding: 0 };
  const lost = (event: Event) => {
    event.preventDefault();
    if (closed) return;
    dispose(); options.onFatal(Error('E_WORKER_WEBGL_CONTEXT_LOST'));
  };
  // Keep the real OffscreenCanvas event target. DOM input has a separate bridge.
  canvas.addEventListener('webglcontextlost', lost);
  function dispose(): void {
    if (closed) return;
    closed = true; iterating = false; committedThisIteration = false;
    outstanding = undefined; counters.outstanding = 0;
    inFlightSize = undefined;
    canvas.removeEventListener('webglcontextlost', lost);
    options.resetDrawCredit?.();
  }
  return {
    mode,
    /** Native consults this only at its draw boundary. It must still run the
     * simulation and preserve the project's render_loop_enabled setting. A
     * resize keeps the old exact ticket live until its matching ACK arrives. */
    canDraw(): boolean {
      return closed || mode !== 'bitmap' || options.isXRActive?.() === true || !outstanding;
    },
    /** Called by native after FPS skipping, before this main-loop iteration. */
    beginIteration(id = iteration + 1): void {
      if (!closed && Number.isSafeInteger(id) && id > iteration) {
        iteration = id; iterating = true; committedThisIteration = false;
      }
    },
    /** Called only by the native successful swap/commit hook, not by rAF. */
    commit(serial?: number, id = iteration): void {
      if (mode === 'direct') {
        if (closed) return;
        const next = serial ?? commitSerial + 1;
        if (!Number.isSafeInteger(next) || next <= commitSerial) return;
        commitSerial = next; counters.committed++; return;
      }
      if (closed || !iterating || id !== iteration) return;
      const next = serial ?? commitSerial + 1;
      if (!Number.isSafeInteger(next) || next <= commitSerial) return;
      commitSerial = next; committedThisIteration = true; counters.committed++;
    },
    /** Called after engine presentation/FBO parking in Module.postMainLoop. */
    endIteration(id = iteration, serial = commitSerial): void {
      if (closed || !iterating || id !== iteration || serial !== commitSerial) return;
      iterating = false;
      const committed = committedThisIteration; committedThisIteration = false;
      if (mode === 'direct') return;
      if (!committed || !visible || !size.width || !size.height || outstanding) { counters.skipped++; return; }
      let bitmap: ImageBitmap | undefined;
      try {
        assertBudget(size,size.width*size.height*4);
        const captureStart=options.benchmark?(options.benchmarkClock??benchmarkNow)():undefined;
        bitmap = canvas.transferToImageBitmap();
        const ticket: FrameTicket = { runId, frameId: ++frameSerial, resizeEpoch: geometry.epoch };
        if(captureStart!==undefined)options.benchmark!.frameCaptured(ticket,captureStart,(options.benchmarkClock??benchmarkNow)());
        outstanding = ticket; counters.outstanding = 1; counters.peakOutstanding = 1;
        inFlightSize = {...size,estimatedBytes:size.width*size.height*4};
        options.sendFrame({ type: 'present-frame', ...ticket, ...size, bitmap });
        bitmap = undefined; counters.captured++;
      } catch (error) {
        bitmap?.close(); dispose(); options.onFatal(error);
      }
    },
    ack(ticket: FrameTicket & {timing?:BenchmarkHostFrameTiming}): boolean {
      if (closed || !isFrameTicket(ticket) || !outstanding || !sameFrameTicket(outstanding, ticket)) return false;
      options.benchmark?.frameAcknowledged(ticket);
      // A resize does not invalidate the outstanding ticket's release receipt.
      outstanding = undefined; inFlightSize = undefined; counters.outstanding = 0; counters.acknowledged++; return true;
    },
    resize(next: CanvasGeometry): boolean {
      if (closed || next.epoch <= geometry.epoch) return false;
      const nextSize = drawingBufferSize(next, limits);
      assertBudget(nextSize);
      geometry = { ...next }; size = nextSize; committedThisIteration = false;
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      return true;
    },
    setVisible(next: boolean): void { visible = next; },
    get geometry(): CanvasGeometry { return { ...geometry }; },
    checkpoint():PresentationCheckpoint{return {geometryEpoch:geometry.epoch,outstanding:outstanding&&inFlightSize?{...outstanding,estimatedBytes:inFlightSize.estimatedBytes}:null};},
    stats(): PresentationStats { const inFlightEstimatedBytes = outstanding ? inFlightSize?.estimatedBytes ?? 0 : 0; return { ...counters,
      geometry:{...geometry},drawingBuffer:{...size,estimatedBytes:size.width*size.height*4},currentBitmap:outstanding ? {...inFlightSize!} : null,
      inFlightEstimatedBytes,renderBuffersEstimatedBytes:size.width*size.height*12,
      aggregateEstimatedBytes:size.width*size.height*12+inFlightEstimatedBytes,
      memoryAccounting:'estimate: three RGBA-sized render/display reserves plus in-flight bitmap' }; },
    dispose,
  };
}

export interface PresentationHostOptions {
  runId: string; canvas: HTMLCanvasElement; mode?: PresentationMode; geometry: CanvasGeometry;
  limits?: PresentationLimits;
  sendAck: (ack: FrameAck) => void;
  onFatal: (error: unknown) => void;
  createOffscreen?: (width: number, height: number) => OffscreenCanvas;
  benchmarkTimings?:boolean;benchmarkClock?:()=>number;
}
export interface PresentationHostStats {
  mode:PresentationMode;closed:boolean;viewport:CanvasGeometry;
  drawingBuffer:{width:number;height:number;estimatedBytes:number};
  /** Metadata for bitmaprenderer backing storage, after consuming the bitmap
   * object. This is ownership accounting, not proof of on-screen presentation. */
  retainedBitmap:(FrameTicket&{width:number;height:number;estimatedBytes:number})|null;
  provesOnscreenPresentation:false;
  aggregateReservedBytes:number;reservedBitmapBytes:number;pendingGeometryReservations:number;workerGeometryEpoch:number|null;
  memoryAccounting:'metadata estimates, not measured GPU memory; drawingBuffer and retainedBitmap are not additive';
}
export function createPresentationHost(options: PresentationHostOptions) {
  const mode = options.mode ?? 'direct'; validateMode(mode);
  const limits = Object.freeze({ ...(options.limits ?? DEFAULT_PRESENTATION_LIMITS) });
  const runId = options.runId;
  if (!runId) throw Error('E_WORKER_PRESENTATION_ID');
  let geometry = { ...options.geometry }, size = drawingBufferSize(geometry, limits), closed = false, lastFrame = 0;
  const aggregateLimit=presentationByteLimit(limits);assertPresentationBytes(size,aggregateLimit);
  const geometries=new Map<number,number>([[geometry.epoch,size.width*size.height*4]]);
  let checkpointSequence=-1,workerGeometryEpoch:number|null=null;
  function reservedBitmapBytes():number{
    if(mode!=='bitmap'||closed)return 0;let maximum=0;
    // Only sizes which could pass the Worker's capture admission can own a
    // bitmap. Unknown capture timing reserves one largest possible ticket.
    for(const bytes of geometries.values())if(bytes*4<=aggregateLimit)maximum=Math.max(maximum,bytes);
    return maximum;
  }
  let retainedBitmap:PresentationHostStats['retainedBitmap']=null;
  const canvas = options.canvas;
  canvas.width = size.width; canvas.height = size.height;
  // CSS dimensions belong to the host's responsive layout. Writing observed
  // pixel sizes here would freeze a 100% canvas after its first observation.
  const context = mode === 'bitmap' ? canvas.getContext('bitmaprenderer') : null;
  if (mode === 'bitmap' && !context) throw Error('E_WORKER_BITMAP_CONTEXT');
  const offscreen = mode === 'direct' ? canvas.transferControlToOffscreen() :
    (options.createOffscreen ?? ((width, height) => new OffscreenCanvas(width, height)))(size.width, size.height);
  return {
    mode, offscreen,
    consume(frame: BitmapFrame): boolean {
      if (!frame?.bitmap || typeof frame.bitmap.close !== 'function') return false;
      if (!isFrameTicket(frame as unknown)) { frame.bitmap.close(); return false; }
      let accepted = false;
      const receivedAtMs=options.benchmarkTimings?(options.benchmarkClock??benchmarkNow)():undefined;
      try {
        if (!closed && mode === 'bitmap' && frame.runId === runId && frame.frameId > lastFrame &&
            frame.resizeEpoch === geometry.epoch && frame.width === size.width && frame.height === size.height &&
            frame.bitmap.width === size.width && frame.bitmap.height === size.height && size.width > 0 && size.height > 0) {
          assertPresentationBytes(size,aggregateLimit,frame.width*frame.height*4);
          context!.transferFromImageBitmap(frame.bitmap); lastFrame = frame.frameId; accepted = true;
          retainedBitmap={runId:frame.runId,frameId:frame.frameId,resizeEpoch:frame.resizeEpoch,width:frame.width,height:frame.height,estimatedBytes:frame.width*frame.height*4};
        }
      } catch (error) { options.onFatal(error); }
      finally {
        // transferFromImageBitmap consumes on success; close is idempotent for a
        // detached bitmap and also releases stale/failed deliveries.
        frame.bitmap.close();
        options.sendAck({ type: 'present-ack', runId: frame.runId, frameId: frame.frameId, resizeEpoch: frame.resizeEpoch,
          ...(receivedAtMs===undefined?{}:{timing:{receivedAtMs,consumedAtMs:(options.benchmarkClock??benchmarkNow)(),disposition:accepted?'consumed' as const:'released' as const}}) });
      }
      return accepted;
    },
    resize(next: CanvasGeometry): boolean {
      if (closed || next.epoch <= geometry.epoch) return false;
      const nextSize = drawingBufferSize(next, limits);
      assertPresentationBytes(nextSize,aggregateLimit,reservedBitmapBytes());
      if(geometries.size>=1024)throw Error('E_WORKER_PRESENTATION_RESIZE_BACKPRESSURE');
      geometry = { ...next }; size = nextSize;geometries.set(next.epoch,size.width*size.height*4);
      if (mode === 'bitmap') {
        // Assigning even an unchanged canvas attribute clears its backing
        // image. A duplicate geometry epoch must keep the last valid picture.
        const clears=canvas.width!==size.width||canvas.height!==size.height;
        if(canvas.width!==size.width)canvas.width=size.width;
        if(canvas.height!==size.height)canvas.height=size.height;
        if(clears)retainedBitmap=null;
      }
      return true;
    },
    observeWorkerCheckpoint(value:unknown,sequence:number):boolean{
      if(closed||!Number.isSafeInteger(sequence)||sequence<=checkpointSequence)return false;
      const state=value as PresentationCheckpoint;
      if(!state||!Number.isSafeInteger(state.geometryEpoch)||state.geometryEpoch>(geometry.epoch)||state.geometryEpoch<(workerGeometryEpoch??-1)||!geometries.has(state.geometryEpoch))return false;
      const ticket=state.outstanding;
      if(ticket!==null&&(!isFrameTicket(ticket)||ticket.runId!==runId||ticket.resizeEpoch>state.geometryEpoch||!Number.isSafeInteger(ticket.estimatedBytes)||ticket.estimatedBytes<1||!geometries.has(ticket.resizeEpoch)||ticket.estimatedBytes!==geometries.get(ticket.resizeEpoch)))return false;
      checkpointSequence=sequence;workerGeometryEpoch=state.geometryEpoch;
      for(const epoch of geometries.keys())if(epoch<state.geometryEpoch&&epoch!==ticket?.resizeEpoch)geometries.delete(epoch);
      return true;
    },
    get geometry(): CanvasGeometry { return { ...geometry }; },
    stats():PresentationHostStats {
      const width=canvas.width,height=canvas.height;
      return {mode,closed,viewport:{...geometry},drawingBuffer:{width,height,estimatedBytes:width*height*4},
        retainedBitmap:retainedBitmap?{...retainedBitmap}:null,provesOnscreenPresentation:false,
        aggregateReservedBytes:closed?0:size.width*size.height*12+reservedBitmapBytes(),reservedBitmapBytes:reservedBitmapBytes(),pendingGeometryReservations:geometries.size,workerGeometryEpoch,
        memoryAccounting:'metadata estimates, not measured GPU memory; drawingBuffer and retainedBitmap are not additive'};
    },
    dispose(): void {
      if (closed) return; closed = true;
      retainedBitmap=null;geometries.clear();
      if (mode === 'bitmap') { canvas.width = 0; canvas.height = 0; }
    },
  };
}

export interface PresentationModuleHooks {
  postMainLoop?: (...args: unknown[]) => unknown;
  godotWorkerBeginIteration?: (iteration: number) => void;
  godotWorkerCommit?: (serial: number, iteration: number) => void;
  godotWorkerEndIteration?: (iteration: number, serial: number) => void;
  /** Only strict false inhibits native drawing; absence is a legacy no-op. */
  godotWorkerDrawAllowed?: () => boolean | undefined;
  /** Native installs this during setup and removes it at cleanup. */
  godotWorkerResetDrawCredit?: () => void;
}
/** Bitmap capture follows native completion and the existing GL/FBO parking
 * post hook in the same iteration. Direct observes only actual native commits. */
export function installPresentationHooks(module: PresentationModuleHooks, presenter: ReturnType<typeof createWorkerPresentation>): () => void {
  const previous = { post: module.postMainLoop, begin: module.godotWorkerBeginIteration,
    commit: module.godotWorkerCommit, end: module.godotWorkerEndIteration, draw: module.godotWorkerDrawAllowed };
  const commit = (serial: number, iteration: number) => { presenter.commit(serial, iteration); previous.commit?.(serial, iteration); };
  if (presenter.mode === 'direct') {
    // Direct rendering owns no bitmap lifecycle or frame credit. Keep the
    // existing GL/FBO and other components' hooks intact, and observe only
    // actual native commits without creating a completion ticket each frame.
    module.godotWorkerCommit = commit;
    return () => { if (module.godotWorkerCommit === commit) module.godotWorkerCommit = previous.commit; };
  }
  let completed: { iteration: number; serial: number } | undefined;
  const begin = (iteration: number) => { completed = undefined; presenter.beginIteration(iteration); previous.begin?.(iteration); };
  const end = (iteration: number, serial: number) => { completed = { iteration, serial }; previous.end?.(iteration, serial); };
  const draw = () => presenter.canDraw() && previous.draw?.() !== false;
  const post = (...args: unknown[]) => {
    // A throwing existing hook aborts presentation: its GL state is unknown.
    const result = previous.post?.apply(module, args);
    const ticket = completed; completed = undefined;
    if (ticket) presenter.endIteration(ticket.iteration, ticket.serial);
    return result;
  };
  module.godotWorkerBeginIteration = begin; module.godotWorkerCommit = commit;
  module.godotWorkerEndIteration = end; module.postMainLoop = post;
  module.godotWorkerDrawAllowed = draw;
  return () => {
    if (module.godotWorkerBeginIteration === begin) module.godotWorkerBeginIteration = previous.begin;
    if (module.godotWorkerCommit === commit) module.godotWorkerCommit = previous.commit;
    if (module.godotWorkerEndIteration === end) module.godotWorkerEndIteration = previous.end;
    if (module.postMainLoop === post) module.postMainLoop = previous.post;
    if (module.godotWorkerDrawAllowed === draw) module.godotWorkerDrawAllowed = previous.draw;
    completed = undefined;
  };
}
