/**
 * Plugin registries.
 *
 * Three registries, each storing named plugins of one kind:
 *   - Signals   (for ranking in recall)
 *   - Policies  (for lifecycle: decay, archive, reactivate, etc.)
 *   - Pipeline  (for consolidate: extract, embed, cluster, abstract, ...)
 *
 * Registries are just typed maps with a simple get/register/list API. Plugins
 * are resolved by name from config, not imported directly - this is what
 * makes the system pluggable without rewriting callers.
 */

import { PluginNotFoundError } from './errors.js';

export interface Plugin {
  readonly name: string;
}

export class PluginRegistry<T extends Plugin> {
  private readonly plugins = new Map<string, T>();

  constructor(public readonly kind: string) {}

  register(plugin: T): this {
    this.plugins.set(plugin.name, plugin);
    return this;
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  get(name: string): T {
    const p = this.plugins.get(name);
    if (!p) throw new PluginNotFoundError(this.kind, name);
    return p;
  }

  tryGet(name: string): T | undefined {
    return this.plugins.get(name);
  }

  list(): T[] {
    return [...this.plugins.values()];
  }

  names(): string[] {
    return [...this.plugins.keys()];
  }
}
