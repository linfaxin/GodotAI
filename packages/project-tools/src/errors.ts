export class ProjectToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(`${code}: ${message}`); this.name = "ProjectToolError"; }
}
export function fail(code: string, message: string, details?: unknown): never { throw new ProjectToolError(code, message, details); }
