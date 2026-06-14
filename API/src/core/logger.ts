/**
 * Minimal structured logger. Toggleable; off by default so the library is
 * silent unless `log: true` is configured. Emits single-line JSON records so
 * logs are machine-parseable by an observability pipeline or the UI.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

const defaultSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
};

export class Logger {
  constructor(
    private enabled: boolean,
    private sink: LogSink = defaultSink,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    this.sink({ level, msg, ts: new Date().toISOString(), ...fields });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
}
