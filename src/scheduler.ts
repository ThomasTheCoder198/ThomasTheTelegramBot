import cron from "node-cron";
import type { AgentCore } from "./agent/core.js";
import { TELEGRAM_MAX_MESSAGE_CHARS, TIMEZONE } from "./constants.js";
import { gchatMorningCheck } from "./gchat/scheduler.js";
import {
  buildCommandText,
  SCHEDULER_FAILED_PREFIX,
  SCHEDULER_FAILED_SUFFIX,
  SCHEDULER_NO_RESPONSE,
} from "./prompts.js";
import type { TelegramClient } from "./telegram/client.js";
import { markdownToTelegramHtml } from "./telegram/handler.js";
import { clampText, errorMessage } from "./utils.js";

const SCHEDULED_COMMANDS = ["/briefing"] as const;

export async function runScheduledCommands(
  telegram: TelegramClient,
  agent: AgentCore,
  chatId: number,
): Promise<void> {
  console.info("[scheduler] firing scheduled commands");
  for (const command of SCHEDULED_COMMANDS) {
    const prompt = buildCommandText(command);
    if (prompt === undefined) continue;
    try {
      void telegram.sendChatAction(chatId, "typing").catch(() => {});
      const result = await agent.processMessage(chatId, prompt, {});
      const text = result.text.trim() || SCHEDULER_NO_RESPONSE;
      const html = markdownToTelegramHtml(
        clampText(text, TELEGRAM_MAX_MESSAGE_CHARS),
      );
      await telegram.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[scheduler] ${command} failed: ${msg}`);
      await telegram
        .sendMessage(chatId, `${SCHEDULER_FAILED_PREFIX}${command}${SCHEDULER_FAILED_SUFFIX}${msg}`)
        .catch(() => {});
    }
  }

  await gchatMorningCheck(telegram, agent, chatId).catch((err) => {
    console.error(`[scheduler] gchatMorningCheck failed: ${errorMessage(err)}`);
  });
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
    { timezone: TIMEZONE },
  );
  console.info(
    `[scheduler] scheduled commands registered — cron="${cronExpression}" tz=${TIMEZONE} chatId=${chatId}`,
  );
}
