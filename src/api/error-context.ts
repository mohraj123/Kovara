export interface ErrorContext {
  code: string;
  message: string;
  details: Record<string, any>;
  timestamp: string;
  path?: string;
  statusCode: number;
}

export class ApiError extends Error {
  constructor(public context: ErrorContext) {
    super(context.message);
  }
}
