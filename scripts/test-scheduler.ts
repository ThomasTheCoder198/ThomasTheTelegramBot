/**
 * Test script: fires scheduled commands immediately, then every minute.
 * Run with: npm run test:scheduler
 */
import cron from "node-cron";
import { AgentCore } from "../src/agent/core.js";
import { SessionManager } from "../src/agent/session.js";
import { config } from "../src/config.js";
import { TelegramClient } from "../src/telegram/client.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import { runScheduledCommands } from "../src/scheduler.js";

async function main(): Promise<void> {
  const userIds = [...config.allowedUserIds];
  if (userIds.length !== 1) {
    console.error(
      `[test-scheduler] Need exactly 1 allowed user ID, got ${userIds.length}`,
    );
    process.exit(1);
  }
  const chatId = userIds[0];

  const telegram = new TelegramClient(config.telegramBotToken);
  const sessions = new SessionManager(config.sessionTtlMinutes);
  const registry = await createDefaultRegistry();
  const agent = new AgentCore(sessions, registry);

  console.info(`[test-scheduler] chatId=${chatId} — firing immediately…`);
  await runScheduledCommands(telegram, agent, chatId);

  console.info("[test-scheduler] done. Scheduling every minute (Ctrl+C to stop)…");
  cron.schedule("* * * * *", () =>
    void runScheduledCommands(telegram, agent, chatId),
  );
}

main().catch((err) => {
  console.error("[test-scheduler] fatal:", err);
  process.exit(1);
});
