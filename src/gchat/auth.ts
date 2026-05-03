import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { config } from "../config.js";
import {
  GCHAT_AUTH_FAILED_PREFIX,
  GCHAT_AUTH_LINK_PREFIX,
  GCHAT_CONNECTED_TEXT,
  GCHAT_NO_REFRESH_TOKEN_TEXT,
  GCHAT_NOT_CONFIGURED_TEXT,
} from "../prompts.js";
import type { TelegramClient } from "../telegram/client.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "gchat-state.json");

const SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/contacts",
  // "https://www.googleapis.com/auth/contacts.readonly",
];

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface GchatState {
  refreshToken?: string;
  lastCheckedAt: Record<string, string>;
}

export async function loadGchatState(): Promise<GchatState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GchatState>;
    return {
      refreshToken: parsed.refreshToken,
      lastCheckedAt:
        parsed.lastCheckedAt && typeof parsed.lastCheckedAt === "object"
          ? parsed.lastCheckedAt
          : {},
    };
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { lastCheckedAt: {} };
    }
    throw err;
  }
}

export async function saveGchatState(state: GchatState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function isGchatConfigured(): boolean {
  return (
    typeof config.googleClientId === "string" &&
    typeof config.googleClientSecret === "string"
  );
}

function buildRedirectUri(port: number): string {
  return `http://localhost:${port}/oauth2callback`;
}

export function createOAuthClient(): OAuth2Client {
  if (!isGchatConfigured()) {
    throw new Error(
      "Google Chat OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
    );
  }
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    buildRedirectUri(config.gchatOAuthPort),
  );
}

export async function getAuthorizedClient(): Promise<OAuth2Client | null> {
  if (!isGchatConfigured()) return null;
  const state = await loadGchatState();
  if (!state.refreshToken) return null;
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: state.refreshToken });
  return client;
}

export async function startGchatAuthFlow(
  chatId: number,
  telegram: TelegramClient,
): Promise<void> {
  if (!isGchatConfigured()) {
    await telegram
      .sendMessage(chatId, GCHAT_NOT_CONFIGURED_TEXT)
      .catch(() => {});
    return;
  }

  const port = config.gchatOAuthPort;
  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  console.log(
    `[gchat-auth] starting OAuth flow on port=${port} scopes=${SCOPES.join(",")}`,
  );
  console.log(`[gchat-auth] auth URL generated (length=${authUrl.length})`);

  let server: http.Server | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = null;
    });

  try {
    const codePromise = new Promise<string>((resolve, reject) => {
      server = http.createServer((req, res) => {
        try {
          if (req.url === undefined) {
            res.writeHead(400);
            res.end("Bad request");
            return;
          }
          const url = new URL(req.url, `http://0.0.0.0:${port}`);
          if (url.pathname !== "/oauth2callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const error = url.searchParams.get("error");
          const receivedCode = url.searchParams.get("code");
          if (error !== null) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            res.end(
              `<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this window.</p></body></html>`,
            );
            reject(new Error(`OAuth error: ${error}`));
            return;
          }
          if (receivedCode === null || receivedCode.length === 0) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            res.end(
              "<html><body><h2>Missing authorization code</h2><p>You can close this window.</p></body></html>",
            );
            reject(new Error("OAuth callback missing code parameter"));
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h2>✅ Authorization received</h2><p>You can close this window and return to Telegram.</p></body></html>",
          );
          resolve(receivedCode);
          console.log(
            `[gchat-auth] OAuth callback received, code length=${receivedCode.length}`,
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      server.on("error", (err) => reject(err));
      server.listen(port, "0.0.0.0");
      console.log(
        `[gchat-auth] local callback server listening on port=${port}`,
      );

      timeoutHandle = setTimeout(() => {
        reject(new Error("OAuth flow timed out after 5 minutes"));
      }, AUTH_TIMEOUT_MS);
      if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
    });

    await telegram
      .sendMessage(chatId, `${GCHAT_AUTH_LINK_PREFIX}${authUrl}`, {
        disable_web_page_preview: true,
      })
      .catch(() => {});

    const code = await codePromise;

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    await closeServer();
    console.log(`[gchat-auth] server closed, starting token exchange…`);

    const tokenExchangeStart = Date.now();
    const { tokens } = await oauth2Client.getToken(code);
    console.log(
      `[gchat-auth] token exchange done in ${Date.now() - tokenExchangeStart}ms | hasRefreshToken=${Boolean(tokens.refresh_token)} expiryDate=${tokens.expiry_date ?? "n/a"}`,
    );
    if (!tokens.refresh_token) {
      await telegram
        .sendMessage(chatId, GCHAT_NO_REFRESH_TOKEN_TEXT)
        .catch(() => {});
      return;
    }

    const state = await loadGchatState();
    const isOverride = Boolean(state.refreshToken);
    state.refreshToken = tokens.refresh_token;
    await saveGchatState(state);
    console.log(
      `[gchat-auth] refresh token saved to ${STATE_FILE} | override=${isOverride}`,
    );

    await telegram.sendMessage(chatId, GCHAT_CONNECTED_TEXT).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gchat-auth] flow failed: ${msg}`);
    await telegram
      .sendMessage(chatId, `${GCHAT_AUTH_FAILED_PREFIX}${msg}`)
      .catch(() => {});
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    await closeServer();
  }
}
