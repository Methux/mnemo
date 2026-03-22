// SPDX-License-Identifier: MIT
/**
 * Mnemo Logger — Unified logging interface
 *
 * Replaces scattered console.log/warn/error with a structured logger.
 * Supports log levels, prefixes, and external logger injection.
 *
 * Usage:
 *   import { log } from "./logger.js";
 *   log.info("message");
 *   log.warn("something wrong");
 *   log.debug("verbose detail");  // only when MNEMO_DEBUG=1
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const PREFIX = "[mnemo]";

const isDebug = () => !!process.env.MNEMO_DEBUG;

/** Default console-based logger */
const defaultLogger: Logger = {
  debug(msg, ...args) {
    if (isDebug()) console.debug(PREFIX, msg, ...args);
  },
  info(msg, ...args) {
    console.log(PREFIX, msg, ...args);
  },
  warn(msg, ...args) {
    console.warn(PREFIX, msg, ...args);
  },
  error(msg, ...args) {
    console.error(PREFIX, msg, ...args);
  },
};

let _logger: Logger = defaultLogger;

/**
 * Get the current logger instance.
 */
export const log: Logger = {
  debug: (msg, ...args) => _logger.debug(msg, ...args),
  info: (msg, ...args) => _logger.info(msg, ...args),
  warn: (msg, ...args) => _logger.warn(msg, ...args),
  error: (msg, ...args) => _logger.error(msg, ...args),
};

/**
 * Replace the default logger with a custom implementation.
 * Useful for integrating with OpenClaw's api.logger or external logging services.
 */
export function setLogger(logger: Logger): void {
  _logger = logger;
}

/**
 * Reset to the default console logger.
 */
export function resetLogger(): void {
  _logger = defaultLogger;
}
