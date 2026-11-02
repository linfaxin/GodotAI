/** Stable diagnostic codes shared by the renderer, compiler and native adapter. */
export const ERROR_CODES = {
  INVALID_CONTRACT: "E_INVALID_CONTRACT",
  UNKNOWN_FIELD: "E_UNKNOWN_FIELD",
  INVALID_PATH: "E_INVALID_PATH",
  INVALID_HASH: "E_INVALID_HASH",
  ABI: "E_MANIFEST_ABI",
  GENERATION: "E_GENERATION_MISMATCH",
  PROFILE: "E_PROFILE_UNSUPPORTED",
  HOST: "E_HOST_UNSUPPORTED",
  PROP: "E_PROPERTY_UNSUPPORTED",
  VALUE: "E_PROPERTY_VALUE",
  OWNER: "E_PROPERTY_OWNER_CONFLICT",
  CONSTRUCTION: "E_CONSTRUCTION_PROP_CHANGE",
  INITIAL: "E_INITIAL_PROP_CHANGE",
  NAME: "E_NODE_NAME",
  NATIVE_LOST: "E_NATIVE_LOST",
  PHASE: "E_PHASE",
  STALE_COMMAND: "E_STALE_COMMAND",
  FOREIGN_MUTATION: "E_FOREIGN_MUTATION",
  NATIVE_OP: "E_NATIVE_OP_UNVERIFIED",
  ASYNC_CALLBACK: "E_ASYNC_FRAME_CALLBACK",
  IMPORT: "E_IMPORT_UNSUPPORTED",
  IMPORT_SCRIPT: "E_IMPORT_SCRIPT",
  IMPORT_LOCAL_RESOURCE: "E_IMPORT_LOCAL_RESOURCE",
  TEMPLATE_IMPORT: "E_TEMPLATE_IMPORT_FORM",
  RUN_ACTIVE: "E_RUN_ACTIVE",
  BUILD_NOT_READY: "E_BUILD_NOT_READY",
} as const;

export type ContractErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly path: string;
  constructor(code: ContractErrorCode, message: string, path = "$") {
    super(`${code}: ${message} (${path})`);
    this.name = "GodotReactContractError";
    this.code = code;
    this.path = path;
  }
}

export function fail(code: ContractErrorCode, message: string, path = "$"): never {
  throw new ContractError(code, message, path);
}

export function invariant(condition: unknown, code: ContractErrorCode, message: string, path = "$"): asserts condition {
  if (!condition) fail(code, message, path);
}
