/**
 * Logger setup using Winston
 * Console: colorized, human-readable
 * File: JSON format with rotation (5MB max, 5 files)
 */

import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta, (_key, value) =>
                typeof value === 'bigint' ? value.toString() : value
              )}`
            : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        }),
      ),
    }),
    new winston.transports.File({
      filename: 'logs/rebalancer.log',
      format: winston.format.combine(
        winston.format.json({
          replacer: (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        }),
      ),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.json({
          replacer: (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        }),
      ),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

export default logger;
