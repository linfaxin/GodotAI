// Resolve every actual registered class strictly through its advertised alias.
// No public-type filter or raw-name fallback is allowed in this inventory.
declare const require: (id: string) => any;
const G = require('godot');
const names = require('godot-jsb').internal.names;
const type = (name: string) => G[names.get_class(name)];
const call = (object: any, name: string, ...args: any[]) => {
    const method = object[names.get_member(name)];
    if (typeof method !== 'function') throw Error('Missing method alias: ' + name);
    return method.apply(object, args);
};

export default class CamelInventoryNativeProbe extends G.Node {
    _ready() {
        const marker = 'P0_CAMEL_INVENTORY_NATIVE_REPORT ';
        const failures: any[] = [], collisions: any[] = [], inventory: any[] = [], roundtripMismatches: any[] = [], skippedEditorClasses: any[] = [];
        try {
            const camel = call(type('ProjectSettings'), 'get_setting', 'GodotJS/runtime/core/camel_case_bindings_enabled', false);
            if (!camel) throw Error('Camel bindings must be enabled by project settings');
            const classDB = type('ClassDB');
            const registered = call(classDB, 'get_class_list');
            const originalNames = Array.from({length: Number(call(registered, 'size'))}, (_, index) =>
                String(call(registered, 'get_indexed', index))).sort();
            if (!originalNames.length) throw Error('Actual ClassDB inventory is empty');
            const owners = new Map<string, string>();
            // ClassDB.APIType: editor-only APIs require an editor context.
            // Their aliases still participate in every collision/roundtrip check.
            const API_EDITOR = 1, API_EDITOR_EXTENSION = 3;
            const checkRoundtrip = (originalName: string, publicName: string) => {
                const internalName = names.get_internal_mapping(publicName);
                if (internalName !== originalName) roundtripMismatches.push({originalName, publicName, internalName});
            };
            let eligibleRuntimeClasses = 0;
            for (const originalName of originalNames) {
                const publicName = names.get_class(originalName);
                const previous = owners.get(publicName);
                if (previous && previous !== originalName) collisions.push({publicName, originals: [previous, originalName]});
                else owners.set(publicName, originalName);
                const apiType = Number(call(classDB, 'class_get_api_type', originalName));
                if (apiType === API_EDITOR || apiType === API_EDITOR_EXTENSION) {
                    skippedEditorClasses.push({originalName, publicName, apiType});
                    inventory.push({originalName, publicName, apiType, context: 'editor'});
                    checkRoundtrip(originalName, publicName);
                    continue;
                }
                ++eligibleRuntimeClasses;
                try {
                    const value = G[publicName];
                    if (value === undefined || value === null) throw Error('Class alias did not resolve');
                    inventory.push({originalName, publicName, apiType, resolved: true});
                } catch (error) {
                    const failure = {originalName, publicName, error: String(error)};
                    failures.push(failure);
                    inventory.push({...failure, resolved: false});
                }
                checkRoundtrip(originalName, publicName);
            }
            const report = {status: failures.length === 0 && collisions.length === 0 && roundtripMismatches.length === 0 ? 'passed' : 'failed',
                camel: true, total: originalNames.length, resolved: inventory.filter(item => item.resolved).length,
                registeredTotal: originalNames.length, aliasRoundtrips: originalNames.length - roundtripMismatches.length,
                eligibleRuntimeClasses, resolvedRuntimeClasses: inventory.filter(item => item.resolved).length,
                skippedEditorClasses, failures, collisions, classNameRoundtrip: roundtripMismatches.length === 0, roundtripMismatches, inventory};
            console.log(marker + JSON.stringify(report));
            call(call(this, 'get_tree'), 'quit', report.status === 'passed' ? 0 : 1);
        } catch (error) {
            console.log(marker + JSON.stringify({status: 'failed', failures, collisions, roundtripMismatches, inventory, error: String(error), stack: (error as any)?.stack}));
            call(call(this, 'get_tree'), 'quit', 1);
        }
    }
}
