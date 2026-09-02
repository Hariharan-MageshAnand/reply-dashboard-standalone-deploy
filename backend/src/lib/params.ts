import type { Request } from 'express';
import { AppError } from '../lib/errors.js';

export function param(req: Request, name: string): string {
  const value = req.params[name];
  const resolved = Array.isArray(value) ? value[0] : value;
  if (!resolved) {
    throw new AppError('validation_error', `Missing path parameter: ${name}`, 400);
  }
  return resolved;
}
