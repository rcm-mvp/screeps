/**
 * Console module: run arbitrary expressions in the live runtime.
 *
 * The HTTP call only *submits* the expression; its log + result output arrives
 * asynchronously on the `console` WebSocket channel. Subscribe there to read
 * the output (see {@link SocketClient}).
 */

import { ModuleBase } from './base';

export class ConsoleModule extends ModuleBase {
  /**
   * Submit an expression to the live console runtime.
   * @rateLimit POST user/console (360/hr)
   */
  run(expression: string, shard?: string): Promise<{ result?: unknown; ops?: unknown }> {
    return this.client.call('user/console', {
      body: { expression, shard: this.shard(shard) },
    });
  }
}
