/** The small part of Google Identity Services (accounts.google.com/gsi/client) the package uses. */
export interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

export interface ClientConfigError {
  type: 'popup_failed_to_open' | 'popup_closed' | 'unknown';
  message?: string;
}

export interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: ClientConfigError) => void;
}

export interface OverridableTokenClientConfig {
  prompt?: '' | 'none' | 'consent' | 'select_account';
  login_hint?: string;
}

export interface TokenClient {
  callback: (response: TokenResponse) => void;
  error_callback?: (error: ClientConfigError) => void;
  requestAccessToken(overrides?: OverridableTokenClientConfig): void;
}

export interface OAuth2 {
  initTokenClient(config: TokenClientConfig): TokenClient;
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
}

/** Google's OAuth 2.0 client, once its script has loaded. */
export const oauth2 = (): OAuth2 | undefined =>
  (window as Window & { google?: { accounts?: { oauth2?: OAuth2 } } }).google?.accounts?.oauth2;
