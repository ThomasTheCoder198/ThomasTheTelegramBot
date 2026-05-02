const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const DEFAULT_SESSION_TTL_MINUTES = 10;
const DEFAULT_GCHAT_OAUTH_PORT = 4085;

export interface AppConfig {
  telegramBotToken: string;
  openrouterApiKey: string;
  openrouterModel: string;
  openrouterFallbackModels: string[];
  exaApiKey: string;
  allowedUserIds: Set<number>;
  sessionTtlMinutes: number;
  schedulerCron: string;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  gchatOAuthPort: number;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`[config] ${message}`);
    this.name = "ConfigError";
  }
}

function requireString(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return raw.trim();
}

function parseAllowedUserIds(raw: string | undefined): Set<number> {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ConfigError(
      "ALLOWED_USER_IDS is required and must contain at least one numeric Telegram user ID (comma-separated).",
    );
  }

  const ids = new Set<number>();
  const parts = raw.split(",");

  for (const part of parts) {
    const token = part.trim();
    if (token.length === 0) continue;
    const value = Number(token);
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(
        `ALLOWED_USER_IDS contains an invalid entry: "${token}". Each entry must be a positive integer.`,
      );
    }
    ids.add(value);
  }

  if (ids.size === 0) {
    throw new ConfigError(
      "ALLOWED_USER_IDS must contain at least one numeric user ID.",
    );
  }

  return ids;
}

function parseSessionTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SESSION_TTL_MINUTES;
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      `SESSION_TTL_MINUTES must be a positive number; got "${raw}".`,
    );
  }
  return value;
}

export function loadConfig(): AppConfig {
  const telegramBotToken = requireString("TELEGRAM_BOT_TOKEN");
  const openrouterApiKey = requireString("OPENROUTER_API_KEY");
  const exaApiKey = requireString("EXA_API_KEY");
  const allowedUserIds = parseAllowedUserIds(process.env.ALLOWED_USER_IDS);

  const openrouterModel =
    (process.env.OPENROUTER_MODEL ?? "").trim() || DEFAULT_OPENROUTER_MODEL;
  const openrouterFallbackModels = (
    process.env.OPENROUTER_FALLBACK_MODELS ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sessionTtlMinutes = parseSessionTtl(process.env.SESSION_TTL_MINUTES);
  const schedulerCron =
    (process.env.SCHEDULER_CRON ?? "").trim() || "0 1 * * *";

  const googleClientId =
    (process.env.GOOGLE_CLIENT_ID ?? "").trim() || undefined;
  const googleClientSecret =
    (process.env.GOOGLE_CLIENT_SECRET ?? "").trim() || undefined;

  const rawPort = (process.env.GCHAT_OAUTH_PORT ?? "").trim();
  let gchatOAuthPort = DEFAULT_GCHAT_OAUTH_PORT;
  if (rawPort.length > 0) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new ConfigError(
        `GCHAT_OAUTH_PORT must be an integer between 1 and 65535; got "${rawPort}".`,
      );
    }
    gchatOAuthPort = parsed;
  }

  return {
    telegramBotToken,
    openrouterApiKey,
    openrouterModel,
    openrouterFallbackModels,
    exaApiKey,
    allowedUserIds,
    sessionTtlMinutes,
    schedulerCron,
    googleClientId,
    googleClientSecret,
    gchatOAuthPort,
  };
}

export const config: AppConfig = loadConfig();
