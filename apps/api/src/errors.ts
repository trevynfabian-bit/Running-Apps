/**
 * Error types.
 *
 * Athletes never see a stack trace or a provider's internal message. `ApiError`
 * carries a stable machine code plus a sentence written for a person; anything
 * else that escapes becomes a generic 500 with the detail confined to logs.
 */

import type { ApiErrorCode } from '@running/contracts';
import { API_ERROR_CODES } from '@running/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    /** Athlete-facing message. Must be safe to display verbatim. */
    override readonly message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return {
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

export const notFound = (what: string): ApiError =>
  new ApiError(404, API_ERROR_CODES.NOT_FOUND, `${what} not found.`);

export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError(400, API_ERROR_CODES.VALIDATION_FAILED, message, details);

export const providerNotConnected = (provider: string): ApiError =>
  new ApiError(
    409,
    API_ERROR_CODES.PROVIDER_NOT_CONNECTED,
    `${provider} is not connected. Connect it from the Connections screen to sync.`,
  );

export const providerUnavailable = (provider: string): ApiError =>
  new ApiError(
    503,
    API_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `${provider} is temporarily unavailable. Your data is safe and we'll retry automatically.`,
  );

export const tokenExpired = (provider: string): ApiError =>
  new ApiError(
    401,
    API_ERROR_CODES.TOKEN_EXPIRED,
    `Your ${provider} authorization has expired. Reconnect ${provider} to resume syncing.`,
  );
