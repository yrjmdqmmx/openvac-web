import { OPENVAC_V1_EVAL_CASES } from "../src/evals/v1";

const structureOnly = process.argv.includes("--structure-only");
const uniqueIds = new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.id));
const sourced = OPENVAC_V1_EVAL_CASES.filter(
  (item) => item.expectedSourceIds.length > 0
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
  OPENVAC_V1_EVAL_CASES.length < 120 ||
  uniqueIds.size !== OPENVAC_V1_EVAL_CASES.length ||
  sourced !== OPENVAC_V1_EVAL_CASES.length
) {
  process.exitCode = 1;
} else if (!structureOnly) {
  console.error(
    "Launch gate not passed: run live Top-5 retrieval against the reviewed production corpus and record expert review before public release."
  );
  process.exitCode = 2;
}
