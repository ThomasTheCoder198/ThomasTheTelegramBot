/**
 * Smoke test: fires gchatMorningCheck immediately with real credentials.
 * Run with: npm run test:gchat
 */
import { AgentCore } from "../src/agent/core.js";
import { SessionManager } from "../src/agent/session.js";
import { config } from "../src/config.js";
import { loadGchatState } from "../src/gchat/auth.js";
import { gchatMorningCheck } from "../src/gchat/scheduler.js";
import { TelegramClient } from "../src/telegram/client.js";
import { createDefaultRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  const userIds = [...config.allowedUserIds];
  if (userIds.length === 0) {
    console.error("[test-gchat] ALLOWED_USER_IDS is empty");
    process.exit(1);
  }
  const chatId = userIds[0];

  const state = await loadGchatState();
  if (!state.refreshToken) {
    console.error(
      "[test-gchat] No refresh token found. Run /gchat-auth in Telegram first.",
    );
    process.exit(1);
  }

  const telegram = new TelegramClient(config.telegramBotToken);
  const sessions = new SessionManager(config.sessionTtlMinutes);
  const registry = await createDefaultRegistry();
  const agent = new AgentCore(sessions, registry);

  console.info(`[test-gchat] chatId=${chatId} — running gchatMorningCheck…`);
  await gchatMorningCheck(telegram, agent, chatId);
  console.info("[test-gchat] done.");
}

main().catch((err) => {
  console.error("[test-gchat] fatal:", err);
  process.exit(1);
});
