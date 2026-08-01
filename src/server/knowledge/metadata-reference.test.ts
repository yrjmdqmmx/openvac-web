import { describe, expect, it, vi } from "vitest";

import {
  extractPatentPublicationNumbers,
  POSTGRES_PATENT_METADATA_REFERENCE_SQL,
  retrievePatentMetadataReferences
} from "./metadata-reference";

describe("extractPatentPublicationNumbers", () => {
  it("extracts only explicit US and CN publication numbers", () => {
    expect(
      extractPatentPublicationNumbers(
        "比较 us 7674096 b2、CN-221568833-U 和 US7674096B2"
      )
    ).toEqual(["US7674096B2", "CN221568833U"]);
  });

  it("rejects partial, numeric-only, embedded, and semantic patent queries", () => {
    expect(extractPatentPublicationNumbers("US7674096 怎么样")).toEqual([]);
    expect(extractPatentPublicationNumbers("查 7674096 和 221568833")).toEqual(
      []
    );
    expect(extractPatentPublicationNumbers("XUS7674096B2Y")).toEqual([]);
    expect(extractPatentPublicationNumbers("找单级旋片真空泵专利")).toEqual([]);
  });

  it("caps the exact lookup set", () => {
    expect(
      extractPatentPublicationNumbers(
        "US7674096B2 US1234567A1 US2345678B2 CN221568833U CN123456789A"
      )
    ).toHaveLength(4);
  });
});

describe("retrievePatentMetadataReferences", () => {
  it("does not touch the database without an explicit publication number", async () => {
    const execute = vi.fn();
    await expect(
      retrievePatentMetadataReferences("单级旋片真空泵怎么选？", execute)
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("queries exact numbers and maps approved metadata evidence", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        document_id: "document-1",
        version_id: "version-1",
        title: "Single stage rotary vane vacuum pump",
        content: "该摘要只描述专利文件披露的结构，不构成独立性能验证。",
        source_id: "source-1",
        publisher: "United States Patent and Trademark Office",
        canonical_url: "https://patents.example/US7674096B2",
        publication_number: "US7674096B2",
        citation_metadata: {
          bibliographicVerifiedAt: "2026-08-01T00:00:00.000Z"
        }
      }
    ]);

    const evidence = await retrievePatentMetadataReferences(
      "US7674096B2 说明了什么？",
      execute
    );

    expect(execute).toHaveBeenCalledWith(
      POSTGRES_PATENT_METADATA_REFERENCE_SQL,
      [["US7674096B2"]]
    );
    expect(evidence).toEqual([
      {
        citation: {
          sourceId: "source-1:metadata:version-1",
          title: "Single stage rotary vane vacuum pump",
          publisher: "United States Patent and Trademark Office",
          url: "https://patents.example/US7674096B2",
          pageOrSection: "专利公开号 US7674096B2（元数据摘要）",
          fetchedAt: "2026-08-01T00:00:00.000Z",
          licenseClass: "metadata_only"
        },
        excerpt: "该摘要只描述专利文件披露的结构，不构成独立性能验证。"
      }
    ]);
  });

  it("drops malformed or unrelated rows returned by the executor", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        version_id: "version-2",
        title: "Wrong patent",
        content: "无关内容，但长度足够。",
        source_id: "source-2",
        publisher: "Publisher",
        canonical_url: "https://user:password@example.com/patent",
        publication_number: "CN221568833U",
        citation_metadata: {
          bibliographicVerifiedAt: "not-a-date"
        }
      }
    ]);

    await expect(
      retrievePatentMetadataReferences("US7674096B2", execute)
    ).resolves.toEqual([]);
  });
});

describe("POSTGRES_PATENT_METADATA_REFERENCE_SQL", () => {
  it("enforces publication, review, rights, URL, and metadata-only gates", () => {
    const sql = POSTGRES_PATENT_METADATA_REFERENCE_SQL;
    expect(sql).toContain("kv.status = 'published'");
    expect(sql).toContain("kd.status = 'published'");
    expect(sql).toContain("kd.current_version_id = kv.id");
    expect(sql).toContain("kv.metadata #>> '{review,status}' = 'approved'");
    expect(sql).toContain("ks.kind = 'patent'");
    expect(sql).toContain("ks.source_tier = 'metadata_only'");
    expect(sql).toContain("kd.mime_type LIKE '%patent-metadata%'");
    expect(sql).toContain("'summaryAuthorship'");
    expect(sql).toContain("'legalStatusDisclaimer'");
    expect(sql).toContain("'claimLocators'");
    expect(sql).toContain("'figureLocators'");
    expect(sql).toContain("'technicalUseWarnings'");
    expect(sql).toContain("ks.enabled = TRUE");
    expect(sql).toContain("ks.deleted_at IS NULL");
    expect(sql).toContain(
      "ks.metadata #>> '{rightsDecision,status}' = 'approved'"
    );
    expect(sql).toContain(
      "ks.metadata #>> '{rightsDecision,scope}' = 'metadata_only'"
    );
    expect(sql).toContain("'{rightsDecision,appliesToRecordUrl}'");
    expect(sql).toContain("ks.canonical_url ~ '^https://");
  });

  it("never reads chunks, embeddings, or semantic-search operators", () => {
    expect(POSTGRES_PATENT_METADATA_REFERENCE_SQL).not.toMatch(
      /knowledge_chunk|embedding|<=>|tsvector|tsquery/iu
    );
  });
});
