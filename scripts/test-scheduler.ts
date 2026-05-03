/**
 * Test script: fires scheduled commands immediately, then every minute.
 * Run with: npm run test:scheduler
 */
import { AgentCore } from "../src/agent/core.js";
import { SessionManager } from "../src/agent/session.js";
import { config } from "../src/config.js";
import { TelegramClient } from "../src/telegram/client.js";
import { createDefaultRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  const userIds = [...config.allowedUserIds];
  if (userIds.length === 0) {
    console.error("[test-scheduler] ALLOWED_USER_IDS is empty");
    process.exit(1);
  }
  const chatId = userIds[0];

  const telegram = new TelegramClient(config.telegramBotToken);
  const sessions = new SessionManager(config.sessionTtlMinutes);
  const registry = await createDefaultRegistry();
  const agent = new AgentCore(sessions, registry);

  console.info(
    `[test-scheduler] Running scheduled commands for chatId=${chatId}...`,
  );

  const { runScheduledCommands } = await import("../src/scheduler.js");
  await runScheduledCommands(telegram, agent, chatId);

  console.info("[test-scheduler] done.");
}

main().catch((err) => {
  console.error("[test-scheduler] fatal:", err);
  process.exit(1);
});
