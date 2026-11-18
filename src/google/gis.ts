/// <reference types="google.accounts" />
/**
 * Google Identity Services' OAuth 2.0 client (accounts.google.com/gsi/client), typed by
 * Google's own declarations (@types/google.accounts). Referenced here rather than through
 * `types` in a tsconfig, so an app compiling this package's sources gets them too.
 */
export type OAuth2 = typeof google.accounts.oauth2;
export type TokenClient = google.accounts.oauth2.TokenClient;
export type TokenResponse = google.accounts.oauth2.TokenResponse;
export type ClientConfigError = google.accounts.oauth2.ClientConfigError;

/** Google's OAuth 2.0 client, once its script has loaded (before that, `google` does not exist). */
export const oauth2 = (): OAuth2 | undefined =>
  (window as Window & { google?: { accounts?: { oauth2?: OAuth2 } } }).google?.accounts?.oauth2;
