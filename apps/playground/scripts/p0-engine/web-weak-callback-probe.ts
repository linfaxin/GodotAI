// Deterministically reproduce WeakRef death before FinalizationRegistry delivery.
// This fixture deliberately controls Web backend internals; it is not app code.
declare const require: (id: string) => any;
const G = require('godot');
const call = (object: any, name: string, ...args: any[]) =>
    (object[name] ?? object[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]).apply(object, args);
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };

export default class P0WebWeakCallbackProbe extends G.Node {
    _ready() {
        const runtime = (globalThis as any)._jsbb_;
        let simulatedDeaths = 0, deliveredFinalizers = 0, generationReplays = 0;
        const bindingStates: any[] = [];
        try {
            assert(runtime?.engine && runtime.interop?.gc_callback, 'Web backend is required');
            const engine = runtime.engine;
            const entries: any[] = engine.handles._handles;
            const nativeOpaque = (wrapper: any) => {
                const values = Object.getOwnPropertySymbols(wrapper).map(symbol => wrapper[symbol]);
                const opaque = values.find(value => typeof value === 'number' && Number.isInteger(value) && value !== 0);
                assert(opaque !== undefined, 'wrapper InternalDataID was not found');
                return opaque;
            };
            const deliver = (opaque: number) => {
                // Match the registry's bookkeeping before calling the actual
                // WASM finalizer. No browser GC scheduling is involved.
                const registry = engine._registry;
                const token = registry.tokens.get(opaque);
                assert(token, 'pending registry token was not found');
                registry.watcher.unregister(token);
                registry.tokens.delete(opaque);
                --registry._count;
                runtime.interop.gc_callback(engine.opaque, opaque);
                ++deliveredFinalizers;
            };

            for (let iteration = 0; iteration < 32; ++iteration) {
                const old = new G.RefCounted();
                const objectID = call(old, 'get_instance_id');
                const oldOpaque = nativeOpaque(old);
                const matching = entries.map((entry, index) => ({entry, index}))
                    .filter(({entry}) => entry && entry.sref === undefined && entry.token.deref() === old);
                assert(matching.length === 1, 'expected one weak binding handle');

                // Keep the wrapper itself rooted, but make the backend observe
                // the exact state seen after GC and before its registry job.
                matching[0].entry.token = {deref: () => undefined};
                ++simulatedDeaths;
                const fresh = G.instance_from_id(objectID);
                bindingStates.push({iteration, referenceCountAfterRebind: call(fresh, 'get_reference_count'),
                    strongHandlesAfterRebind: entries.filter(entry => entry && entry.sref === fresh).length});
                assert(fresh && fresh !== old, 'a collected wrapper must be rebound');
                assert(G.is_instance_valid(fresh), 'replacement must be alive before the old finalizer');
                assert(entries[matching[0].index] === undefined, 'retired weak handle entry leaked');

                // Old Global::Reset must already have canceled this native
                // callback, even though its WeakRef no longer had a target.
                deliver(oldOpaque);
                assert(G.is_instance_valid(fresh), 'late old finalizer invalidated the new binding');
                assert(String(call(fresh, 'get_instance_id')) === String(objectID), 'late finalizer changed the object identity');

                // Replaying a fully finalized generational ID must not touch
                // whichever InternalData slot the next allocation now uses.
                const next = new G.RefCounted();
                const nextID = call(next, 'get_instance_id');
                runtime.interop.gc_callback(engine.opaque, oldOpaque);
                ++generationReplays;
                assert(G.is_instance_valid(next) && G.is_instance_valid(fresh), 'replayed finalizer reached a reused slot');
                deliver(nativeOpaque(next));
                assert(G.instance_from_id(nextID) === null, 'controlled real weak callback must finalize its native object');
                deliver(nativeOpaque(fresh));
                assert(G.instance_from_id(objectID) === null, 'replacement cleanup must release its native object');
            }
            console.log('P0_WEB_WEAK_CALLBACK_REPORT ' + JSON.stringify({status: 'passed', simulatedDeaths, deliveredFinalizers, generationReplays, bindingStates}));
            call(call(this, 'get_tree'), 'quit', 0);
        } catch (error) {
            console.log('P0_WEB_WEAK_CALLBACK_REPORT ' + JSON.stringify({status: 'failed', simulatedDeaths, deliveredFinalizers, generationReplays, bindingStates, error: String(error), stack: (error as any)?.stack}));
            call(call(this, 'get_tree'), 'quit', 1);
        }
    }
}
