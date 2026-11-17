'use strict';

// Executed by GodotJS in the engine Worker. The caller supplies the engine and
// its single React/reconciler realm; this fixture has no Node/browser DOM APIs.
exports.run = function run(G, R, React, options) {
  var h = React.createElement;
  var state = {
    detached: { done: false, passed: false },
    phase: { done: false, passed: false, attempted: false },
    opaque: { done: false, passed: false },
    rawSignal: { done: false, passed: false },
    errors: [],
    propertyWrites: { done: false, passed: false },
    errorForwarding: { done: false, passed: false },
    extendedErrors: []
  };
  var roots = [], mounts = [], rootA, rootB, phaseRef = React.createRef();
  var disposed = false, disposePromise;
  function call(object, name) {
    var args = Array.prototype.slice.call(arguments, 2);
    var camel = name.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
    var fn = object && (object[name] || object[camel]);
    if (typeof fn !== 'function') throw new Error('B5 missing native method: ' + name);
    return fn.apply(object, args);
  }
  function valid(object) {
    try { return !!(G.is_instance_valid || G.isInstanceValid)(object); }
    catch (_) { return false; }
  }
  function assert(condition, message) {
    if (!condition) throw new Error('B5 assertion: ' + message);
  }
  function detail(value) {
    try { return String(value && value.stack || value); }
    catch (_) { return 'unreadable error'; }
  }
  function record(value, info) {
    state.errors.push((info && info.kind ? info.kind + ': ' : '') + detail(value));
  }
  function root(mount) {
    var result = R.createRoot(mount, { godot: G, entry: options.entry, autoProcess: false, onError: record });
    roots.push(result);
    return result;
  }
  function mount() {
    var value = new G.Node();
    mounts.push(value);
    return value;
  }
  function element(props) { return h(R.EngineNode, props); }
  function attempt(name, body) {
    function failed(value) { record(value); state[name].done = true; state[name].passed = false; }
    try { var result = body(); if (result && typeof result.then === 'function') result.catch(failed); }
    catch (value) { failed(value); }
  }
  function extended(name, body) {
    function failed(value) {
      state.extendedErrors.push(name + ': ' + detail(value));
      state[name].done = true;
      state[name].passed = false;
    }
    try { var result = body(); if (result && typeof result.then === 'function') result.catch(failed); }
    catch (value) { failed(value); }
  }

  // These checks intentionally keep the original B5 results independent. The
  // raw harness separately requires extendedPassed; expected runtime errors are
  // consumed by this root's onError and must never reach the fatal host channel.
  extended('propertyWrites', function () {
    var internal = require('godot-jsb').internal;
    var write = internal.try_set_property || internal.trySetProperty;
    assert(typeof write === 'function', 'native property receipt hook is present');
    var setterProbe = new G.Node2D(), normalized, stored, rejected;
    try {
      normalized = write.call(internal, setterProbe, 'scale', new G.Vector2(0, 0));
      stored = call(setterProbe, 'get', 'scale');
      assert(normalized && normalized.accepted === true, 'native scale write is accepted');
      assert(normalized.value && Number.isFinite(normalized.value.x) && Number.isFinite(normalized.value.y), 'write receipt contains finite stored components');
      assert(normalized.value.x !== 0 && normalized.value.y !== 0, 'Node2D normalizes zero scale in native code');
      assert(normalized.value.x === stored.x && normalized.value.y === stored.y, 'receipt reports the normalized native value');
      rejected = write.call(internal, setterProbe, '__b5_unknown_property__', 1);
      assert(rejected && rejected.accepted === false, 'unknown native field is rejected');
    } finally {
      if (valid(setterProbe)) call(setterProbe, 'free');
    }
    assert(!valid(setterProbe), 'temporary property probe is freed');
    state.propertyWrites = {
      done: true, passed: true, accepted: normalized.accepted,
      normalizedX: normalized.value.x, normalizedY: normalized.value.y,
      storedX: stored.x, storedY: stored.y, rejected: !rejected.accepted,
      validAfterFree: valid(setterProbe)
    };
  });

  extended('errorForwarding', async function () {
    var borrowed = mount(), expected = new Error('B5_EXPECTED_FRAME_ERROR');
    var calls = [], object, attempted = false;
    var renderer = R.createRoot(borrowed, {
      godot: G, entry: options.entry, autoProcess: false,
      onError: function (value, info) { calls.push({ value: value, info: info }); }
    });
    roots.push(renderer);
    function ErrorDriver() {
      R.useFrame('process', function () {
        if (attempted) return;
        attempted = true;
        throw expected;
      });
      return element({ ctor: G.Node, ref: function (value) { if (value) object = value; } });
    }
    renderer.render(h(ErrorDriver));
    renderer.flush();
    assert(valid(object) && renderer.getErrors().length === 0, 'error probe mounts cleanly');
    renderer.process(1 / 60);
    assert(calls.length === 1 && calls[0].value === expected, 'onError receives the original frame error exactly once');
    assert(calls[0].info && calls[0].info.kind === 'runtime', 'onError includes runtime error kind');
    if (typeof expected.stack === 'string') assert(typeof calls[0].info.stack === 'string', 'onError preserves stack diagnostics');
    assert(renderer.getErrors().length === 1 && renderer.getErrors()[0] === expected, 'read-only getErrors retains the original error');
    renderer.shutdown();
    renderer.flush();
    assert(valid(object), 'explicit shutdown does not bypass the asynchronous release barrier');
    assert((await renderer.close()).status === 'complete', 'error root close confirms native retirement');
    assert(!valid(object) && valid(borrowed), 'error callback does not prevent normal owned-node cleanup');
    assert(calls.length === 1 && renderer.getErrors().length === 1, 'shutdown does not duplicate the reported runtime error');
    state.errorForwarding = {
      done: true, passed: true, calls: calls.length, kind: calls[0].info.kind,
      retainedErrors: renderer.getErrors().length,
      validAfterFree: valid(object), borrowedMountAlive: valid(borrowed),
      releaseRequested: renderer.getStats().releaseRequested, freed: renderer.getStats().freed
    };
  });

  attempt('detached', async function () {
    var borrowed = mount(), renderer = root(borrowed), object;
    var refCleanups = 0, layoutCleanups = 0, passiveCleanups = 0;
    var aliveInRef = false, aliveInLayout = false, aliveInPassive = false;
    function Detached() {
      var ref = React.useRef(null);
      React.useLayoutEffect(function () {
        object = ref.current;
        assert(valid(object), 'detached host is alive at layout mount');
        return function () { layoutCleanups++; aliveInLayout = valid(object); };
      }, []);
      React.useEffect(function () {
        return function () { passiveCleanups++; aliveInPassive = valid(object); };
      }, []);
      return element({ ctor: G.Node, ref: function (value) {
        ref.current = value;
        if (value) return function () { refCleanups++; aliveInRef = valid(value); };
      }});
    }
    renderer.render(h(Detached));
    renderer.flush();
    assert(valid(object), 'detached host was created');
    assert(!call(object, 'is_inside_tree'), 'cleanup case uses a truly detached mount');
    renderer.unmount();
    renderer.flush();
    assert(valid(object) && renderer.getStats().releaseRequested === 0, 'explicit flush waits for the full native stack to unwind');
    assert((await renderer.close()).status === 'complete', 'detached root close confirms native retirement');
    var stats = renderer.getStats();
    renderer.shutdown();
    renderer.shutdown();
    var finalStats = renderer.getStats();
    assert(refCleanups === 1 && layoutCleanups === 1 && passiveCleanups === 1, 'each cleanup runs exactly once');
    assert(aliveInRef && aliveInLayout && aliveInPassive, 'native host survives every cleanup');
    assert(!valid(object), 'detached host is invalid after release');
    assert(stats.releaseRequested === 1 && stats.freed === 1 && stats.pendingReleases === 0, 'single actual native destruction');
    assert(finalStats.freed === 1 && finalStats.releaseRequested === 1, 'repeated shutdown cannot release twice');
    assert(valid(borrowed), 'borrowed mount survives shutdown');
    state.detached = {
      done: true, passed: true, refCleanups: refCleanups,
      layoutCleanups: layoutCleanups, passiveCleanups: passiveCleanups,
      aliveInRef: aliveInRef, aliveInLayout: aliveInLayout, aliveInPassive: aliveInPassive,
      validAfterFree: valid(object), releaseRequested: finalStats.releaseRequested,
      freed: finalStats.freed, pendingReleases: finalStats.pendingReleases,
      cleanExit: finalStats.cleanExit
    };
  });

  attempt('opaque', async function () {
    var borrowed = mount(), renderer = root(borrowed);
    var owner = new G.Node(), childMount = new G.Node(), nativeChild = new G.Node();
    call(owner, 'add_child', childMount);
    var adoptedRef = React.createRef(), portalObject;
    var cleanupCount = 0, ownerAliveAtCleanup = false, portalAliveAtCleanup = false;
    function adopted() {
      return element({ key: 'opaque-owner', object: owner, ownership: 'adopt', childScope: 'native-owned-opaque', ref: adoptedRef });
    }
    function PortalContent() {
      var ref = React.useRef(null);
      React.useEffect(function () {
        portalObject = ref.current;
        return function () {
          cleanupCount++;
          ownerAliveAtCleanup = valid(owner);
          portalAliveAtCleanup = valid(portalObject);
        };
      }, []);
      return element({ ctor: G.Node, ref: ref });
    }
    renderer.render(adopted());
    renderer.flush();
    assert(adoptedRef.current === owner, 'adoption preserves the real native object');
    // The opaque owner can create additional public children at runtime.
    call(owner, 'add_child', nativeChild);
    renderer.render(h(React.Fragment, null, adopted(), renderer.portal(h(PortalContent), childMount, 'opaque-portal')));
    renderer.flush();
    assert(valid(portalObject) && call(portalObject, 'get_parent') === childMount, 'portal is in its registered borrowed mount');
    renderer.shutdown();
    renderer.flush();
    assert(valid(owner) && valid(portalObject), 'explicit shutdown preserves owner and portal until the release checkpoint');
    assert((await renderer.close()).status === 'complete', 'opaque root close confirms native retirement');
    var stats = renderer.getStats();
    assert(cleanupCount === 1 && ownerAliveAtCleanup && portalAliveAtCleanup, 'portal cleanup precedes owner release');
    assert(!valid(portalObject) && !valid(owner), 'React-owned portal node and adopted owner were released');
    assert(!valid(childMount) && !valid(nativeChild), 'opaque native children follow their owner lifetime');
    assert(valid(borrowed), 'opaque root mount remains borrowed');
    assert(stats.releaseRequested === 2 && stats.freed === 2 && stats.pendingReleases === 0, 'exactly two React-owned native releases');
    assert(stats.cleanExit && renderer.getErrors().length === 0, 'opaque/portal teardown is clean');
    state.opaque = {
      done: true, passed: true, adopted: stats.adopted,
      cleanupCount: cleanupCount, ownerAliveAtCleanup: ownerAliveAtCleanup,
      portalAliveAtCleanup: portalAliveAtCleanup, ownerValidAfter: valid(owner),
      mountValidAfter: valid(childMount), nativeChildValidAfter: valid(nativeChild),
      releaseRequested: stats.releaseRequested, freed: stats.freed,
      pendingReleases: stats.pendingReleases, cleanExit: stats.cleanExit
    };
  });

  attempt('rawSignal', async function () {
    var borrowed = mount(), renderer = root(borrowed), ref = React.createRef();
    renderer.render(element({ ctor: G.Button, ref: ref }));
    renderer.flush();
    var object = ref.current, calls = 0, aliveInCallback = false;
    call(object, 'connect', 'pressed', G.Callable.create(function () {
      calls++;
      renderer.unmount();
      renderer.flush();
      aliveInCallback = valid(object);
      assert(aliveInCallback && renderer.getStats().releaseRequested === 0, 'raw native signal cannot free its locked emitter');
    }));
    call(object, 'emit_signal', 'pressed');
    renderer.flush();
    assert(calls === 1 && valid(object), 'synchronous flush after emission still cannot attest stack unwinding');
    assert((await renderer.close()).status === 'complete', 'signal root close confirms native retirement');
    var stats = renderer.getStats();
    assert(!valid(object) && stats.freed === 1 && stats.releaseRequested === 1, 'raw signal host is destroyed exactly once after the checkpoint');
    assert(stats.cleanExit && renderer.getErrors().length === 0, 'raw signal teardown has no swallowed native release error');
    renderer.shutdown();
    state.rawSignal = { done: true, passed: true, calls: calls, aliveInCallback: aliveInCallback,
      validAfterFree: valid(object), freed: stats.freed, releaseRequested: stats.releaseRequested, cleanExit: stats.cleanExit };
  });

  attempt('phase', function () {
    rootA = root(mount());
    rootB = root(mount());
    assert(rootA.session === rootB.session, 'all roots use one EngineSession');
    rootB.render(element({ ctor: G.Node, native: { name: 'before' }, ref: phaseRef }));
    rootB.flush();
    assert(valid(phaseRef.current), 'phase target exists');
    var initialCommits = rootB.getStats().commits;
    function PhysicsDriver() {
      R.useFrame('physics', function () {
        if (state.phase.attempted) return;
        state.phase.attempted = true;
        var beforeName = String(call(phaseRef.current, 'get', 'name'));
        rootB.render(element({ ctor: G.Node, native: { name: 'after' }, ref: phaseRef }));
        rootB.flush();
        var duringName = String(call(phaseRef.current, 'get', 'name'));
        var commitsDuring = rootB.getStats().commits;
        state.phase.beforeName = beforeName;
        state.phase.duringName = duringName;
        state.phase.commitsBefore = initialCommits;
        state.phase.commitsDuring = commitsDuring;
        state.phase.sharedSession = true;
        assert(beforeName === 'before' && duringName === 'before', 'cross-root physics cannot apply pending props');
        assert(commitsDuring === initialCommits, 'cross-root flush performs no physics commit');
      });
      return null;
    }
    rootA.render(h(PhysicsDriver));
    rootA.flush();
  });

  return {
    physics: function () {
      if (disposed || state.phase.done || !rootA) return;
      try { rootA.physics(1 / 60); }
      catch (value) { record(value); state.phase.done = true; state.phase.passed = false; }
    },
    process: function () {
      if (disposed || state.phase.done || !state.phase.attempted || !rootB) return;
      attempt('phase', function () {
        rootB.process(1 / 60);
        rootB.flush();
        state.phase.afterName = String(call(phaseRef.current, 'get', 'name'));
        state.phase.commitsAfter = rootB.getStats().commits;
        assert(state.phase.afterName === 'after', 'next process safe point applies pending props');
        assert(state.phase.commitsAfter > state.phase.commitsDuring, 'process produced the deferred commit');
        assert(rootA.getErrors().length === 0 && rootB.getErrors().length === 0, 'phase test has no React/native errors');
        state.phase.done = true;
        state.phase.passed = true;
      });
    },
    results: function () {
      return {
        passed: state.detached.passed && state.opaque.passed && state.rawSignal.passed && state.phase.done && state.phase.passed && state.errors.length === 0,
        detached: Object.assign({}, state.detached), phase: Object.assign({}, state.phase),
        opaque: Object.assign({}, state.opaque), errors: state.errors.slice(),
        rawSignal: Object.assign({}, state.rawSignal),
        extendedPassed: state.propertyWrites.passed && state.errorForwarding.passed && state.extendedErrors.length === 0,
        propertyWrites: Object.assign({}, state.propertyWrites),
        errorForwarding: Object.assign({}, state.errorForwarding),
        extendedErrors: state.extendedErrors.slice(),
        ...(disposed ? {cleanup: roots.map(function (renderer) { return renderer.getCloseProgress(); })} : {})
      };
    },
    dispose: function () {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = Promise.all(roots.map(function (renderer) { return renderer.close(); })).then(function (results) {
        assert(results.every(function (result) { return result.status === 'complete'; }), 'all fixture roots confirm actual native retirement');
        return new Promise(function (resolve, reject) {
          require('godot-jsb').internal.native_runtime.scheduleCheckpoint(function () {
            try {
              for (var j = mounts.length - 1; j >= 0; j--) if (valid(mounts[j])) call(mounts[j], 'free');
              resolve();
            } catch (value) { reject(value); }
          });
        });
      });
      return disposePromise;
    }
  };
};
