import { describe, expect, it } from "vitest";

import { extractLexicalTerms, POSTGRES_LEXICAL_RETRIEVAL_SQL } from "./lexical";

describe("Chinese lexical retrieval", () => {
  it("extracts domain concepts instead of question filler", () => {
    const terms = extractLexicalTerms("请问真空泵是什么？");

    expect(terms).toContain("真空泵");
    expect(terms).toContain("真空");
    expect(terms).not.toContain("是什么");
  });

  it("fails closed for missing, unreviewed, or unlicensed sources", () => {
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain(
      "JOIN knowledge_source ks ON ks.id = kd.source_id"
    );
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).not.toContain(
      "LEFT JOIN knowledge_source"
    );
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain(
      "kv.metadata #>> '{review,status}' = 'approved'"
    );
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain(
      "{rightsDecision,appliesToRecordUrl}"
    );
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain(
      "kv.citation_metadata ->> 'ingestionMode' = 'full_text'"
    );
  });

  it("keeps engineering inputs needed for pump selection", () => {
    const terms = extractLexicalTerms("如何根据目标压力、流导和抽空时间选泵？");

    expect(terms).toEqual(
      expect.arrayContaining(["目标压力", "流导", "抽空时间", "选泵"])
    );
  });

  it("uses a parameterized term array for substring matching", () => {
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain("unnest($1::text[])");
    expect(POSTGRES_LEXICAL_RETRIEVAL_SQL).toContain("strpos(lower");
  });
});
