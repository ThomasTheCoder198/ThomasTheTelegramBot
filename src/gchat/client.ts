import type { OAuth2Client } from "google-auth-library";
import { google, type chat_v1 } from "googleapis";
import { GCHAT_PAGE_SIZE } from "../constants.js";
import type { GroupedMessages } from "../prompts.js";
import { errorMessage } from "../utils.js";

export function formatMessages(grouped: GroupedMessages[]): string {
  const lines: string[] = [];

  for (const group of grouped) {
    lines.push("───────────");
    lines.push("");
    lines.push(`📬 **${group.space.displayName.toUpperCase()}**`);
    lines.push("");

    for (const msg of group.messages) {
      const dt = new Date(msg.createTime);
      const date = dt.toLocaleDateString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
      });
      const time = dt.toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`• **${msg.senderName}** | ⏰ ${time} ${date} `);
      lines.push(`💬 "${msg.text}"`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

export interface GchatSpace {
  /** Resource name, e.g. "spaces/AAA..." */
  name: string;
  /** Display name for groups/rooms; may be empty for DMs. */
  displayName: string;
  type: string;
}

export interface GchatMessage {
  name: string;
  spaceName: string;
  spaceDisplayName: string;
  senderName: string;
  senderResourceName: string;
  text: string;
  createTime: string;
}

function buildChatClient(auth: OAuth2Client): chat_v1.Chat {
  return google.chat({ version: "v1", auth });
}

export async function listSpaces(auth: OAuth2Client): Promise<GchatSpace[]> {
  const chat = buildChatClient(auth);
  const spaces: GchatSpace[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    page++;
    const res = await chat.spaces.list({
      pageSize: GCHAT_PAGE_SIZE,
      pageToken,
    });
    const items = res.data.spaces ?? [];
    console.log(`[gchat-client] listSpaces page=${page} items=${items.length}`);
    for (const s of items) {
      if (typeof s.name !== "string") continue;
      spaces.push({
        name: s.name,
        displayName:
          typeof s.displayName === "string" && s.displayName.length > 0
            ? s.displayName
            : s.spaceType === "DIRECT_MESSAGE"
              ? "Direct message"
              : (s.name ?? "Unknown"),
        type: s.spaceType ?? s.type ?? "UNKNOWN",
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined && pageToken.length > 0);

  console.log(`[gchat-client] listSpaces total=${spaces.length} spaces`);
  return spaces;
}

export async function listMessagesSince(
  auth: OAuth2Client,
  space: GchatSpace,
  sinceIso: string,
): Promise<GchatMessage[]> {
  const chat = buildChatClient(auth);
  const filter = `createTime > "${sinceIso}"`;
  const messages: GchatMessage[] = [];
  let pageToken: string | undefined;
  let page = 0;
  console.log(
    `[gchat-client] listMessagesSince space="${space.displayName}" since=${sinceIso}`,
  );

  do {
    page++;
    const res = await chat.spaces.messages.list({
      parent: space.name,
      pageSize: GCHAT_PAGE_SIZE,
      filter,
      orderBy: "createTime ASC",
      pageToken,
    });
    const items = res.data.messages ?? [];
    console.log(
      `[gchat-client] listMessagesSince space="${space.displayName}" page=${page} rawItems=${items.length}`,
    );
    for (const m of items) {
      if (typeof m.name !== "string") continue;
      const createTime =
        typeof m.createTime === "string"
          ? m.createTime
          : new Date().toISOString();
      const sender =
        m.sender?.displayName ?? m.sender?.name ?? "Unknown sender";
      const senderResourceName = m.sender?.name ?? "";
      const text = typeof m.text === "string" ? m.text : "";
      console.log(
        `[gchat-client] message senderResourceName=${senderResourceName}, senderDisplayName=${m.sender?.displayName}`,
      );
      if (text.length === 0) continue;
      messages.push({
        name: m.name,
        spaceName: space.name,
        spaceDisplayName: space.displayName,
        senderName: sender,
        senderResourceName,
        text,
        createTime,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined && pageToken.length > 0);

  console.log(
    `[gchat-client] listMessagesSince space="${space.displayName}" total=${messages.length} messages`,
  );
  return messages;
}

export async function resolveDisplayNames(
  auth: OAuth2Client,
  _spaceName: string,
  senderResourceNames: Set<string>,
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();

  if (senderResourceNames.size === 0) return nameMap;

  const senderArray = Array.from(senderResourceNames);
  console.log(
    `[gchat-client] resolveDisplayNames: looking up ${senderArray.length} senders via People API`,
  );

  const resolved = await resolveViaPeopleApi(auth, senderArray);
  for (const [key, value] of resolved) {
    nameMap.set(key, value);
  }

  for (const senderName of senderArray) {
    if (!nameMap.has(senderName)) {
      console.log(
        `[gchat-client] no name found for ${senderName}, using fallback`,
      );
      nameMap.set(senderName, `#${senderName.slice(-6)}`);
    }
  }

  console.log(
    `[gchat-client] resolveDisplayNames final: ${Array.from(nameMap.values()).join(", ")}`,
  );
  return nameMap;
}

async function resolveViaPeopleApi(
  auth: OAuth2Client,
  senderResourceNames: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();

  for (const sender of senderResourceNames) {
    if (!sender.startsWith("users/") && !sender.startsWith("people/")) continue;

    const personId = sender.replace(/^(users|people)\//, "");
    if (!personId) continue;

    try {
      const people = google.people({ version: "v1", auth });
      const res = await people.people.get({
        resourceName: `people/${personId}`,
        personFields: "names",
      });
      console.log(
        `[gchat-client] People API response for ${personId}: ${JSON.stringify(res.data)}`,
      );
      const person = res.data;
      const name = person.names?.[0]?.displayName;
      if (name) {
        nameMap.set(sender, name);
      }
    } catch (err) {
      console.error(
        `[gchat-client] People API error for ${personId}: ${errorMessage(err)}`,
      );
    }
  }

  return nameMap;
}

/**
 * Identify the authenticated user's Chat resource name via the People API.
 * Calls people.get('people/me') and converts the people/ prefix to users/.
 * The spaceName parameter is accepted for call-site compatibility but unused.
 * Returns null on error.
 */
export async function resolveMyResourceName(
  auth: OAuth2Client,
  _spaceName: string,
): Promise<string | null> {
  try {
    const people = google.people({ version: "v1", auth });
    const res = await people.people.get({
      resourceName: "people/me",
      personFields: "names",
    });
    const peopleResourceName = res.data.resourceName;
    if (typeof peopleResourceName !== "string") {
      console.warn(
        `[gchat-client] resolveMyResourceName: no resourceName in People API response`,
      );
      return null;
    }
    const chatResourceName = peopleResourceName.replace(/^people\//, "users/");
    console.log(
      `[gchat-client] resolveMyResourceName: ${peopleResourceName} → ${chatResourceName}`,
    );
    return chatResourceName;
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[gchat-client] resolveMyResourceName failed: ${msg}`);
    return null;
  }
}

/**
 * Get the authenticated user's last-read timestamp for a space.
 * Returns null if no read state exists (meaning all messages are unread).
 */
export async function getSpaceReadTime(
  auth: OAuth2Client,
  spaceName: string,
): Promise<string | null> {
  const chat = buildChatClient(auth);
  const spaceId = spaceName.replace(/^spaces\//, "");
  try {
    const res = await chat.users.spaces.getSpaceReadState({
      name: `users/me/spaces/${spaceId}/spaceReadState`,
    });
    const readTime = res.data.lastReadTime;
    if (typeof readTime !== "string") {
      return null;
    }
    console.log(
      `[gchat-client] getSpaceReadTime space=${spaceName} readTime=${readTime}`,
    );
    return readTime;
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      `[gchat-client] getSpaceReadTime failed space=${spaceName}: ${msg}`,
    );
    return null;
  }
}
