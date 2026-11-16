/**
 * @ablationkit/auth: tokens and login codes (spec §7.11, ADR 0008; no passkeys, ADR 0037).
 *
 * Bearer tokens and the login socket are reachable by any process running as the researcher;
 * they separate APIs and scopes, they are not a defense against same-user code.
 */
export * from "./crypto.ts";
export * from "./one-time.ts";
export * from "./tokens.ts";
