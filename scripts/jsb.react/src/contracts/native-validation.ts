import { ERROR_CODES, invariant } from "./errors";
import { exact, object, integer, string, strings, validateCommitTicket, validateNativeKey } from "./validation";
import type { CleanupReceipt, EventEnvelope, GenerationTicket, NativeInvalidation, NativeOperation, NativeOpResult, RootState } from "./types";

export function validateCleanupReceipt(value: unknown): CleanupReceipt {
  const receipt = exact(value, ["ticket", "barrier", "retirementBatch", "roots", "passiveSequence"]);
  validateCommitTicket(receipt.ticket, "$.ticket");
  invariant(receipt.barrier === "passiveSettled", ERROR_CODES.INVALID_CONTRACT, "Cleanup requires passiveSettled", "$.barrier");
  string(receipt.retirementBatch, "$.retirementBatch"); strings(receipt.roots, "$.roots"); integer(receipt.passiveSequence, "$.passiveSequence");
  return value as CleanupReceipt;
}

export function validateNativeOperation(value: unknown): NativeOperation {
  const op = exact(value, ["opId", "ticket", "opcode"], ["target", "parent", "child", "index", "type", "property", "value"]);
  string(op.opId, "$.opId"); validateCommitTicket(op.ticket, "$.ticket");
  const shapes: Record<string, { required: string[]; optional: string[] }> = {
    create: { required: ["type"], optional: [] },
    append: { required: ["parent", "child"], optional: [] },
    insert: { required: ["parent", "child", "index"], optional: [] },
    move: { required: ["parent", "child", "index"], optional: [] },
    detach: { required: ["parent", "child"], optional: [] },
    free: { required: ["target"], optional: [] },
    set: { required: ["target", "property", "value"], optional: [] },
    setOwner: { required: ["target"], optional: ["parent"] },
  };
  invariant(typeof op.opcode === "string" && Object.hasOwn(shapes, op.opcode), ERROR_CODES.INVALID_CONTRACT, "Unknown native opcode", "$.opcode");
  const shape = shapes[op.opcode]!;
  exact(op, ["opId", "ticket", "opcode", ...shape.required], shape.optional);
  for (const key of ["target", "parent", "child"]) if (op[key] !== undefined) validateNativeKey(op[key], `$.${key}`);
  if (op.index !== undefined) integer(op.index, "$.index");
  if (op.type !== undefined) invariant(/^[A-Za-z][A-Za-z0-9]*$/.test(string(op.type, "$.type")), ERROR_CODES.INVALID_CONTRACT, "Invalid native class name", "$.type");
  if (op.property !== undefined) string(op.property, "$.property");
  if (op.opcode === "set") invariant(op.value !== undefined, ERROR_CODES.VALUE, "Native set value cannot be undefined", "$.value");
  return value as NativeOperation;
}

export function validateNativeOpResult(value: unknown): NativeOpResult {
  const result = exact(value, ["opId", "status", "verification"], ["code", "message", "nativeKey", "value"]);
  string(result.opId, "$.opId");
  invariant(result.status === "applied" || result.status === "rejected" || result.status === "lost", ERROR_CODES.INVALID_CONTRACT, "Invalid native result status", "$.status");
  invariant(typeof result.verification === "string" && ["structure", "stored-state", "native-return", "none"].includes(result.verification), ERROR_CODES.INVALID_CONTRACT, "Invalid verification kind", "$.verification");
  if (result.nativeKey !== undefined) validateNativeKey(result.nativeKey, "$.nativeKey");
  if (result.code !== undefined) string(result.code, "$.code");
  if (result.message !== undefined) string(result.message, "$.message");
  invariant(result.status !== "applied" || result.verification !== "none", ERROR_CODES.NATIVE_OP, "Unverified operation cannot be reported as applied", "$.verification");
  return value as NativeOpResult;
}

export function validateNativeInvalidation(value: unknown): NativeInvalidation {
  const event = exact(value, ["rootId", "rootInstance", "hostId", "nativeKey", "reason"], ["retirementBatch"]);
  for (const key of ["rootId", "rootInstance", "hostId"]) string(event[key], `$.${key}`);
  validateNativeKey(event.nativeKey, "$.nativeKey");
  invariant(typeof event.reason === "string" && ["external-free", "expected-free", "rebind", "context-disposed"].includes(event.reason), ERROR_CODES.INVALID_CONTRACT, "Invalid invalidation reason", "$.reason");
  if (event.retirementBatch !== undefined) string(event.retirementBatch, "$.retirementBatch");
  invariant(event.reason !== "expected-free" || event.retirementBatch !== undefined, ERROR_CODES.INVALID_CONTRACT, "Expected frees must identify their retirement batch", "$.retirementBatch");
  return value as NativeInvalidation;
}

export function validateEventEnvelope(value: unknown): EventEnvelope {
  const event = exact(value, ["rootInstance", "target", "signal", "origin", "observedCommit", "sequence", "payload"]);
  string(event.rootInstance, "$.rootInstance"); validateNativeKey(event.target, "$.target"); string(event.signal, "$.signal");
  invariant(typeof event.origin === "string" && ["external", "controlledSetterEcho", "user", "engine"].includes(event.origin), ERROR_CODES.INVALID_CONTRACT, "Invalid event origin", "$.origin");
  integer(event.observedCommit, "$.observedCommit"); integer(event.sequence, "$.sequence");
  invariant(Array.isArray(event.payload), ERROR_CODES.INVALID_CONTRACT, "Event payload must be an array", "$.payload");
  return value as EventEnvelope;
}

export function validateGenerationTicket(value: unknown): GenerationTicket {
  const ticket = exact(value, ["rootInstance", "entryId", "generation", "manifestSha256", "runtimeAbi", "nativeBridgeAbi"]);
  for (const key of ["rootInstance", "entryId", "generation", "runtimeAbi", "nativeBridgeAbi"]) string(ticket[key], `$.${key}`);
  invariant(typeof ticket.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(ticket.manifestSha256), ERROR_CODES.INVALID_HASH, "Invalid manifest digest", "$.manifestSha256");
  return value as GenerationTicket;
}

const ROOT_TRANSITIONS: Readonly<Record<RootState, readonly RootState[]>> = Object.freeze({
  booting: ["running", "quiescing", "faulted", "disposing"],
  running: ["quiescing", "faulted"],
  quiescing: ["disposing", "faulted"],
  faulted: ["disposing"],
  disposing: ["disposed"],
  disposed: [],
});

export function canTransitionRoot(from: RootState, to: RootState): boolean { return Object.hasOwn(ROOT_TRANSITIONS, from) && Object.hasOwn(ROOT_TRANSITIONS, to) && (from === to || ROOT_TRANSITIONS[from]?.includes(to) === true); }
export function assertRootTransition(from: RootState, to: RootState): void { invariant(canTransitionRoot(from, to), ERROR_CODES.INVALID_CONTRACT, `Illegal root transition ${from} -> ${to}`); }

export function validatePublicationReceipt(value: unknown): import("./types").NativeAppliedReceipt | import("./types").LayoutPublishedReceipt | CleanupReceipt {
  const receipt = exact(value, ["ticket", "barrier"], ["retirementBatch", "roots", "passiveSequence"]);
  if (receipt.barrier === "passiveSettled") return validateCleanupReceipt(value);
  exact(value, ["ticket", "barrier"]);
  validateCommitTicket(receipt.ticket, "$.ticket");
  invariant(receipt.barrier === "nativeApplied" || receipt.barrier === "layoutPublished", ERROR_CODES.INVALID_CONTRACT, "Unknown publication barrier", "$.barrier");
  return value as import("./types").NativeAppliedReceipt | import("./types").LayoutPublishedReceipt;
}

export function validateRetirementBatch(value: unknown): import("./types").RetirementBatch {
  const batch = exact(value, ["id", "ticket", "roots", "nativeKeys"]);
  string(batch.id, "$.id"); validateCommitTicket(batch.ticket, "$.ticket"); strings(batch.roots, "$.roots");
  invariant(Array.isArray(batch.nativeKeys), ERROR_CODES.INVALID_CONTRACT, "Expected NativeKey array", "$.nativeKeys");
  const seen = new Set<string>();
  for (const [index, raw] of batch.nativeKeys.entries()) {
    const key = validateNativeKey(raw, `$.nativeKeys[${index}]`), id = `${key.slot}:${key.revision}`;
    invariant(!seen.has(id), ERROR_CODES.INVALID_CONTRACT, "Duplicate retired NativeKey", `$.nativeKeys[${index}]`); seen.add(id);
  }
  return value as import("./types").RetirementBatch;
}

export function validateDispatchCapability(value: unknown): import("./types").DispatchCapability {
  const cap = exact(value, ["rootInstance", "target", "hookId", "leaseId", "leaseVersion", "operationEpoch", "dispatchToken", "phase"]);
  for (const key of ["rootInstance", "hookId", "leaseId", "dispatchToken"]) string(cap[key], `$.${key}`);
  validateNativeKey(cap.target, "$.target"); integer(cap.leaseVersion, "$.leaseVersion"); integer(cap.operationEpoch, "$.operationEpoch");
  invariant((cap.leaseVersion as number) > 0, ERROR_CODES.INVALID_CONTRACT, "Lease version must be positive", "$.leaseVersion");
  invariant(cap.phase === "process" || cap.phase === "physics" || cap.phase === "input", ERROR_CODES.PHASE, "Invalid dispatch phase", "$.phase");
  return value as import("./types").DispatchCapability;
}

export function validatePropertyLease(value: unknown): import("./types").PropertyLease {
  const lease = exact(value, ["id", "version", "hostId", "hookId", "phase", "canonicalFields"]);
  for (const key of ["id", "hostId", "hookId"]) string(lease[key], `$.${key}`);
  integer(lease.version, "$.version"); invariant((lease.version as number) > 0, ERROR_CODES.INVALID_CONTRACT, "Lease version must be positive", "$.version");
  invariant(lease.phase === "process" || lease.phase === "physics" || lease.phase === "input", ERROR_CODES.PHASE, "Invalid lease phase", "$.phase");
  const fields = strings(lease.canonicalFields, "$.canonicalFields");
  invariant(fields.every((field, i) => i === 0 || fields[i - 1]! < field), ERROR_CODES.OWNER, "Canonical fields must be sorted", "$.canonicalFields");
  return value as import("./types").PropertyLease;
}

export function validateCapabilityProfile(value: unknown): import("./types").CapabilityProfileV1 {
  const profile = exact(value, ["id", "version", "hosts", "codecs", "resources", "features"]);
  string(profile.id, "$.id"); invariant(profile.version === 1, ERROR_CODES.PROFILE, "Unsupported capability profile schema", "$.version");
  for (const field of ["hosts", "codecs", "resources"]) strings(profile[field], `$.${field}`);
  const features = object(profile.features, "$.features");
  for (const [name, enabled] of Object.entries(features)) invariant(typeof enabled === "boolean", ERROR_CODES.PROFILE, "Feature gate must be boolean", `$.features.${name}`);
  return value as import("./types").CapabilityProfileV1;
}
