export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogSink = (record: string) => void;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel, sink: LogSink = (record) => process.stderr.write(`${record}\n`)): Logger {
  const log = (recordLevel: LogLevel, message: string, fields: LogFields = {}): void => {
    if (priorities[recordLevel] < priorities[level]) return;
    sink(JSON.stringify({ timestamp: new Date().toISOString(), level: recordLevel, message, ...fields }));
  };
  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
