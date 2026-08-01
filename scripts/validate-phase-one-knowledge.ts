import {
  PHASE_ONE_CANDIDATE_ENTRIES,
  PHASE_ONE_EVAL_CASES,
  PHASE_ONE_SOURCE_MANIFEST
} from "../src/server/knowledge/phase-one-catalog";
import { validatePhaseOneCatalog } from "../src/server/knowledge/catalog-validation";

const report = validatePhaseOneCatalog({
  sources: PHASE_ONE_SOURCE_MANIFEST,
  candidates: PHASE_ONE_CANDIDATE_ENTRIES,
  evalCases: PHASE_ONE_EVAL_CASES
});

console.log(JSON.stringify(report, null, 2));

if (report.issues.length > 0) {
  console.error(
    `Phase-one knowledge content gate failed with ${report.issues.length} issue(s).`
  );
  process.exitCode = 1;
} else {
  console.log(
    "Phase-one knowledge content gate passed. Human review and live Top-5 retrieval remain separate release gates."
  );
}
