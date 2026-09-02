import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody, ApiErrorCode } from '@reply/contracts';

export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400,
    public readonly fields?: Record<string, string>,
    public readonly recovery?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(res: Response, error: AppError | Error): void {
  if (error instanceof AppError) {
    const body: ApiErrorBody = {
      code: error.code,
      message: error.message,
      fields: error.fields,
      recovery: error.recovery,
    };
    res.status(error.status).json(body);
    return;
  }

  console.error(error);
  res.status(500).json({
    code: 'internal_error',
    message: 'Something went wrong.',
    recovery: 'Retry the action. If it keeps failing, reconnect the mailbox or sign in again.',
  } satisfies ApiErrorBody);
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
