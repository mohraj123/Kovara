export class EnvValidator {
  static validate(): Record<string, string> {
    const required = ['DATABASE_URL', 'NODE_ENV', 'API_KEY'];
    const env: Record<string, string> = {};

    for (const key of required) {
      const value = process.env[key];
      if (!value) throw new Error(`Missing required env: ${key}`);
      env[key] = value;
    }
    return env;
  }
}
