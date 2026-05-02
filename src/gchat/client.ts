import type { OAuth2Client } from "google-auth-library";
import { google, type chat_v1 } from "googleapis";
import { GCHAT_PAGE_SIZE } from "../constants.js";
import { errorMessage } from "../utils.js";

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

/**
 * Resolve sender resource names to human-readable display names by fetching
 * the space membership list. Returns a Map from resource name to display name.
 * Only entries matching `senderResourceNames` are included.
 * Falls back to `#` + last 6 digits for empty display names.
 */
export async function resolveDisplayNames(
  auth: OAuth2Client,
  spaceName: string,
  senderResourceNames: Set<string>,
): Promise<Map<string, string>> {
  const chat = buildChatClient(auth);
  const nameMap = new Map<string, string>();

  try {
    const res = await chat.spaces.members.list({
      parent: spaceName,
      pageSize: GCHAT_PAGE_SIZE,
    });
    const members = res.data.memberships ?? [];
    for (const membership of members) {
      const memberName = membership.member?.name;
      if (typeof memberName !== "string") continue;
      if (!senderResourceNames.has(memberName)) continue;

      const displayName = membership.member?.displayName;
      if (typeof displayName === "string" && displayName.length > 0) {
        nameMap.set(memberName, displayName);
      } else {
        // Fallback: # + last 6 digits of resource name
        nameMap.set(memberName, `#${memberName.slice(-6)}`);
      }
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      `[gchat-client] resolveDisplayNames failed space="${spaceName}": ${msg}`,
    );
  }

  console.log(
    `[gchat-client] resolveDisplayNames space="${spaceName}" resolved=${nameMap.size}`,
  );
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
      console.warn(`[gchat-client] resolveMyResourceName: no resourceName in People API response`);
      return null;
    }
    const chatResourceName = peopleResourceName.replace(/^people\//, "users/");
    console.log(`[gchat-client] resolveMyResourceName: ${peopleResourceName} → ${chatResourceName}`);
    return chatResourceName;
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[gchat-client] resolveMyResourceName failed: ${msg}`);
    return null;
  }
}
