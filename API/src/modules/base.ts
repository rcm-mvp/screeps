import type { HttpClient } from '../core/httpClient';

/** Shared, mutable defaults injected into every module (e.g. the active shard). */
export interface ModuleDefaults {
  shard: string;
}

/** Base class giving every module access to the HTTP client + live defaults. */
export abstract class ModuleBase {
  constructor(
    protected readonly client: HttpClient,
    protected readonly defaults: ModuleDefaults,
  ) {}

  /** Resolve a shard argument against the configured default. */
  protected shard(shard?: string): string {
    return shard ?? this.defaults.shard;
  }
}
