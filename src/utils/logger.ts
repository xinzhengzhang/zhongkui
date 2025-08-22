import winston from 'winston';

export const logger = winston.createLogger({
  level: 'warn', // Default to warn level, only show warnings and errors
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'zhongkui' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

/**
 * Enable verbose logging (info level)
 */
export function enableVerbose(): void {
  logger.level = 'info';
}

/**
 * Disable verbose logging (warn level)
 */
export function disableVerbose(): void {
  logger.level = 'warn';
}