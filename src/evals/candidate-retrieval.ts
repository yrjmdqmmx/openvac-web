import type { RetrievalCandidate } from "@/server/knowledge/retrieval";

import type {
  CoreRetrievalEvalCase,
  CoreRetrievalEvalResult
} from "./core-retrieval";

const CERN_SUPERCONDUCTING_URL = "https://cds.cern.ch/record/1974068";

export const CANDIDATE_RETRIEVAL_EVAL_CASES: CoreRetrievalEvalCase[] = [
  {
    id: "candidate-01",
    question: "黏性流、过渡流和分子流为什么不能只按一个固定压力划分？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Flow regimes and Knudsen number",
    expectedTerms: ["Knudsen 数", "气体", "几何尺寸"]
  },
  {
    id: "candidate-02",
    question: "为什么加大泵的铭牌抽速不一定能提高腔体端抽速？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Conductance and effective pumping speed",
    expectedTerms: ["流导 C", "收益有限"]
  },
  {
    id: "candidate-03",
    question: "极限压力为什么不等于整套装置实际能达到的压力？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "2.1.3 Outgassing",
    expectedTerms: ["气载", "局部有效抽速"]
  },
  {
    id: "candidate-04",
    question: "真空夹层需要抽到多少压力才能隔热，能给统一值吗？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Heat transfer in residual gas",
    expectedTerms: ["不应", "统一验收标准"]
  },
  {
    id: "candidate-05",
    question: "排出型泵和捕获型泵在系统角色上有什么区别？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Momentum-transfer and capture pumps",
    expectedTerms: ["输送到出口", "捕获类"]
  },
  {
    id: "candidate-06",
    question: "涡轮分子泵为什么需要前级泵，氢气参数能照搬氮气吗？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "3.1 Turbomolecular pumps",
    expectedTerms: ["前级泵", "不能照搬氮气参数"]
  },
  {
    id: "candidate-07",
    question: "低温凝结、低温吸附和低温捕集有什么区别？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Cryocondensation, cryosorption and cryotrapping",
    expectedTerms: ["低温凝结", "低温吸附", "低温捕集"]
  },
  {
    id: "candidate-08",
    question: "低温泵只看抽速够不够，为什么还要考虑容量和再生？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Capacity and regeneration",
    expectedTerms: ["容量", "再生周期"]
  }
];

export async function evaluateCandidateRetrieval(
  retrieve: (query: string) => Promise<RetrievalCandidate[]>,
  cases = CANDIDATE_RETRIEVAL_EVAL_CASES
): Promise<CoreRetrievalEvalResult[]> {
  const results: CoreRetrievalEvalResult[] = [];
  for (const item of cases) {
    const candidates = (await retrieve(item.question)).slice(0, 5);
    const match = candidates.find((candidate) => {
      const section = candidate.sectionPath.join(" > ");
      return (
        candidate.citation?.url === item.expectedSourceUrl &&
        section.includes(item.expectedSection) &&
        item.expectedTerms.every((term) => candidate.content.includes(term))
      );
    });
    results.push({
      id: item.id,
      hit: Boolean(match),
      ...(match ? { matchedChunkId: match.chunkId } : {})
    });
  }
  return results;
}
