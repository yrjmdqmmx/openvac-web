import { describe, expect, it } from "vitest";

import {
  assertKnowledgePublicationEvidence,
  assertKnowledgeSourceAuthorized,
  KnowledgeSourcePolicyError,
  type GovernedKnowledgeSource
} from "./source-policy";

const canonicalUrl = "https://cds.cern.ch/record/2929324";

function source(
  patch: Partial<GovernedKnowledgeSource> = {}
): GovernedKnowledgeSource {
  return {
    sourceTier: "open_license",
    enabled: true,
    deletedAt: null,
    canonicalUrl,
    publisher: "CERN",
    metadata: {
      rightsDecision: {
        status: "approved",
        scope: "full_text",
        appliesToRecordUrl: canonicalUrl
      }
    },
    ...patch
  };
}

describe("knowledge source authorization policy", () => {
  it("allows record-scoped approved open-license full text", () => {
    expect(() =>
      assertKnowledgeSourceAuthorized(source(), {
        ingestionMode: "full_text"
      })
    ).not.toThrow();
  });

  it.each([
    [undefined, "KNOWLEDGE_SOURCE_REQUIRED"],
    [source({ enabled: false }), "KNOWLEDGE_SOURCE_DISABLED"],
    [source({ deletedAt: new Date() }), "KNOWLEDGE_SOURCE_DELETED"],
    [
      source({ canonicalUrl: "http://example.com/manual" }),
      "KNOWLEDGE_SOURCE_URL_INVALID"
    ],
    [source({ publisher: "  " }), "KNOWLEDGE_SOURCE_PUBLISHER_REQUIRED"]
  ] as const)(
    "rejects an unavailable or incomplete source",
    (candidate, code) => {
      expectPolicyError(
        () =>
          assertKnowledgeSourceAuthorized(candidate, {
            ingestionMode: "full_text"
          }),
        code
      );
    }
  );

  it.each([
    "metadata_only",
    "manufacturer_metadata",
    "standard_metadata"
  ] as const)("keeps %s sources metadata-only", (sourceTier) => {
    expectPolicyError(
      () =>
        assertKnowledgeSourceAuthorized(source({ sourceTier }), {
          ingestionMode: "full_text"
        }),
      "SOURCE_LICENSE_RESTRICTED"
    );
    expect(() =>
      assertKnowledgeSourceAuthorized(source({ sourceTier }), {
        ingestionMode: "metadata_only"
      })
    ).not.toThrow();
  });

  it("does not let the legacy open-license boolean bypass rightsDecision", () => {
    expectPolicyError(
      () =>
        assertKnowledgeSourceAuthorized(
          source({ metadata: { rightsReviewed: true } }),
          { ingestionMode: "full_text" }
        ),
      "SOURCE_RIGHTS_DECISION_REQUIRED"
    );
  });

  it.each([
    {
      status: "rejected",
      scope: "full_text",
      appliesToRecordUrl: canonicalUrl
    },
    {
      status: "approved",
      scope: "metadata_only",
      appliesToRecordUrl: canonicalUrl
    },
    {
      status: "approved",
      scope: "full_text",
      appliesToRecordUrl: "https://cds.cern.ch/record/other"
    }
  ])("rejects a non-applicable rights decision", (rightsDecision) => {
    expectPolicyError(
      () =>
        assertKnowledgeSourceAuthorized(
          source({ metadata: { rightsReviewed: true, rightsDecision } }),
          { ingestionMode: "full_text" }
        ),
      "SOURCE_RIGHTS_DECISION_INVALID"
    );
  });

  it("accepts legacy commercial-AI approval for internal full text", () => {
    expect(() =>
      assertKnowledgeSourceAuthorized(
        source({
          sourceTier: "internal",
          metadata: { commercialAiRightsConfirmed: true }
        }),
        { ingestionMode: "full_text" }
      )
    ).not.toThrow();
  });

  it("does not let commercial approval override a rejected structured decision", () => {
    expectPolicyError(
      () =>
        assertKnowledgeSourceAuthorized(
          source({
            sourceTier: "internal",
            metadata: {
              commercialAiRightsConfirmed: true,
              rightsDecision: {
                status: "rejected",
                scope: "full_text",
                appliesToRecordUrl: canonicalUrl
              }
            }
          }),
          { ingestionMode: "full_text" }
        ),
      "SOURCE_RIGHTS_DECISION_INVALID"
    );
  });

  it("requires explicit commercial-AI approval for internal full text", () => {
    expectPolicyError(
      () =>
        assertKnowledgeSourceAuthorized(
          source({ sourceTier: "internal", metadata: {} }),
          { ingestionMode: "full_text" }
        ),
      "SOURCE_COMMERCIAL_AI_RIGHTS_REQUIRED"
    );
  });

  it("blocks publication while the CERN 2014 official binary recheck is pending", () => {
    expectPolicyError(
      () =>
        assertKnowledgePublicationEvidence(source(), {
          ingestionMode: "full_text",
          excerptVerification: {
            officialPublishedPdfBinaryStatus: "pending_2014_anubis_recheck"
          }
        }),
      "KNOWLEDGE_OFFICIAL_BINARY_RECHECK_REQUIRED"
    );
  });

  it("allows publication evidence without a pending binary gate", () => {
    expect(() =>
      assertKnowledgePublicationEvidence(source(), {
        ingestionMode: "full_text",
        excerptVerification: {
          officialPublishedPdfBinaryStatus: "complete"
        }
      })
    ).not.toThrow();
    expect(() =>
      assertKnowledgePublicationEvidence(source(), {
        ingestionMode: "metadata_only"
      })
    ).not.toThrow();
  });

  it("requires complete binary evidence when the governed source says it is required", () => {
    const gatedSource = source({
      metadata: {
        ...source().metadata,
        officialPublishedPdfBinaryRequired: true
      }
    });
    expectPolicyError(
      () =>
        assertKnowledgePublicationEvidence(gatedSource, {
          ingestionMode: "full_text"
        }),
      "KNOWLEDGE_OFFICIAL_BINARY_RECHECK_REQUIRED"
    );
  });
});

function expectPolicyError(
  action: () => void,
  code: KnowledgeSourcePolicyError["code"]
): void {
  try {
    action();
    throw new Error("Expected source policy to reject the source.");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeSourcePolicyError);
    expect((error as KnowledgeSourcePolicyError).code).toBe(code);
  }
}
