export interface ResilientHandlerOptions {
  fallbackValue?: any;
  logMissing?: boolean;
  retryCount?: number;
}

export class ResilientHandler {
  async executeWithFallback<T>(
    fn: () => Promise<T>,
    options: ResilientHandlerOptions = {}
  ): Promise<T | undefined> {
    const { fallbackValue, logMissing = true, retryCount = 1 } = options;

    for (let i = 0; i < retryCount; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retryCount - 1) {
          if (logMissing) {
            console.warn('Handler failed, using fallback', error);
          }
          return fallbackValue;
        }
        await new Promise(r => setTimeout(r, 100 * (i + 1)));
      }
    }
  }

  validateDependencies<T extends Record<string, any>>(
    data: T,
    required: (keyof T)[]
  ): boolean {
    return required.every(key => data[key] != null);
  }

  async handleWithValidation<T extends Record<string, any>, R>(
    data: T,
    requiredFields: (keyof T)[],
    handler: (data: T) => Promise<R>
  ): Promise<R | null> {
    if (!this.validateDependencies(data, requiredFields)) {
      return null;
    }
    return handler(data);
  }
}
