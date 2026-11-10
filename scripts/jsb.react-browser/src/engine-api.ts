/** Target-derived engine declarations. No editor, filesystem, React or Godot
 * runtime imports: the same consumer runs in Node and in the compiler worker. */
import { ENGINE_RUNTIME_DECLARATIONS } from './engine-api-runtime-types.js';
export const ENGINE_DECLARATIONS_VERSION = 'godotjs-engine-declarations/1';
export const ENGINE_NAMING_VERSION = 'godotjs-public-names/1';

export interface EngineApiProperty {
  nativeName: string; publicName: string; type: number; class_name?: string;
  hint?: number; hint_string?: string; usage?: number;
  binding?: 'property' | 'methods' | 'metadata'; getter?: string; setter?: string; index?: number;
}
export interface EngineApiDefault { type: number; text?: string; integer?: string; value?: string | boolean; className?: string; isNull?: boolean; items?: EngineApiDefault[]; entries?: { key: EngineApiDefault; value: EngineApiDefault }[] }
export interface EngineApiMethod {
  nativeName: string; publicName: string; flags: number; args: EngineApiProperty[];
  return: EngineApiProperty; hasReturnValue: boolean; defaultArgs: EngineApiDefault[];
  binding?: 'method' | 'accessor';
}
export interface EngineApiConstant { nativeName: string; publicName: string; integer?: string; value?: EngineApiDefault; enum?: string; enumPublicName?: string; enumValueName?: string; bitfield?: boolean }
export interface EngineApiEnum { nativeName: string; publicName: string; bitfield?: boolean }
export interface EngineApiClass {
  nativeName: string; publicName: string; parent: string; apiType: number;
  exposed: boolean; enabled: boolean; constructible: boolean; abstract: boolean; virtual: boolean;
  methods: EngineApiMethod[]; properties: EngineApiProperty[]; signals: EngineApiMethod[];
  constants: EngineApiConstant[]; enums: EngineApiEnum[];
}
export interface EngineApiBuiltin {
  nativeName: string; publicName: string; type: number; keyed: boolean; elementType?: number;
  bindingKind?: 'value'|'utility'|'unbound';
  bindingExtras?: {getIndexed?:string;setIndexed?:string;getKeyed?:string;setKeyed?:string;toArrayBuffer?:string;builtinType?:string};
  constructors: EngineApiMethod[]; methods: EngineApiMethod[]; properties: EngineApiProperty[];
  constants: EngineApiConstant[]; enums: EngineApiEnum[]; operators: { operator: number; rightType: number; returnType: number }[];
  bindingOperators?: {publicName: string; leftType: number; rightType: number; returnType: number; unary: boolean}[];
}
export interface EngineApiIR {
  schemaVersion: 1; apiVersion: 'godotjs-engine-api/1'; namingVersion: string;
  engineVersion: string; bindingVersion: string; bindingNaming: 'snake' | 'camel'; platform: string;
  modules: string[]; bindingPolicy: { excludeGetSetMethods: boolean; bigInt: boolean; sharedResources: boolean };
  classes: EngineApiClass[]; builtins: EngineApiBuiltin[]; utilities: EngineApiMethod[];
  globalConstants: EngineApiConstant[]; singletons: { nativeName: string; publicName: string; className: string }[];
  [key: string]: unknown;
}

const fail = (message: string): never => { throw Error('E_ENGINE_API: ' + message); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected object');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail('Expected array');
const text = (value: unknown): string => typeof value === 'string' ? value : fail('Expected string');
const lex = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ident = (value: string) => /^[A-Za-z_$][\w$]*$/.test(value);
const key = (value: string) => JSON.stringify(value);

/** Validation preserves the snapshot's JSON meaning; no target/editor merging. */
export function parseEngineApi(value: unknown): EngineApiIR {
  const inspect = (item: unknown, depth = 0): void => {
    if (depth > 48) fail('Metadata nesting limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Non-finite metadata number'); return; }
    if (!item || typeof item !== 'object') fail('Metadata must be JSON');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('Metadata must use plain objects');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set) fail('Metadata accessors are not accepted');
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(value);
  const api = record(value);
  if (api.schemaVersion !== 1 || api.apiVersion !== 'godotjs-engine-api/1' || !['snake', 'camel'].includes(String(api.bindingNaming))) fail('Unsupported API schema');
  for (const field of ['engineVersion', 'bindingVersion', 'namingVersion', 'platform']) text(api[field]);
  for (const module of list(api.modules)) text(module);
  const seen = new Set<string>();
  const property = (value: unknown): void => {
    const field = record(value); text(field.nativeName); text(field.publicName);
    if (!Number.isInteger(field.type) || Number(field.type) < 0 || Number(field.type) > 255) fail('Invalid Variant type');
  };
  const method = (value: unknown): void => {
    const member = record(value); text(member.nativeName); text(member.publicName);
    if (!Number.isInteger(member.flags) || typeof member.hasReturnValue !== 'boolean') fail('Invalid method metadata');
    for (const arg of list(member.args)) property(arg);
    property(member.return); list(member.defaultArgs);
    if (list(member.defaultArgs).length > list(member.args).length) fail('Too many method defaults');
  };
  for (const value of list(api.classes)) {
    const cls = record(value), name = text(cls.nativeName);
    if (seen.has(name)) fail('Duplicate class ' + name); seen.add(name);
    text(cls.publicName); text(cls.parent);
    for (const item of list(cls.methods)) method(item);
    for (const item of list(cls.signals)) method(item);
    for (const item of list(cls.properties)) property(item);
    for (const memberList of ['constants', 'enums']) list(cls[memberList]);
  }
  for (const field of ['builtins', 'utilities', 'globalConstants', 'singletons']) list(api[field]);
  for (const item of list(api.builtins)) {
    const builtin = record(item); text(builtin.nativeName); text(builtin.publicName);
    if (!Number.isInteger(builtin.type)) fail('Invalid builtin type');
    if(builtin.bindingKind!==undefined&&!['value','utility','unbound'].includes(String(builtin.bindingKind)))fail('Invalid builtin binding kind');
    if(builtin.bindingExtras!==undefined)for(const name of Object.values(record(builtin.bindingExtras)))text(name);
    for (const field of ['constructors', 'methods']) for (const item of list(builtin[field])) method(item);
    for (const item of list(builtin.properties)) property(item);
    for (const field of ['constants', 'enums', 'operators']) list(builtin[field]);
    if (builtin.bindingOperators !== undefined) for (const item of list(builtin.bindingOperators)) {
      const operation=record(item);text(operation.publicName);
      if(typeof operation.unary!=='boolean'||!['leftType','rightType','returnType'].every(key=>Number.isInteger(operation[key])))fail('Invalid binding operator');
    }
  }
  for (const item of list(api.utilities)) method(item);
  record(api.bindingPolicy);
  return JSON.parse(JSON.stringify(value)) as EngineApiIR;
}

/** Named collections are sets; argument/default/constructor ordering is semantic. */
export function canonicalEngineApi(api: EngineApiIR): string {
  const named = new Set(['classes', 'methods', 'properties', 'signals', 'constants', 'enums', 'utilities', 'globalConstants', 'singletons']);
  const write = (value: unknown, field = ''): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      let entries = value;
      if (named.has(field)) entries = [...value].sort((a, b) => lex(String(a.nativeName), String(b.nativeName)));
      else if (field === 'modules') entries = [...value].sort();
      else if (field === 'builtins') entries = [...value].sort((a, b) => Number(a.type) - Number(b.type));
      return '[' + entries.map(item => write(item)).join(',') + ']';
    }
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(name => key(name) + ':' + write(object[name], name)).join(',') + '}';
  };
  return write(api);
}

export interface EngineDeclarations {
  files: Record<string, string>;
  coverage: { classes: number; builtins: number; properties: number; methods: number; signals: number; utilities: number; singletons: number; enums: number; operators: number };
  diagnostics: { code: string; message: string; nativeName?: string }[];
}

export function generateEngineDeclarations(input: EngineApiIR): EngineDeclarations {
  const api = JSON.parse(canonicalEngineApi(parseEngineApi(input))) as EngineApiIR;
  const diagnostics: EngineDeclarations['diagnostics'] = [];
  const coverage = { classes: 0, builtins: 0, properties: 0, methods: 0, signals: 0, utilities: 0, singletons: 0, enums: 0, operators: 0 };
  const classes = new Map(api.classes.map(cls => [cls.nativeName, cls]));
  const builtinById = new Map(api.builtins.map(cls => [cls.type, cls]));
  const builtinByName = new Map(api.builtins.map(cls => [cls.nativeName, cls]));
  const typeName = (native: string): string => classes.get(native)?.publicName ?? builtinByName.get(native)?.publicName ?? native;
  const objectName = typeName('Object');
  const arrayName = typeName('Array'), dictionaryName = typeName('Dictionary');
  const callableName = typeName('Callable'), signalName = typeName('Signal');
  const unknownTypes = new Set<string>();
  const unregisteredEnums = new Set<string>();
  const enumTypes = new Map<string, { path: string; bitfield: boolean; values: EngineApiConstant[] }>();
  for (const cls of [...api.classes, ...api.builtins]) for (const enumeration of cls.enums) {
    enumTypes.set(cls.nativeName + '.' + enumeration.nativeName, { path: cls.publicName + '.' + enumeration.publicName, bitfield: !!enumeration.bitfield, values: cls.constants.filter(value => value.enum === enumeration.nativeName) });
  }
  for (const constant of api.globalConstants) if (constant.enum) {
    const publicPath = constant.enumPublicName ?? constant.enum;
    if (!enumTypes.has(constant.enum)) enumTypes.set(constant.enum, { path: publicPath, bitfield: !!constant.bitfield, values: [] });
    enumTypes.get(constant.enum)!.values.push({ ...constant, publicName: constant.enumValueName ?? constant.publicName });
  }
  const integer = (value: string): string => {
    const parsed = BigInt(value);
    return parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER) ? value + 'n' : value;
  };
  const refType = (name: string): string => {
    const scalar: Record<string, string> = { Nil: 'GAny', bool: 'boolean', int: 'int64', float: 'number', String: 'string', StringName: 'string', Variant: 'GAny' };
    if (scalar[name]) return scalar[name];
    if (enumTypes.has(name)) return enumTypes.get(name)!.path;
    if (classes.has(name) || builtinByName.has(name)) return typeName(name);
    const array = /^Array\[(.*)\]$/.exec(name);
    if (array) return `${arrayName}<${refType(array[1])}>`;
    if (name.includes(',')) return name.split(',').filter(value => !value.trim().startsWith('-')).map(value => refType(value.trim())).join(' | ') || objectName;
    if (name) { unknownTypes.add(name); return '__OpaqueNative_' + name.replace(/\W/g, '_'); }
    return objectName;
  };
  const hintType = (hint: string): string => {
    const tail = hint.split(':').at(-1) ?? '';
    if (/^\d+(?:\/\d+)?$/.test(tail)) return variantType({ type: Number(tail.split('/')[0]), nativeName: '', publicName: '' });
    return refType(tail || 'Variant');
  };
  const variantType = (property: EngineApiProperty, output = false): string => {
    const builtin = builtinById.get(property.type), name = builtin?.nativeName;
    if (property.class_name && !property.class_name.includes(',')) {
      if (name === 'int' && !enumTypes.has(property.class_name) && !['int', 'float', 'bool'].includes(property.class_name)) {
        unregisteredEnums.add(property.class_name); return 'int64';
      }
      const specific = refType(property.class_name);
      return output && name === 'Object' ? specific + ' | null' : specific;
    }
    if (name === 'Object') {
      const names = property.class_name || property.hint_string;
      const type = names ? refType(names) : objectName;
      return output ? `(${type}) | null` : type + ' | null';
    }
    if (name === 'Array' && property.hint_string && property.hint === 31) return `${arrayName}<${hintType(property.hint_string)}>`;
    if (name === 'Dictionary' && property.hint_string && property.hint_string.includes(';')) {
      const [left, right] = property.hint_string.split(';'); return `${dictionaryName}<${hintType(left)}, ${hintType(right)}>`;
    }
    return refType(name ?? 'Variant');
  };
  const parameters = (method: EngineApiMethod): string => {
    const optional = method.args.length - method.defaultArgs.length;
    const args = method.args.map((arg, i) => `arg${i}${i >= optional ? '?' : ''}: ${variantType(arg)}`);
    if (method.flags & 16) args.push('...rest: GAny[]');
    return args.join(', ');
  };
  const returnType = (method: EngineApiMethod) => method.hasReturnValue ? variantType(method.return, true) : 'void';
  const methodSignature = (method: EngineApiMethod): string => `(${parameters(method)}) => ${returnType(method)}`;
  const callbackSignature = (method: EngineApiMethod): string => `(${parameters(method)}) => void`;
  const isStatic = (method: EngineApiMethod) => !!(method.flags & 32);
  const findMethod = (nativeClass: string, nativeMethod: string): EngineApiMethod | undefined => {
    const visited = new Set<string>();
    for (let cls = classes.get(nativeClass); cls && !visited.has(cls.nativeName); cls = classes.get(cls.parent)) {
      visited.add(cls.nativeName); const method = cls.methods.find(method => method.nativeName === nativeMethod); if (method) return method;
    }
    return undefined;
  };
  const makeMembers = (methods: EngineApiMethod[], properties: EngineApiProperty[], signals: EngineApiMethod[], nativeClass = '') => {
    const entries = new Map<string, string>();
    for (const property of properties) {
      if (property.binding && property.binding !== 'property') continue;
      if ((property.usage ?? 0) & (64 | 128 | 256)) continue;
      const readonly = property.getter && !property.setter ? 'readonly ' : '';
      const getter = property.getter ? findMethod(nativeClass, property.getter) : undefined;
      // Inspector enum labels do not carry the native enum class. The actual
      // getter signature does, and is part of the same target metadata.
      const precise = !property.class_name && getter?.return.class_name ? { ...property, class_name: getter.return.class_name } : property;
      entries.set(property.publicName, `${readonly}[${key(property.publicName)}]: ${variantType(precise, true)};`); coverage.properties++;
    }
    for (const method of methods) {
      if (isStatic(method) || method.binding === 'accessor') continue;
      entries.set(method.publicName, `[${key(method.publicName)}](${parameters(method)}): ${returnType(method)};`); coverage.methods++;
    }
    for (const signal of signals) {
      entries.set(signal.publicName, `readonly [${key(signal.publicName)}]: ${signalName}<${callbackSignature(signal)}>;`); coverage.signals++;
    }
    return entries;
  };
  const lines = [`// ${ENGINE_DECLARATIONS_VERSION}; target ${api.engineVersion}; ${api.bindingNaming}.`, 'declare module "godot" {',
    'export type int64 = number | bigint;', 'export type int32 = number;', 'export type byte = number;', 'export type float32 = number;', 'export type float64 = number;', 'export type StringName = string;',
    'export type GAny = unknown;',
    'export const ProxyTarget: unique symbol;',
    'export const FloatType: unique symbol;', 'export const IntegerType: unique symbol;',
    'export type NativeConstructor<T> = {new(): T; readonly prototype: T};',
    'export type AbstractNativeConstructor<T> = (abstract new () => T) & {readonly prototype: T};',
    'type __Omit<T, K extends PropertyKey> = Pick<T, Exclude<keyof T, K>>;',
    'type __Wrap<T> = T extends readonly (infer E)[] ? ' + arrayName + '<__Wrap<E>> : T extends Record<string, unknown> ? ' + dictionaryName + '<{[K in keyof T]: __Wrap<T[K]>}> : T;',
    'type __Unwrap<T> = T extends ' + arrayName + '<infer E> ? ReadonlyArray<__Unwrap<E>> : T extends ' + dictionaryName + '<infer K,infer V> ? __DictProxy<K,V> : T;',
    'type __DictProxy<K,V> = Readonly<K extends Record<string, unknown> ? {[P in keyof K]: __Unwrap<K[P]>} : K extends string ? Record<K,__Unwrap<V>> : Record<string,unknown>>;',
    'type __DictKey<K> = K extends Record<string, unknown> ? keyof K : K;',
    'type __DictValue<K,V,P> = K extends Record<string, unknown> ? P extends keyof K ? K[P] : never : V;',
  ];
  const enumNamespaces = new Map<string, string[]>();
  const enumObjects = new Map<string, string[]>();
  for (const value of enumTypes.values()) {
    const segments = value.path.split('.');
    if (segments.some(segment => !ident(segment))) { diagnostics.push({ code: 'E_ENGINE_ENUM_NAME', message: 'Invalid enum name ' + value.path }); continue; }
    const name = segments.pop()!, parent = segments.join('.');
    const values = value.values.map(constant => constant.integer ?? constant.value?.integer).filter((item): item is string => typeof item === 'string');
    const body = [`export type ${name} = ${value.bitfield ? 'int64' : [...new Set(values.map(integer))].join(' | ') || 'number'};`];
    const list = enumNamespaces.get(parent) ?? []; list.push(...body); enumNamespaces.set(parent, list); coverage.enums++;
    const object = `{${value.values.map(constant => `readonly [${key(constant.publicName)}]: ${integer(constant.integer ?? constant.value?.integer ?? '0')};`).join('')}}`;
    const objects = enumObjects.get(parent) ?? []; objects.push(`readonly [${key(name)}]: ${object};`); enumObjects.set(parent, objects);
    if (!parent) lines.push(`export const ${name}: ${object};`);
  }
  const ownMemberCache = new Map<string, Map<string, string>>();
  const effectiveMemberCache = new Map<string, Map<string, string>>();
  const ownMembers = (cls: EngineApiClass): Map<string, string> => {
    let members = ownMemberCache.get(cls.nativeName);
    if (!members) { members = makeMembers(cls.methods, cls.properties, cls.signals, cls.nativeName); ownMemberCache.set(cls.nativeName, members); }
    return members;
  };
  const effectiveMembers = (cls: EngineApiClass, stack = new Set<string>()): Map<string, string> => {
    const cached = effectiveMemberCache.get(cls.nativeName); if (cached) return cached;
    if (stack.has(cls.nativeName)) return fail('Cyclic native inheritance'); stack.add(cls.nativeName);
    const parent = classes.get(cls.parent), members = new Map(parent ? effectiveMembers(parent, stack) : []);
    for (const [key, value] of ownMembers(cls)) members.set(key, value);
    stack.delete(cls.nativeName); effectiveMemberCache.set(cls.nativeName, members); return members;
  };
  // Reflect signature overrides faithfully. The few native classes replacing
  // a base return type (e.g. boolean -> Variant) compose their exact member map;
  // all other classes keep ordinary, method-preserving TypeScript inheritance.
  for (const cls of api.classes) {
    if (!ident(cls.publicName)) fail('Unsupported public class identifier ' + cls.publicName);
    const own = '__Own_' + cls.publicName, statics = '__Static_' + cls.publicName;
    const members = ownMembers(cls);
    const isSingletonClass = api.singletons.some(singleton => singleton.nativeName === cls.nativeName);
    if (isSingletonClass) for (const [i, value] of (enumObjects.get(cls.publicName) ?? []).entries()) members.set('__singleton_enum_' + i, value);
    lines.push(`interface ${own} {`, ...members.values(), '}');
    const parent = classes.get(cls.parent)?.publicName;
    const parentClass = classes.get(cls.parent), inherited = parentClass ? effectiveMembers(parentClass) : new Map<string, string>();
    const changed = [...members].some(([name, value]) => inherited.has(name) && inherited.get(name) !== value);
    if (parent && changed) {
      lines.push(`export interface ${cls.publicName} extends __Omit<${parent}, keyof ${own}> {`, ...effectiveMembers(cls).values(), '}');
    } else lines.push(`export interface ${cls.publicName}${parent ? ` extends ${parent}` : ''} {`, ...members.values(), '}');
    const staticMembers = cls.methods.filter(isStatic).map(method => `[${key(method.publicName)}]${parameters(method) ? '(' + parameters(method) + ')' : '()'}: ${returnType(method)};`);
    staticMembers.push(...(enumObjects.get(cls.publicName) ?? []));
    for (const constant of cls.constants.filter(value => !value.enum)) staticMembers.push(`readonly [${key(constant.publicName)}]: ${integer(constant.integer ?? '0')};`);
    lines.push(`interface ${statics} {`, ...staticMembers, '}');
    const singleton = api.singletons.find(value => value.publicName === cls.publicName);
    if (singleton) coverage.singletons++;
    const constructor = cls.constructible ? `NativeConstructor<${cls.publicName}>` : `AbstractNativeConstructor<${cls.publicName}>`;
    lines.push(`export const ${cls.publicName}: ${singleton ? refType(singleton.className) : constructor}${parent && !singleton ? ` & __Omit<typeof ${parent}, "prototype" | keyof ${statics}>` : ''} & ${statics};`);
    coverage.classes++;
  }
  for (const builtin of api.builtins) {
    if(builtin.bindingKind==='utility') {
      lines.push(`export const ${builtin.publicName}: {`);
      for(const method of builtin.methods)lines.push(`[${key(method.publicName)}](${isStatic(method)?'':'self: string'+(parameters(method)?', ':'')}${parameters(method)}): ${returnType(method)};`);
      lines.push(...(enumObjects.get(builtin.publicName)??[]));
      for(const constant of builtin.constants.filter(value=>!value.enum))lines.push(`readonly [${key(constant.publicName)}]: ${variantType({type:constant.value?.type??0,nativeName:'',publicName:''})};`);
      lines.push('};');coverage.builtins++;continue;
    }
    if (builtin.bindingKind==='unbound'||['Nil', 'bool', 'int', 'float', 'String', 'StringName', 'Object'].includes(builtin.nativeName)) continue;
    const name = builtin.publicName;
    if (!ident(name)) fail('Unsupported builtin identifier ' + name);
    const special = ['Array', 'Dictionary', 'Callable', 'Signal'].includes(builtin.nativeName);
    const generic = builtin.nativeName === 'Array' ? '<T = GAny>' : builtin.nativeName === 'Dictionary' ? '<K = GAny, V = GAny>' : special ? '<F extends (...args: any[]) => any = (...args: any[]) => any>' : '';
    const members = makeMembers(builtin.methods, builtin.properties, []);
    const extras=builtin.bindingExtras;
    const extraNames:Record<string,string|undefined>={get_indexed:extras?.getIndexed,set_indexed:extras?.setIndexed,get_keyed:extras?.getKeyed,set_keyed:extras?.setKeyed};
    const override = (native: string, declaration: string) => {
      const publicName = builtin.methods.find(method => method.nativeName === native)?.publicName ?? extraNames[native];
      if(!publicName)return;
      members.delete(publicName); members.set(publicName, declaration.replaceAll('$name', key(publicName)));
    };
    if (builtin.nativeName === 'Array') {
      for (const method of ['get', 'get_indexed', 'front', 'back', 'pick_random', 'pop_back', 'pop_front', 'pop_at']) override(method, `[$name](${['get', 'get_indexed', 'pop_at'].includes(method) ? 'index: int64' : ''}): T;`);
      for (const method of ['set', 'set_indexed']) override(method, '[$name](index: int64, value: T): void;');
      for (const method of ['push_back', 'push_front', 'append', 'fill']) override(method, '[$name](value: T): void;');
      for (const method of ['duplicate', 'slice', 'filter']) { const source = builtin.methods.find(value => value.nativeName === method); if (source) override(method, `[$name](${parameters(source)}): ${name}<T>;`); }
      members.set('iterator', '[Symbol.iterator](): IterableIterator<T>;');
      members.set('proxy', `proxy<Write extends boolean = false>(): (Write extends true ? __Unwrap<T>[] : ReadonlyArray<__Unwrap<T>>) & {readonly [ProxyTarget]: ${name}<T>};`);
    } else if (builtin.nativeName === 'Dictionary') {
      override('get', '[$name]<P extends __DictKey<K>>(key: P, defaultValue?: V): __DictValue<K,V,P> | null;');
      override('get_keyed', '[$name]<P extends __DictKey<K>>(key: P): __DictValue<K,V,P> | null;');
      override('set', '[$name]<P extends __DictKey<K>>(key: P, value: __DictValue<K,V,P>): boolean;');
      override('set_keyed', '[$name]<P extends __DictKey<K>>(key: P, value: __DictValue<K,V,P>): void;');
      members.set('iterator', '[Symbol.iterator](): IterableIterator<{key: __DictKey<K>; value: V}>;');
      members.set('proxy', `proxy<Write extends boolean = false>(): (Write extends true ? {-readonly [P in keyof __DictProxy<K,V>]: __DictProxy<K,V>[P]} : __DictProxy<K,V>) & {readonly [ProxyTarget]: ${name}<K,V>};`);
    } else if (builtin.nativeName === 'Callable') {
      override('call', '[$name](...args: Parameters<F>): ReturnType<F>;');
      override('callv', `[$name](args: ${arrayName}<GAny>): ReturnType<F>;`);
      members.set('create', '');
    } else if (builtin.nativeName === 'Signal') {
      override('connect', `[$name](callback: ${callableName}<F>, flags?: int64): ${refType('Error')};`);
      override('disconnect', `[$name](callback: ${callableName}<F>): void;`);
      override('emit', '[$name](...args: Parameters<F>): void;');
      members.set('asPromise', `[${key(api.bindingNaming==='camel'?'asPromise':'as_promise')}](): Promise<Parameters<F> extends [] ? undefined : Parameters<F> extends [infer P] ? P : Parameters<F>>;`);
    }
    if(extras?.getIndexed)members.set(extras.getIndexed,`[${key(extras.getIndexed)}](index:number): ${builtin.nativeName==='Array'?'T':variantType({type:builtin.elementType??0,nativeName:'',publicName:''})};`);
    if(extras?.setIndexed)members.set(extras.setIndexed,`[${key(extras.setIndexed)}](index:number,value:${builtin.nativeName==='Array'?'T':variantType({type:builtin.elementType??0,nativeName:'',publicName:''})}): void;`);
    if(extras?.toArrayBuffer)members.set(extras.toArrayBuffer,`[${key(extras.toArrayBuffer)}](): ArrayBuffer;`);
    lines.push(`export interface ${name}${generic} {`, ...members.values(), '}');
    const instance = name + (builtin.nativeName === 'Array' ? '<T>' : builtin.nativeName === 'Dictionary' ? '<K,V>' : special ? '<F>' : '');
    const constructors = builtin.constructors.map(method => `new${generic}(${parameters(method)}): ${instance};`);
    if (builtin.nativeName === 'Array') constructors.push(`new<T>(values: readonly T[]): ${name}<T>;`, `create<T>(values: readonly T[]): ${name}<__Wrap<T>>;`);
    if (builtin.nativeName === 'Dictionary') constructors.push(`create<T extends Record<string, unknown>>(values: T): ${name}<{[P in keyof T]: __Wrap<T[P]>}>;`);
    if (builtin.nativeName === 'Callable') constructors.push(`create<F extends (...args: any[]) => any>(callback: F): ${name}<F>;`, `create<S extends ${objectName}, F extends (this: S, ...args: any[]) => any>(self: S, callback: F): ${name}<F>;`);
    for (const method of builtin.methods.filter(isStatic)) constructors.push(`[${key(method.publicName)}](${parameters(method)}): ${returnType(method)};`);
    for (const operation of builtin.bindingOperators ?? []) {
      const type = (id: number) => variantType({type:id,nativeName:'',publicName:''});
      constructors.push(`[${key(operation.publicName)}](left: ${type(operation.leftType)}${operation.unary ? '' : `, right: ${type(operation.rightType)}`}): ${type(operation.returnType)};`);
      coverage.operators++;
    }
    constructors.push(...(enumObjects.get(name) ?? []));
    if(extras?.builtinType)constructors.push(`readonly [${key(extras.builtinType)}]: ${builtin.type};`);
    for (const constant of builtin.constants.filter(value => !value.enum)) {
      const type = constant.value?.type;
      constructors.push(`readonly [${key(constant.publicName)}]: ${type === 2 && constant.value?.integer ? integer(constant.value.integer) : variantType({ type: type ?? 0, nativeName: '', publicName: '' })};`);
    }
    lines.push(`export const ${name}: {`, ...constructors, `readonly prototype: ${name};`, '};'); coverage.builtins++;
  }
  for (const [parent, body] of enumNamespaces) {
    if (parent) { for (const segment of parent.split('.')) lines.push(`export namespace ${segment} {`); lines.push(...body); lines.push(...parent.split('.').map(() => '}')); }
    else lines.push(...body);
  }
  for (const [parent, body] of enumObjects) if (parent && !api.classes.some(cls => cls.publicName === parent) && !api.builtins.some(cls => cls.publicName === parent)) {
    if (!parent.includes('.')) lines.push(`export const ${parent}: {`, ...body, '};');
  }
  for (const constant of api.globalConstants) {
    if (!ident(constant.publicName)) continue;
    lines.push(`export const ${constant.publicName}: ${integer(constant.integer ?? '0')};`);
  }
  for (const singleton of api.singletons) {
    if (api.classes.some(cls => cls.publicName === singleton.publicName)) continue;
    const native = refType(singleton.className);
    lines.push(`export const ${singleton.publicName}: ${native};`); coverage.singletons++;
  }
  for (const utility of api.utilities) {
    const local = '__utility_' + utility.publicName.replace(/\W/g, '_');
    lines.push(`function ${local}(${parameters(utility)}): ${returnType(utility)};`, `export {${local} as ${key(utility.publicName)}};`); coverage.utilities++;
  }
  lines.push('export function GLOBAL_GET(entryPath:string): GAny;', 'export function EDITOR_GET(entryPath:string): GAny;');
  for (const native of [...unknownTypes].sort()) {
    const name = '__OpaqueNative_' + native.replace(/\W/g, '_');
    lines.push(`/** Native opaque handle; not a constructible ClassDB class: ${native.replaceAll('*/', '')}. */`, `export interface ${name} extends ${objectName} { readonly __nativeOpaqueType: ${key(native)} }`);
    diagnostics.push({ code: 'I_ENGINE_OPAQUE_TYPE', message: 'Opaque native type represented without inventing a constructor', nativeName: native });
  }
  for (const native of [...unregisteredEnums].sort()) diagnostics.push({ code: 'I_ENGINE_UNREGISTERED_ENUM', message: 'Native integer enum has no registered public enumeration; represented as int64', nativeName: native });
  lines.push('}',
    'interface Console {log(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void; trace(...args: unknown[]): void; assert(condition: unknown, ...args: unknown[]): void}',
    'declare var console: Console;',
    'declare function setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;',
    'declare function clearTimeout(id: number): void;',
    'declare function setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;',
    'declare function clearInterval(id: number): void;',
    'declare function require(id: "godot"): typeof import("godot");',
    'declare function require(id: "godot-jsb"): typeof import("godot-jsb");',
    'declare function require(id: "godot.annotations"): typeof import("godot.annotations");',
    'declare function require(id: string): unknown;');
  const jsb = `declare module "godot-jsb" {
export const version: string; export const impl: string; export const TOOLS_ENABLED: boolean;
export function callable<F extends (...args: any[]) => any>(callback: F): import("godot").${callableName}<F>;
export function $import(id: string): Promise<unknown>;
export function to_array_buffer(bytes: import("godot").${typeName('PackedByteArray')}): ArrayBuffer;
export const internal: {get_engine_api(): unknown; names: {get_class(name:string):string; get_member(name:string):string; get_enum(name:string):string; get_enum_value(name:string):string; get_parameter(name:string):string; get_internal_mapping(name:string):string; get_variant_type(type:number):string}};
}
`;
  const helperAliases = api.bindingNaming === 'camel'
    ? 'rangeInt(min:number,max:number,step?:number,...hints:string[]):MemberDecorator; globalFile(filter:string):MemberDecorator; globalDir(filter:string):MemberDecorator; expEasing(hint?:""|"attenuation"|"positive_only"|"attenuation,positive_only"):MemberDecorator;'
    : '';
  const annotations = `declare module "godot.annotations" {
import type * as G from "godot";
export type NativeClass = abstract new (...args: any[]) => G.${objectName};
export type MemberDecorator = (value: any, context: ClassMemberDecoratorContext) => any;
export interface ExportOptions {class?: unknown; hint?: G.PropertyHint; ${api.bindingNaming === 'camel' ? 'hintString' : 'hint_string'}?: string; usage?: G.PropertyUsageFlags}
export interface RPCConfig {mode?: number; sync?: "call_remote"|"call_local"; transfer_mode?: number; transfer_channel?: number}
export interface ModernRPCConfig {mode?: number; sync?: "call_remote"|"call_local"; ${api.bindingNaming==='camel'?'transferMode':'transfer_mode'}?: number; ${api.bindingNaming==='camel'?'transferChannel':'transfer_channel'}?: number}
export interface ClassBinder {
(): <T extends NativeClass>(value:T, context:ClassDecoratorContext<T>)=>void;
tool(): <T extends NativeClass>(value:T, context:ClassDecoratorContext<T>)=>void;
icon(path:string): <T extends NativeClass>(value:T, context:ClassDecoratorContext<T>)=>void;
export: ((type:G.Variant.Type, options?:ExportOptions)=>MemberDecorator) & {multiline():MemberDecorator; range(min:number,max:number,step?:number,...hints:string[]):MemberDecorator; range_int(min:number,max:number,step?:number,...hints:string[]):MemberDecorator; file(filter:string):MemberDecorator; dir(filter:string):MemberDecorator; global_file(filter:string):MemberDecorator; global_dir(filter:string):MemberDecorator; exp_easing(hint?:""|"attenuation"|"positive_only"|"attenuation,positive_only"):MemberDecorator; ${helperAliases} array(type:unknown):MemberDecorator; dictionary(key:unknown,value:unknown):MemberDecorator; object(type:NativeClass):MemberDecorator; enum(type:Record<string,string|number>):MemberDecorator; flags(type:Record<string,string|number>):MemberDecorator; cache():MemberDecorator};
signal(): MemberDecorator; rpc(config?:ModernRPCConfig):MemberDecorator; onready(evaluator:string|((self:G.${objectName})=>unknown)):MemberDecorator;
deprecated(message?:string):MemberDecorator; experimental(message?:string):MemberDecorator; help(message?:string):MemberDecorator;
}
export function createClassBinder(): ClassBinder;
export function EnumType(type: Record<string,string|number>): unknown;
export function TypePair(key:unknown,value:unknown): unknown;
}
`;
  const runtimeDeclarations=ENGINE_RUNTIME_DECLARATIONS.replace(/\bGodot\.(\w+)/g,(_match,name:string)=>'Godot.'+typeName(name));
  return { files: { '/godot/index.d.ts': lines.join('\n') + '\n', '/godot-jsb/index.d.ts': jsb, '/godot.annotations/index.d.ts': runtimeDeclarations + '\n' + annotations }, coverage, diagnostics };
}
