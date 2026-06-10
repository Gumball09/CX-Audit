import { env } from "./env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = levels[(env.LOG_LEVEL as LogLevel) || "info"];

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= currentLevel;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, data?: any): string {
  const timestamp = formatTimestamp();
  const levelStr = level.toUpperCase().padEnd(5);
  if (data) {
    return `[${timestamp}] ${levelStr} ${message} ${JSON.stringify(data)}`;
  }
  return `[${timestamp}] ${levelStr} ${message}`;
}

export const logger = {
  debug(message: string, data?: any) {
    if (shouldLog("debug")) {
      console.debug(formatMessage("debug", message, data));
    }
  },

  info(message: string, data?: any) {
    if (shouldLog("info")) {
      console.info(formatMessage("info", message, data));
    }
  },

  warn(message: string, data?: any) {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", message, data));
    }
  },

  error(message: string, error?: Error | any) {
    if (shouldLog("error")) {
      if (error instanceof Error) {
        console.error(formatMessage("error", message, { message: error.message, stack: error.stack }));
      } else {
        console.error(formatMessage("error", message, error));
      }
    }
  },

  request(method: string, path: string, statusCode?: number, durationMs?: number) {
    if (shouldLog("info")) {
      const status = statusCode ? ` → ${statusCode}` : "";
      const duration = durationMs ? ` (${durationMs}ms)` : "";
      console.info(`[${formatTimestamp()}] REQUEST  ${method.toUpperCase().padEnd(6)} ${path}${status}${duration}`);
    }
  },
};
