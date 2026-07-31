import { describe, expect, it } from "vitest";

import {
  adminModuleConfigs,
  extractAdminRows,
  normalizeKnowledgeDocuments
} from "./admin-data";

describe("admin API response normalization", () => {
  it("accepts rows returned directly in the shared data envelope", () => {
    expect(
      extractAdminRows(
        {
          data: [
            {
              id: "user-1",
              email: "user@example.com",
              banned: false,
              dailyQuotaBonus: 2
            }
          ]
        },
        "users"
      )
    ).toEqual([
      {
        id: "user-1",
        email: "user@example.com",
        banned: false,
        dailyQuotaBonus: 2
      }
    ]);
  });

  it("accepts paginated items and named budget arrays", () => {
    expect(
      extractAdminRows(
        { data: { items: [{ id: "source-1", name: "Atlas Copco" }] } },
        "sources"
      )
    ).toEqual([{ id: "source-1", name: "Atlas Copco" }]);

    expect(
      extractAdminRows(
        {
          data: {
            budgets: [
              {
                model: "deepseek-chat",
                dailyLimitCents: 100,
                monthlyLimitCents: 2000,
                enabled: true
              }
            ]
          }
        },
        "models"
      )
    ).toEqual([
      {
        model: "deepseek-chat",
        dailyLimitCents: 100,
        monthlyLimitCents: 2000,
        enabled: true
      }
    ]);
  });

  it("uses the real fields selected by each admin API", () => {
    expect(adminModuleConfigs.users.columns).toContain("dailyQuotaBonus");
    expect(adminModuleConfigs.conversations.columns).toContain("model");
    expect(adminModuleConfigs.sources.columns).toContain("licensePolicy");
    expect(adminModuleConfigs.prompts.columns).toContain("key");
    expect(adminModuleConfigs.models.columns).toContain("monthlyLimitCents");
    expect(adminModuleConfigs.admins.columns).toContain("createdBy");
    expect(adminModuleConfigs.audit.columns).toContain("actorUserId");
  });
});

describe("knowledge detail normalization", () => {
  it("keeps the current bare document response safe and publish-blocked", () => {
    expect(
      normalizeKnowledgeDocuments({
        data: {
          items: [
            {
              id: "document-1",
              title: "旋片泵维护手册",
              status: "review",
              sourceId: "source-1",
              currentVersionId: "version-1",
              updatedAt: "2026-07-31T08:00:00.000Z"
            }
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: "document-1",
        title: "旋片泵维护手册",
        status: "review",
        sourceId: "source-1",
        currentVersionId: "version-1",
        publishReady: undefined,
        publishBlockers: []
      })
    ]);
  });

  it("normalizes nested source, review, embedding and publication detail", () => {
    expect(
      normalizeKnowledgeDocuments({
        data: {
          documents: [
            {
              id: "document-2",
              title: "真空计校准指南",
              status: "review",
              source: {
                id: "source-2",
                name: "OpenVac 内部资料",
                sourceTier: "internal",
                licensePolicy: "internal-use",
                enabled: true
              },
              currentVersion: {
                id: "version-2",
                version: 3,
                status: "review",
                contentHash:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                citationMetadata: { ingestionMode: "full_text" },
                metadata: {
                  reviewStatus: "approved",
                  embeddingStatus: "completed",
                  embeddingModel: "text-embedding-v3",
                  review: {
                    reviewedBy: "knowledge-editor-1",
                    reviewedAt: "2026-07-31T08:30:00.000Z"
                  }
                }
              },
              chunkCount: 12,
              embeddedChunkCount: 12,
              publishability: { ready: true, blockers: [] }
            }
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        sourceName: "OpenVac 内部资料",
        sourceTier: "internal",
        licensePolicy: "internal-use",
        currentVersionId: "version-2",
        version: 3,
        reviewStatus: "approved",
        reviewedBy: "knowledge-editor-1",
        embeddingStatus: "completed",
        embeddingModel: "text-embedding-v3",
        chunkCount: 12,
        embeddedChunkCount: 12,
        publishReady: true
      })
    ]);
  });
});
