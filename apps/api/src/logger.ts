import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export function loggerOptions(
  level = 'info',
  pretty = process.env.NODE_ENV !== 'production',
): LoggerOptions {
  return {
    level,
    redact: {
      paths: ['req.headers.authorization', '*.access_token', '*.client_secret'],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : {}),
  };
}

export function createLogger(level?: string): Logger {
  return pino(loggerOptions(level));
}
