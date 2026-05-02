import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions — vi.hoisted ensures these exist before vi.mock
// factories run (vi.mock is hoisted to the top of the file by Vitest).
// ---------------------------------------------------------------------------
const {
  mockMembersGet,
  mockMembersList,
  mockSpacesList,
  mockMessagesList,
  mockPeopleGet,
  mockIsGchatConfigured,
  mockGetAuthorizedClient,
  mockLoadGchatState,
  mockSaveGchatState,
  mockStartGchatAuthFlow,
  mockListSpaces,
  mockListMessagesSince,
  mockResolveMyResourceName,
  mockResolveDisplayNames,
  realImpls,
} = vi.hoisted(() => ({
  mockMembersGet: vi.fn(),
  mockMembersList: vi.fn(),
  mockSpacesList: vi.fn().mockResolvedValue({ data: { spaces: [] } }),
  mockMessagesList: vi.fn().mockResolvedValue({ data: { messages: [] } }),
  mockPeopleGet: vi.fn(),
  mockIsGchatConfigured: vi.fn().mockReturnValue(true),
  mockGetAuthorizedClient: vi.fn().mockResolvedValue({
    getAccessToken: vi.fn().mockResolvedValue({ token: "fake" }),
  }),
  mockLoadGchatState: vi
    .fn()
    .mockResolvedValue({ refreshToken: "fake-token", lastCheckedAt: {} }),
  mockSaveGchatState: vi.fn().mockResolvedValue(undefined),
  mockStartGchatAuthFlow: vi.fn().mockResolvedValue(undefined),
  mockListSpaces: vi.fn().mockResolvedValue([]),
  mockListMessagesSince: vi.fn().mockResolvedValue([]),
  mockResolveMyResourceName: vi.fn(),
  mockResolveDisplayNames: vi.fn(),
  realImpls: {
    resolveMyResourceName: null as ((...args: unknown[]) => unknown) | null,
    resolveDisplayNames: null as ((...args: unknown[]) => unknown) | null,
  },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis
// ---------------------------------------------------------------------------
vi.mock("googleapis", () => ({
  google: {
    chat: () => ({
      spaces: {
        list: mockSpacesList,
        members: {
          get: mockMembersGet,
          list: mockMembersList,
        },
        messages: {
          list: mockMessagesList,
        },
      },
    }),
    people: () => ({
      people: {
        get: mockPeopleGet,
      },
    }),
    auth: { OAuth2: vi.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Mock: src/gchat/auth.ts
// ---------------------------------------------------------------------------
vi.mock("../../gchat/auth.js", () => ({
  isGchatConfigured: (...args: unknown[]) => mockIsGchatConfigured(...args),
  getAuthorizedClient: (...args: unknown[]) =>
    mockGetAuthorizedClient(...args),
  loadGchatState: (...args: unknown[]) => mockLoadGchatState(...args),
  saveGchatState: (...args: unknown[]) => mockSaveGchatState(...args),
  startGchatAuthFlow: (...args: unknown[]) =>
    mockStartGchatAuthFlow(...args),
}));

// ---------------------------------------------------------------------------
// Mock: src/gchat/client.ts (partial — scheduler tests mock these, client
// tests call through to the real implementation via the googleapis mock)
// ---------------------------------------------------------------------------
vi.mock("../../gchat/client.js", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../gchat/client.js");
  realImpls.resolveMyResourceName = actual.resolveMyResourceName as any;
  realImpls.resolveDisplayNames = actual.resolveDisplayNames as any;
  return {
    ...actual,
    listSpaces: (...args: unknown[]) => mockListSpaces(...args),
    listMessagesSince: (...args: unknown[]) =>
      mockListMessagesSince(...args),
    resolveMyResourceName: (...args: unknown[]) =>
      mockResolveMyResourceName(...args),
    resolveDisplayNames: (...args: unknown[]) =>
      mockResolveDisplayNames(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports under test (MUST come after vi.mock calls — Vitest hoists mocks)
// ---------------------------------------------------------------------------
import {
  resolveMyResourceName,
  resolveDisplayNames,
} from "../../gchat/client.js";
import { gchatMorningCheck } from "../../gchat/scheduler.js";
import { handleUpdate } from "../../telegram/handler.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeAuth = {} as Parameters<typeof resolveMyResourceName>[0];

function makeTelegram() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgent() {
  return {
    processMessage: vi.fn().mockResolvedValue({ text: "summary" }),
  };
}

// =========================================================================
// Group 1: resolveMyResourceName
// =========================================================================
describe("resolveMyResourceName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Call through to the real implementation for client-level tests.
    mockResolveMyResourceName.mockImplementation(
      (...args: unknown[]) => realImpls.resolveMyResourceName!(...args),
    );
  });

  it("returns resource name on success", async () => {
    mockPeopleGet.mockResolvedValueOnce({
      data: { resourceName: "people/123" },
    });
    const result = await resolveMyResourceName(fakeAuth, "spaces/test");
    expect(result).toBe("users/123");
  });

  it("returns null when API throws", async () => {
    mockPeopleGet.mockRejectedValueOnce(new Error("API error"));
    const result = await resolveMyResourceName(fakeAuth, "spaces/test");
    expect(result).toBeNull();
  });

  it("calls People API with people/me", async () => {
    mockPeopleGet.mockResolvedValueOnce({
      data: { resourceName: "people/123" },
    });
    await resolveMyResourceName(fakeAuth, "spaces/test");
    expect(mockPeopleGet).toHaveBeenCalledWith({
      resourceName: "people/me",
      personFields: "names",
    });
  });
});
// =========================================================================
// Group 2: resolveDisplayNames
// =========================================================================
describe("resolveDisplayNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Call through to the real implementation for client-level tests.
    mockResolveDisplayNames.mockImplementation(
      (...args: unknown[]) => realImpls.resolveDisplayNames!(...args),
    );
  });

  it("maps resource name to display name", async () => {
    mockMembersList.mockResolvedValueOnce({
      data: {
        memberships: [
          { member: { name: "users/123", displayName: "Alice" } },
        ],
      },
    });
    const map = await resolveDisplayNames(
      fakeAuth,
      "spaces/AAA",
      new Set(["users/123"]),
    );
    expect(map.get("users/123")).toBe("Alice");
  });

  it("falls back to #last6digits when displayName is empty", async () => {
    mockMembersList.mockResolvedValueOnce({
      data: {
        memberships: [
          {
            member: {
              name: "users/118211518023307034771",
              displayName: "",
            },
          },
        ],
      },
    });
    const map = await resolveDisplayNames(
      fakeAuth,
      "spaces/AAA",
      new Set(["users/118211518023307034771"]),
    );
    expect(map.get("users/118211518023307034771")).toBe("#034771");
  });

  it("excludes members not in requested set", async () => {
    mockMembersList.mockResolvedValueOnce({
      data: {
        memberships: [
          { member: { name: "users/111", displayName: "A" } },
          { member: { name: "users/222", displayName: "B" } },
        ],
      },
    });
    const map = await resolveDisplayNames(
      fakeAuth,
      "spaces/AAA",
      new Set(["users/111"]),
    );
    expect(map.has("users/222")).toBe(false);
  });
});
// =========================================================================
// Group 3: gchatMorningCheck — self-filtering
// =========================================================================
describe("gchatMorningCheck — self-filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGchatConfigured.mockReturnValue(true);
    mockGetAuthorizedClient.mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({ token: "t" }),
    });
    mockLoadGchatState.mockResolvedValue({
      refreshToken: "fake-token",
      lastCheckedAt: {},
    });
    mockSaveGchatState.mockResolvedValue(undefined);
    mockListSpaces.mockResolvedValue([
      { name: "spaces/AAA", displayName: "General", type: "ROOM" },
    ]);
  });

  it("filters out self-messages, only other sender reaches LLM", async () => {
    const telegram = makeTelegram();
    const agent = makeAgent();

    mockResolveMyResourceName.mockResolvedValue("users/me");
    mockListMessagesSince.mockResolvedValue([
      {
        name: "spaces/AAA/messages/1",
        spaceName: "spaces/AAA",
        spaceDisplayName: "General",
        senderName: "Me",
        senderResourceName: "users/me",
        text: "my own msg",
        createTime: "2026-01-01T08:00:00Z",
      },
      {
        name: "spaces/AAA/messages/2",
        spaceName: "spaces/AAA",
        spaceDisplayName: "General",
        senderName: "Other",
        senderResourceName: "users/other",
        text: "hello",
        createTime: "2026-01-01T08:01:00Z",
      },
    ]);
    mockResolveDisplayNames.mockResolvedValue(
      new Map([["users/other", "Bob"]]),
    );

    await gchatMorningCheck(telegram as any, agent as any, 42);

    expect(agent.processMessage).toHaveBeenCalledOnce();
    const prompt = agent.processMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("Bob");
    expect(prompt).not.toContain("users/me");
  });
  it("sends no-messages text when all messages are from self", async () => {
    const telegram = makeTelegram();
    const agent = makeAgent();

    mockResolveMyResourceName.mockResolvedValue("users/me");
    mockListMessagesSince.mockResolvedValue([
      {
        name: "spaces/AAA/messages/1",
        spaceName: "spaces/AAA",
        spaceDisplayName: "General",
        senderName: "Me",
        senderResourceName: "users/me",
        text: "my own msg",
        createTime: "2026-01-01T08:00:00Z",
      },
    ]);

    await gchatMorningCheck(telegram as any, agent as any, 42);

    expect(agent.processMessage).not.toHaveBeenCalled();
    const sendCalls = telegram.sendMessage.mock.calls;
    const noMsgCall = sendCalls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes("\u{1F4ED}"),
    );
    expect(noMsgCall).toBeDefined();
  });
});
// =========================================================================
// Group 4: gchatMorningCheck — single send
// =========================================================================
describe("gchatMorningCheck — single send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGchatConfigured.mockReturnValue(true);
    mockGetAuthorizedClient.mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({ token: "t" }),
    });
    mockLoadGchatState.mockResolvedValue({
      refreshToken: "fake-token",
      lastCheckedAt: {},
    });
    mockSaveGchatState.mockResolvedValue(undefined);
    mockListSpaces.mockResolvedValue([
      { name: "spaces/AAA", displayName: "General", type: "ROOM" },
    ]);
  });

  it("sends exactly one message after LLM summary (no raw digest)", async () => {
    const telegram = makeTelegram();
    const agent = makeAgent();
    agent.processMessage.mockResolvedValue({ text: "summary text" });

    mockResolveMyResourceName.mockResolvedValue("users/me");
    mockListMessagesSince.mockResolvedValue([
      {
        name: "spaces/AAA/messages/1",
        spaceName: "spaces/AAA",
        spaceDisplayName: "General",
        senderName: "Other",
        senderResourceName: "users/other",
        text: "hello",
        createTime: "2026-01-01T08:01:00Z",
      },
    ]);
    mockResolveDisplayNames.mockResolvedValue(
      new Map([["users/other", "Bob"]]),
    );

    await gchatMorningCheck(telegram as any, agent as any, 42);

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const sentText = telegram.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain("summary text");
  });
});
// =========================================================================
// Group 5: handleUpdate — auth guard
// =========================================================================
describe("handleUpdate — auth guard", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeDeps() {
    return {
      telegram: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        editMessageText: vi.fn().mockResolvedValue(undefined),
      },
      agent: { processMessage: vi.fn() },
      sessions: {
        isExpired: vi.fn().mockReturnValue(false),
        addUserMessage: vi.fn(),
        getOrCreate: vi.fn().mockReturnValue({
          messages: [],
          addUserMessage: vi.fn(),
          addAssistantMessage: vi.fn(),
        }),
      },
      allowedUserIds: new Set([42]),
    };
  }

  function makeUpdate(text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" as const },
        from: {
          id: 42,
          is_bot: false,
          first_name: "Test",
        },
        text,
      },
    };
  }

  it("gchat command without refresh token sends auth prompt", async () => {
    mockLoadGchatState.mockResolvedValue({
      refreshToken: undefined,
      lastCheckedAt: {},
    });
    const deps = makeDeps();
    await handleUpdate(deps as any, makeUpdate("/gchatfoo"));

    const calls = deps.telegram.sendMessage.mock.calls;
    const authPrompt = calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" &&
        (c[1] as string).includes("Google Chat not connected"),
    );
    expect(authPrompt).toBeDefined();
    expect(mockStartGchatAuthFlow).not.toHaveBeenCalled();
  });
  it("/gchatauth always passes through regardless of token state", async () => {
    mockLoadGchatState.mockResolvedValue({
      refreshToken: undefined,
      lastCheckedAt: {},
    });
    const deps = makeDeps();
    await handleUpdate(deps as any, makeUpdate("/gchatauth"));

    expect(mockStartGchatAuthFlow).toHaveBeenCalled();
    const calls = deps.telegram.sendMessage.mock.calls;
    const authPrompt = calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" &&
        (c[1] as string).includes("Google Chat not connected"),
    );
    expect(authPrompt).toBeUndefined();
  });
});
