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
    expectedSection: "Nominal and effective pumping speed",
    expectedTerms: ["连接流导", "改善有限"]
  },
  {
    id: "candidate-03",
    question: "极限压力为什么不等于整套装置实际能达到的压力？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Localized and distributed gas loads",
    expectedTerms: ["气载", "泵的极限压力"]
  },
  {
    id: "candidate-04",
    question: "真空夹层需要抽到多少压力才能隔热，能给统一值吗？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Worked cryogenic example and applicability",
    expectedTerms: ["教学算例", "不能直接搬用"]
  },
  {
    id: "candidate-05",
    question: "排出型泵和捕获型泵在系统角色上有什么区别？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Momentum-transfer and capture pumps",
    expectedTerms: ["动量传递泵", "捕获泵"]
  },
  {
    id: "candidate-06",
    question: "涡轮分子泵的氢气参数为什么不能照搬氮气参数？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Pumping speed and compression ratio",
    expectedTerms: ["轻气体", "不能以氮气"]
  },
  {
    id: "candidate-07",
    question: "涡轮分子泵为什么需要前级泵并防止突然空气倒灌？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Backing and operational protection",
    expectedTerms: ["前级泵", "突然进气"]
  },
  {
    id: "candidate-08",
    question: "低温凝结、低温吸附和低温捕集有什么区别？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Cryocondensation, cryosorption and cryotrapping",
    expectedTerms: ["低温凝结", "低温吸附", "低温捕集"]
  },
  {
    id: "candidate-09",
    question: "低温泵只看抽速够不够，为什么还要考虑容量和再生？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Capacity and regeneration",
    expectedTerms: ["瞬时抽速", "再生"]
  },
  {
    id: "candidate-10",
    question: "分子流流导为什么同时依赖气体种类和通道几何？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Geometry and gas dependence",
    expectedTerms: ["气体", "几何"]
  },
  {
    id: "candidate-11",
    question: "分子流下残余气体传热为什么与压力和表面状态有关？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Gas thermal conduction in molecular regime",
    expectedTerms: ["近似随压力变化", "热适应系数"]
  },
  {
    id: "candidate-12",
    question: "LHC 的 4.5 K 氢低温吸附方案能直接套到工业设备吗？",
    expectedSourceUrl: CERN_SUPERCONDUCTING_URL,
    expectedSection: "Hydrogen cryosorption at 4.5 K",
    expectedTerms: ["LHC 特定", "不能外推"]
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
