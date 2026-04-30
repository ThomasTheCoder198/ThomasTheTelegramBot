import { AgentCore } from "./agent/core.js";
import { SessionManager } from "./agent/session.js";
import { config } from "./config.js";
import {
  TelegramApiError,
  TelegramClient,
  type TelegramUpdate,
} from "./telegram/client.js";
import { handleUpdate } from "./telegram/handler.js";
import { createDefaultRegistry } from "./tools/registry.js";
import { startScheduler } from "./scheduler.js";

const POLLING_TIMEOUT_SECONDS = 25;
const POLLING_RETRY_DELAY_MS = 5_000;

async function main(): Promise<void> {
  console.info(
    `[startup] LLM Telegram bot booting — model="${config.openrouterModel}", ` +
      `whitelist size=${config.allowedUserIds.size}, session TTL=${config.sessionTtlMinutes}m`,
  );

  const telegram = new TelegramClient(config.telegramBotToken);
  const sessions = new SessionManager(config.sessionTtlMinutes);
  sessions.startCleanup();

  const registry = await createDefaultRegistry();
  console.info(
    `[startup] tool registry loaded with ${registry.size()} tool(s).`,
  );

  const agent = new AgentCore(sessions, registry);
  const handlerDeps = {
    telegram,
    agent,
    sessions,
    allowedUserIds: config.allowedUserIds,
  };

  const userIds = [...config.allowedUserIds];
  if (userIds.length !== 1) {
    console.warn(
      `[scheduler] expected exactly 1 allowed user for auto-scheduling, got ${userIds.length}; scheduler disabled.`,
    );
  } else {
    startScheduler(telegram, agent, userIds[0], config.schedulerCron);
  }

  let running = true;
  let offset: number | undefined;

  const pollOnce = async (): Promise<void> => {
    let updates: TelegramUpdate[];
    try {
      updates = await telegram.getUpdates(offset, POLLING_TIMEOUT_SECONDS, [
        "message",
        "edited_message",
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TelegramApiError && err.errorCode === 409) {
        console.error(
          `[poll] conflict: another getUpdates instance is active for this token. Retrying in ${POLLING_RETRY_DELAY_MS}ms.`,
        );
      } else {
        console.error(
          `[poll] getUpdates failed: ${message}. Retrying in ${POLLING_RETRY_DELAY_MS}ms.`,
        );
      }
      await delay(POLLING_RETRY_DELAY_MS);
      return;
    }

    for (const update of updates) {
      try {
        await handleUpdate(handlerDeps, update);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[poll] handler crashed for update ${update.update_id}: ${message}`,
        );
      }
      const next = update.update_id + 1;
      if (offset === undefined || next > offset) offset = next;
    }
  };

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    console.info(`[shutdown] received ${signal}; stopping.`);
    sessions.stopCleanup();
    console.info("[shutdown] bye.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.info("[startup] entering long-polling loop.");
  while (running) {
    await pollOnce();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
