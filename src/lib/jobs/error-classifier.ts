import type { ErrorClass } from '../types.js';

interface ClassifyOptions {
  httpStatus?: number;
  isTimeout?: boolean;
  isConnectionReset?: boolean;
  isDnsError?: boolean;
  isPluginError?: boolean;
  errorMessage?: string;
}

const NOT_FOUND_CODES = new Set([404]);
const TRANSIENT_CODES = new Set([500, 502, 503, 504]);

export function classifyError(options: ClassifyOptions): ErrorClass {
  const { httpStatus, isTimeout, isConnectionReset, isDnsError, isPluginError, errorMessage } = options;
  const msg = (errorMessage ?? '').toLowerCase();

  // Plugin errors (non-network)
  if (isPluginError) {
    if (msg.includes('timeout') || msg.includes('network')) return 'transient';
    if (msg.includes('not found') || msg.includes('404')) return 'not_found';
    return 'permanent';
  }

  // HTTP status codes
  if (httpStatus) {
    if (NOT_FOUND_CODES.has(httpStatus)) return 'not_found';
    if (httpStatus === 429) {
      if (msg.includes('cloudflare') || msg.includes('challenge') || msg.includes('captcha') || msg.includes('blocked')) return 'blocked';
      return 'rate_limited';
    }
    if (httpStatus === 403) return 'blocked';
    if (TRANSIENT_CODES.has(httpStatus)) return 'transient';
    if (httpStatus >= 400 && httpStatus < 500) return 'permanent';
  }

  // Network errors
  if (isTimeout || isConnectionReset || isDnsError) return 'transient';

  // Message-based heuristics
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout')) return 'transient';
  if (msg.includes('circuit breaker')) return 'blocked';

  // Fallback
  return 'transient';
}

export function errorClassToTaskStatus(errorClass: ErrorClass): 'failed_retryable' | 'failed_permanent' | 'succeeded' {
  switch (errorClass) {
    case 'ok':
    case 'not_found':
      return 'succeeded';
    case 'permanent':
      return 'failed_permanent';
    default: // transient, rate_limited, blocked
      return 'failed_retryable';
  }
}

/** Per-class retry backoff config (base and cap in ms). */
export const BACKOFF_CONFIG: Record<string, { base: number; cap: number; maxAttempts: number }> = {
  transient: { base: 2000, cap: 60000, maxAttempts: 5 },
  rate_limited: { base: 30000, cap: 900000, maxAttempts: 4 },
  blocked: { base: 60000, cap: 1800000, maxAttempts: 3 },
};

/** Compute backoff delay with full jitter. */
export function getBackoffForClass(errorClass: ErrorClass, attemptNumber: number): number {
  const config = BACKOFF_CONFIG[errorClass] ?? BACKOFF_CONFIG.transient;
  const delay = Math.min(config.cap, config.base * Math.pow(2, attemptNumber - 1));
  // Full jitter: random in [0, delay]
  return Math.floor(Math.random() * delay);
}

export function getUserFacingMessage(errorClass: ErrorClass, source: string): string {
  const messages: Record<string, string> = {
    transient: `${source}: Temporary error — will retry automatically`,
    rate_limited: `${source}: Rate limited — backing off`,
    blocked: source === 'rumble'
      ? `${source}: Blocked — a proxy may be required for Rumble`
      : `${source}: Blocked by platform`,
    not_found: `${source}: No results found`,
    permanent: `${source}: Permanent error — needs investigation`,
  };
  return messages[errorClass] ?? `${source}: Unknown error`;
}
