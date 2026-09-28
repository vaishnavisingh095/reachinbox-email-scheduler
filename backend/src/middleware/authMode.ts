import { sessionAuth } from "./sessionAuth";

/**
 * Single swap point for every production route's auth middleware. Every
 * route imports `requireAuth` from here, never `devAuth` or `sessionAuth`
 * directly, so the auth mechanism is a one-line change in this file.
 *
 * Phase 6: swapped from devAuth (ADR-023, temporary) to sessionAuth
 * (ADR-012, real Google session). ADR-023's devAuth.ts file is preserved
 * as historical documentation and remains usable for local/manual testing
 * (e.g. via the X-Dev-User-Id header directly, bypassing this file) — but
 * no production route reaches it through `requireAuth` anymore.
 */
export const requireAuth = sessionAuth;
