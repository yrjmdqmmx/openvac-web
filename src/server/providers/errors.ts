export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      provider: string;
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class ConfigurationError extends ProviderError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(message, { provider, cause });
    this.name = "ConfigurationError";
  }
}

export class ProviderResponseError extends ProviderError {
  constructor(
    provider: string,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    } = {}
  ) {
    super(message, { provider, ...options });
    this.name = "ProviderResponseError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(message, { provider, retryable: true, cause });
    this.name = "ProviderTimeoutError";
  }
}
