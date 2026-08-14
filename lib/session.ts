/**
 * Runtime-agnostic constants. Kept free of node:crypto so the Edge middleware
 * can import it — lib/auth.ts pulls in node APIs and must stay server-only.
 */
export const COOKIE_NAME = "zscore_session";
