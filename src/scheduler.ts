import cron from "node-cron";
import type { AgentCore } from "./agent/core.js";
import type { TelegramClient } from "./telegram/client.js";
import { COMMAND_MAP, markdownToTelegramHtml } from "./telegram/handler.js";

const SCHEDULED_COMMANDS = ["/briefing"] as const;
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export async function runScheduledCommands(
  telegram: TelegramClient,
  agent: AgentCore,
  chatId: number,
): Promise<void> {
  console.info("[scheduler] firing scheduled commands");
  for (const command of SCHEDULED_COMMANDS) {
    const prompt = COMMAND_MAP[command];
    if (prompt === undefined) continue;
    try {
      void telegram.sendChatAction(chatId, "typing").catch(() => {});
      const result = await agent.processMessage(chatId, prompt, {});
      const text = result.text.trim() || "No response received.";
      const html = markdownToTelegramHtml(
        text.length > TELEGRAM_MAX_MESSAGE_CHARS
          ? text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1) + "…"
          : text,
      );
      await telegram.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] ${command} failed: ${msg}`);
      await telegram
        .sendMessage(chatId, `[Scheduler] ${command} thất bại: ${msg}`)
        .catch(() => {});
    }
  }
}

export function startScheduler(
  telegram: TelegramClient,
  agent: AgentCore,
  chatId: number,
  cronExpression: string,
): void {
  cron.schedule(
    cronExpression,
    () => void runScheduledCommands(telegram, agent, chatId),
    { timezone: "Asia/Ho_Chi_Minh" },
  );
  console.info(
    `[scheduler] scheduled commands registered — cron="${cronExpression}" tz=Asia/Ho_Chi_Minh chatId=${chatId}`,
  );
}
