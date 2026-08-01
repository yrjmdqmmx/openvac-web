import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiStore } from "./types";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn()
}));
const accountCleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession
    }
  }
}));
vi.mock("@/server/auth/account-cleanup", () => accountCleanupMocks);

import {
  handleListConversations,
  handleSearchConversations
} from "./conversations";

function storeWithList(listConversations: ApiStore["listConversations"]) {
  return { listConversations } as ApiStore;
}

describe("conversation list handlers", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        banned: false
      }
    });
  });

  it("lists the first page without a search query", async () => {
    const listConversations = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });

    const response = await handleListConversations(
      new Request("https://openvac.test/api/conversations"),
      storeWithList(listConversations)
    );

    expect(response.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith("user-1", {
      page: 1,
      pageSize: 20,
      query: undefined,
      status: undefined
    });
  });

  it("passes the server search query and pagination to the scoped store", async () => {
    const listConversations = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 10,
      total: 0
    });

    const response = await handleSearchConversations(
      new Request(
        "https://openvac.test/api/conversations/search?q=%E6%97%8B%E7%89%87%E6%B3%B5&page=2&pageSize=10"
      ),
      storeWithList(listConversations)
    );

    expect(response.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith("user-1", {
      page: 2,
      pageSize: 10,
      query: "旋片泵",
      status: undefined
    });
  });

  it("rejects an empty search without calling the store", async () => {
    const listConversations = vi.fn();

    const response = await handleSearchConversations(
      new Request("https://openvac.test/api/conversations/search?q="),
      storeWithList(listConversations)
    );

    expect(response.status).toBe(422);
    expect(listConversations).not.toHaveBeenCalled();
  });
});
