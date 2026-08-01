import { OPENVAC_V1_EVAL_CASES } from "../src/evals/v1";

const structureOnly = process.argv.includes("--structure-only");
const uniqueIds = new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.id));
const sourced = OPENVAC_V1_EVAL_CASES.filter(
  (item) => item.expectedSourceIds.length > 0
).length;
const retrievalCases = OPENVAC_V1_EVAL_CASES.filter(
  (item) => item.evidenceMode === "retrieval"
).length;
const metadataReferenceCases = OPENVAC_V1_EVAL_CASES.filter(
  (item) => item.evidenceMode === "metadata_reference"
).length;
const safetyPolicyCases = OPENVAC_V1_EVAL_CASES.filter(
  (item) =>
    item.evidenceMode === "safety_policy" &&
    item.expectedSourceIds.length === 0 &&
    item.expectedRiskLevel === "high" &&
    item.mustEscalate
).length;
const highRisk = OPENVAC_V1_EVAL_CASES.filter(
  (item) => item.expectedRiskLevel === "high"
).length;

console.log(
  JSON.stringify(
    {
      dataset: "openvac-v1",
      cases: OPENVAC_V1_EVAL_CASES.length,
      uniqueIds: uniqueIds.size,
      sourcedCases: sourced,
      retrievalCases,
      metadataReferenceCases,
      safetyPolicyCases,
      highRiskCases: highRisk,
      expertReviewedCases: OPENVAC_V1_EVAL_CASES.filter(
        (item) => item.reviewStatus === "expert_reviewed"
      ).length,
      mode: structureOnly ? "structure-only" : "launch-gate"
    },
    null,
    2
  )
);

if (
  OPENVAC_V1_EVAL_CASES.length < 150 ||
  sourced < 120 ||
  retrievalCases < 102 ||
  metadataReferenceCases !== 18 ||
  safetyPolicyCases !== 30 ||
  uniqueIds.size !== OPENVAC_V1_EVAL_CASES.length ||
  retrievalCases + metadataReferenceCases + safetyPolicyCases !==
    OPENVAC_V1_EVAL_CASES.length
) {
  process.exitCode = 1;
} else if (!structureOnly) {
  console.error(
    "Launch gate not passed: run live Top-5 retrieval against the reviewed production corpus and record expert review before public release."
  );
  process.exitCode = 2;
}
