import { requestUrl } from "obsidian";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createHash, randomBytes } from "crypto";
import type { AddressInfo } from "net";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** How long to leave the loopback listener open waiting for the browser redirect. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh a little early so a long request can't expire mid-flight. */
const EXPIRY_SKEW_MS = 60 * 1000;

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface AuthConfig {
	clientId: string;
	clientSecret: string;
	/** 0 asks the OS for an ephemeral port, which Desktop-app OAuth clients allow. */
	port: number;
}

export class AuthError extends Error {}

function base64url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function responsePage(title: string, message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14161a;
         color: #e6e8eb; display: grid; place-items: center; height: 100vh; margin: 0; }
  main { text-align: center; max-width: 30rem; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
  p { color: #9aa2ad; margin: 0; line-height: 1.5; }
</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

interface ConsentResult {
	code: string;
	redirectUri: string;
}

/**
 * Opens Google's consent screen and captures the authorization code on a
 * short-lived loopback listener. Desktop-app OAuth clients accept any
 * `http://127.0.0.1:<port>` redirect, so the port does not need registering.
 */
function awaitConsent(config: AuthConfig, codeChallenge: string): Promise<ConsentResult> {
	return new Promise<ConsentResult>((resolve, reject) => {
		const state = base64url(randomBytes(16));
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let server: Server;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			// The browser holds the socket open with keep-alive, which would otherwise
			// keep the port bound long after we are done with it.
			server.closeAllConnections?.();
			server.close();
			fn();
		};

		const handler = (req: IncomingMessage, res: ServerResponse) => {
			const address = server.address() as AddressInfo | null;
			const port = address?.port ?? config.port;
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (!code && !error) {
				// Favicon and other stray requests from the browser.
				res.writeHead(404).end();
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });

			if (error) {
				res.end(responsePage("Authorization cancelled", "You can close this tab and try again in Obsidian."));
				finish(() => reject(new AuthError(`Google returned "${error}"`)));
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.end(responsePage("Authorization failed", "The state parameter did not match. Please try again."));
				finish(() => reject(new AuthError("State mismatch — the response did not come from the request we started")));
				return;
			}

			res.end(responsePage("Connected", "Obsidian is now linked to your Google Calendar. You can close this tab."));
			finish(() => resolve({ code: code as string, redirectUri: `http://127.0.0.1:${port}` }));
		};

		server = createServer(handler);
		server.on("error", (err) => finish(() => reject(new AuthError(`Could not start the local listener: ${err.message}`))));

		server.listen(config.port, "127.0.0.1", () => {
			const address = server.address() as AddressInfo | null;
			if (!address) {
				finish(() => reject(new AuthError("Could not determine the local listener port")));
				return;
			}
			const redirectUri = `http://127.0.0.1:${address.port}`;
			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: SCOPE,
				access_type: "offline",
				prompt: "consent",
				include_granted_scopes: "true",
				state,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
			});
			window.open(`${AUTH_ENDPOINT}?${params.toString()}`, "_blank");

			timer = setTimeout(
				() => finish(() => reject(new AuthError("Timed out waiting for the Google consent screen"))),
				CONSENT_TIMEOUT_MS
			);
		});
	});
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await requestUrl({
		url,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(form).toString(),
		throw: false,
	});

	let payload: Record<string, unknown> = {};
	try {
		payload = response.json ?? {};
	} catch {
		/* Non-JSON error bodies fall through to the status check below. */
	}

	if (response.status >= 400) {
		const detail = (payload["error_description"] as string) ?? (payload["error"] as string) ?? response.text;
		throw new AuthError(`Google rejected the token request (${response.status}): ${detail}`);
	}
	return payload;
}

/**
 * Runs the full consent + code exchange and returns the resulting tokens
 * without storing them. Callers own persistence, which is what lets a brand-new
 * account be authorised before it exists in settings.
 */
export async function authorize(config: AuthConfig): Promise<OAuthTokens> {
	if (!config.clientId || !config.clientSecret) {
		throw new AuthError("Add your OAuth client ID and client secret in the plugin settings first");
	}

	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const { code, redirectUri } = await awaitConsent(config, challenge);

	const payload = await postForm(TOKEN_ENDPOINT, {
		code,
		client_id: config.clientId,
		client_secret: config.clientSecret,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
		code_verifier: verifier,
	});

	const refreshToken = payload["refresh_token"] as string | undefined;
	if (!refreshToken) {
		throw new AuthError(
			"Google did not return a refresh token. Revoke this app's access at myaccount.google.com/permissions and connect again."
		);
	}

	return {
		accessToken: payload["access_token"] as string,
		refreshToken,
		expiresAt: Date.now() + Number(payload["expires_in"] ?? 3600) * 1000,
	};
}

/** Best-effort revocation. A token Google has already invalidated is still a success locally. */
export async function revoke(refreshToken: string): Promise<void> {
	try {
		await postForm(REVOKE_ENDPOINT, { token: refreshToken });
	} catch {
		/* Nothing useful to do — the caller is dropping the account regardless. */
	}
}

/**
 * Owns one account's token lifecycle. Tokens live in the plugin's `data.json`;
 * `onChange` is called whenever they need persisting.
 */
export class GoogleAuth {
	private refreshInFlight: Promise<string> | null = null;

	constructor(
		private readonly getConfig: () => AuthConfig,
		private readonly getTokens: () => OAuthTokens | null,
		private readonly onChange: (tokens: OAuthTokens | null) => Promise<void>
	) {}

	isConnected(): boolean {
		return Boolean(this.getTokens()?.refreshToken);
	}

	async getAccessToken(): Promise<string> {
		const tokens = this.getTokens();
		if (!tokens?.refreshToken) {
			throw new AuthError("Not connected to Google Calendar");
		}
		if (tokens.accessToken && Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
			return tokens.accessToken;
		}
		return this.refresh();
	}

	/** Forces a refresh, coalescing concurrent callers onto one request. */
	async refresh(): Promise<string> {
		if (this.refreshInFlight) return this.refreshInFlight;

		this.refreshInFlight = (async () => {
			const config = this.getConfig();
			const tokens = this.getTokens();
			if (!tokens?.refreshToken) throw new AuthError("Not connected to Google Calendar");

			const payload = await postForm(TOKEN_ENDPOINT, {
				client_id: config.clientId,
				client_secret: config.clientSecret,
				refresh_token: tokens.refreshToken,
				grant_type: "refresh_token",
			});

			const accessToken = payload["access_token"] as string;
			await this.onChange({
				accessToken,
				// Google only returns a new refresh token when it rotates one.
				refreshToken: (payload["refresh_token"] as string) ?? tokens.refreshToken,
				expiresAt: Date.now() + Number(payload["expires_in"] ?? 3600) * 1000,
			});
			return accessToken;
		})();

		try {
			return await this.refreshInFlight;
		} finally {
			this.refreshInFlight = null;
		}
	}
}
