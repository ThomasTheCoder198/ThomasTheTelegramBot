import type { AgentCore } from "../agent/core.js";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "../constants.js";
import {
  buildSummaryPrompt,
  GCHAT_SUMMARY_FAILED_PREFIX,
  NO_NEW_MESSAGES_TEXT,
  TOKEN_EXPIRED_TEXT,
  type GroupedMessages,
} from "../prompts.js";
import type { TelegramClient } from "../telegram/client.js";
import { markdownToTelegramHtml } from "../telegram/handler.js";
import { clampText, errorMessage } from "../utils.js";
import {
  getAuthorizedClient,
  isGchatConfigured,
  loadGchatState,
  saveGchatState,
} from "./auth.js";
import {
  listMessagesSince,
  listSpaces,
  resolveDisplayNames,
  resolveMyResourceName,
  type GchatMessage,
  type GchatSpace,
} from "./client.js";

function isTokenExpiredError(msg: string): boolean {
  return /invalid_grant|unauthorized|401/i.test(msg);
}

function groupBySpace(
  messages: GchatMessage[],
  spaces: GchatSpace[],
): GroupedMessages[] {
  const bySpace = new Map<string, GchatMessage[]>();
  for (const m of messages) {
    const arr = bySpace.get(m.spaceName);
    if (arr === undefined) bySpace.set(m.spaceName, [m]);
    else arr.push(m);
  }
  const grouped: GroupedMessages[] = [];
  for (const space of spaces) {
    const list = bySpace.get(space.name);
    if (list !== undefined && list.length > 0) {
      grouped.push({ space, messages: list });
    }
  }
  return grouped;
}

export async function gchatMorningCheck(
  telegram: TelegramClient,
  agent: AgentCore,
  chatId: number,
): Promise<void> {
  console.log(`[gchat-scheduler] morning check started chatId=${chatId}`);
  if (!isGchatConfigured()) {
    console.info("[gchat] skipping morning check — OAuth not configured.");
    return;
  }

  let auth;
  try {
    auth = await getAuthorizedClient();
  } catch (err) {
    console.error(`[gchat] failed to load credentials: ${errorMessage(err)}`);
    return;
  }

  if (auth === null) {
    console.info(
      "[gchat] no refresh token saved yet — user needs to run /gchat-auth.",
    );
    return;
  }
  try {
    const tokenResponse = await auth.getAccessToken();
    console.log(
      `[gchat-scheduler] access token refreshed ok | hasToken=${Boolean(tokenResponse.token)}`,
    );
  } catch (err) {
    console.error(`[gchat] token refresh failed: ${errorMessage(err)}`);
    await telegram.sendMessage(chatId, TOKEN_EXPIRED_TEXT).catch(() => {});
    return;
  }

  const state = await loadGchatState();
  const fallbackIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let spaces: GchatSpace[];
  try {
    spaces = await listSpaces(auth);
    console.log(`[gchat-scheduler] found ${spaces.length} space(s)`);
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[gchat] listSpaces failed: ${msg}`);
    if (isTokenExpiredError(msg)) {
      await telegram.sendMessage(chatId, TOKEN_EXPIRED_TEXT).catch(() => {});
    }
    return;
  }

  let myResourceName: string | null = null;
  if (spaces.length > 0) {
    myResourceName = await resolveMyResourceName(auth, spaces[0].name);
    console.log(`[gchat-scheduler] myResourceName=${myResourceName}`);
  }

  const allMessages: GchatMessage[] = [];
  const newLastChecked: Record<string, string> = { ...state.lastCheckedAt };
  const runStartedAt = new Date().toISOString();

  for (const space of spaces) {
    const since = state.lastCheckedAt[space.name] ?? fallbackIso;
    try {
      const msgs = await listMessagesSince(auth, space, since);
      if (msgs.length > 0) {
        allMessages.push(...msgs);
        const newest = msgs[msgs.length - 1].createTime;
        newLastChecked[space.name] = newest;
      } else {
        newLastChecked[space.name] = runStartedAt;
      }
    } catch (err) {
      const msg = errorMessage(err);
      console.error(
        `[gchat] listMessagesSince failed for ${space.displayName}: ${msg}`,
      );
      if (isTokenExpiredError(msg)) {
        await telegram.sendMessage(chatId, TOKEN_EXPIRED_TEXT).catch(() => {});
        return;
      }
    }
  }

  if (allMessages.length === 0) {
    console.log(`[gchat-scheduler] no new messages across all spaces`);
    await telegram.sendMessage(chatId, NO_NEW_MESSAGES_TEXT).catch(() => {});
    state.lastCheckedAt = newLastChecked;
    await saveGchatState(state);
    return;
  }
  const filtered =
    myResourceName !== null
      ? allMessages.filter((m) => m.senderResourceName !== myResourceName)
      : allMessages;
  console.log(
    `[gchat-scheduler] self-filter: ${allMessages.length} -> ${filtered.length} messages`,
  );

  if (filtered.length === 0) {
    console.log(
      `[gchat-scheduler] all messages were from self, nothing to summarize`,
    );
    await telegram.sendMessage(chatId, NO_NEW_MESSAGES_TEXT).catch(() => {});
    state.lastCheckedAt = newLastChecked;
    await saveGchatState(state);
    return;
  }

  const grouped = groupBySpace(filtered, spaces);
  console.log(
    `[gchat-scheduler] total messages=${filtered.length} across ${grouped.length} active space(s)`,
  );

  for (const group of grouped) {
    const uniqueSenders = new Set(
      group.messages
        .map((m) => m.senderResourceName)
        .filter((n) => n.length > 0),
    );
    if (uniqueSenders.size === 0) continue;
    const nameMap = await resolveDisplayNames(
      auth,
      group.space.name,
      uniqueSenders,
    );
    for (const m of group.messages) {
      const resolved = nameMap.get(m.senderResourceName);
      if (resolved !== undefined) {
        m.senderName = resolved;
      }
    }
  }

  const summaryPrompt = buildSummaryPrompt(grouped);
  console.log(
    `[gchat-scheduler] sending summary prompt to LLM promptLength=${summaryPrompt.length}`,
  );
  try {
    void telegram.sendChatAction(chatId, "typing").catch(() => {});
    const result = await agent.processMessage(chatId, summaryPrompt, {});
    const summary = result.text.trim();
    console.log(
      `[gchat-scheduler] LLM summary received length=${summary.length}`,
    );
    if (summary.length > 0) {
      const html = markdownToTelegramHtml(
        clampText(summary, TELEGRAM_MAX_MESSAGE_CHARS),
      );
      await telegram
        .sendMessage(chatId, html, { parse_mode: "HTML" })
        .catch(() => {});
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[gchat] summary generation failed: ${msg}`);
    await telegram
      .sendMessage(chatId, `${GCHAT_SUMMARY_FAILED_PREFIX}${msg}`)
      .catch(() => {});
  }

  state.lastCheckedAt = newLastChecked;
  await saveGchatState(state);
}
