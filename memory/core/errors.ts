/**
 * Typed errors for @exocortex/memory.
 *
 * Keep the hierarchy flat and the messages actionable. Each error carries
 * structured data so callers can handle specific cases without string parsing.
 */

export class MemoryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends MemoryError {
  constructor(message: string, public readonly field?: string) {
    super(message);
  }
}

export class StoreError extends MemoryError {}

export class EmbedderError extends MemoryError {}

export class ProviderError extends MemoryError {
  constructor(
    message: string,
    public readonly provider: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class PluginNotFoundError extends MemoryError {
  constructor(public readonly registry: string, public readonly name: string) {
    super(`${registry} plugin not found: ${name}`);
  }
}

export class DuplicateItemError extends MemoryError {
  constructor(public readonly itemId: string) {
    super(`Duplicate memory item: ${itemId}`);
  }
}
