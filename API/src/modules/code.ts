/**
 * Code + branch management module.
 *
 * `modules` is a map of `{ "main": "<source>", "util": "<source>", ... }`. The
 * server also supports binary modules (base64) under a `binary` wrapper; pass
 * those through verbatim.
 */

import { ModuleBase } from './base';

export interface CodeResponse {
  branch: string;
  modules: Record<string, string | { binary: string }>;
}

export interface Branch {
  _id: string;
  branch: string;
  activeWorld?: boolean;
  activeSim?: boolean;
}

export class CodeModule extends ModuleBase {
  /**
   * Pull the full codebase of a branch (defaults to the active branch).
   * @rateLimit GET user/code (60/hr)
   */
  get(branch?: string): Promise<CodeResponse> {
    return this.client.call('GET user/code', { query: { branch } });
  }

  /**
   * Push a full codebase to a branch. Creates the branch if it doesn't exist.
   * @rateLimit POST user/code (240/day)
   */
  push(
    branch: string,
    modules: Record<string, string | { binary: string }>,
  ): Promise<{ hash?: string }> {
    return this.client.call('POST user/code', { body: { branch, modules } });
  }

  /** List code branches. @rateLimit default */
  branches(): Promise<{ list: Branch[] }> {
    return this.client.call('user/branches');
  }

  /**
   * Set the active branch for the world or simulation.
   * @rateLimit POST user/set-active-branch (240/day)
   */
  setActiveBranch(branch: string, activeName: 'activeWorld' | 'activeSim' = 'activeWorld'): Promise<unknown> {
    return this.client.call('user/set-active-branch', { body: { branch, activeName } });
  }

  /** Clone a branch to a new name. @rateLimit default */
  cloneBranch(branch: string, newName: string): Promise<unknown> {
    return this.client.call('user/clone-branch', {
      body: { branch, newName, defaultModules: {} },
    });
  }

  /** Delete a branch. @rateLimit default */
  deleteBranch(branch: string): Promise<unknown> {
    return this.client.call('user/delete-branch', { body: { branch } });
  }
}
