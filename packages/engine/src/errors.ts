export class OrchestrationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** The same object as `details`, named as the SDK's errors name it (SPEC-0051 E02). */
  readonly data: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.details = details;
    this.data = details;
  }
}
export function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new OrchestrationError(code, message, details);
}
