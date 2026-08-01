import type { RetrievalCandidate } from "@/server/knowledge/retrieval";

export type CoreRetrievalEvalCase = {
  id: string;
  question: string;
  expectedSourceUrl: string;
  expectedSection: string;
  expectedTerms: string[];
};

const CERN_SOURCE_URL = "https://cds.cern.ch/record/2929324?ln=en";

export const CORE_RETRIEVAL_EVAL_CASES: CoreRetrievalEvalCase[] = [
  {
    id: "core-01",
    question: "真空是不是完全没有物质？工程上应该怎么描述真空？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.1 Introduction",
    expectedTerms: ["气体分子密度"]
  },
  {
    id: "core-02",
    question: "只说真空度高低为什么不够，还要记录哪些可测量量？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.1 Introduction",
    expectedTerms: ["压力", "气体组成"]
  },
  {
    id: "core-03",
    question: "1 mbar 等于多少 Pa，1 Torr 大约等于多少 Pa？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.2.1 Gas kinetic theory",
    expectedTerms: ["1 mbar = 100 Pa", "1 Torr"]
  },
  {
    id: "core-04",
    question: "混合气体的总压和各组分分压是什么关系？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.2.1 Gas kinetic theory",
    expectedTerms: ["分压之和"]
  },
  {
    id: "core-05",
    question: "平均自由程随压力下降如何变化？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.2.2 Gas flow",
    expectedTerms: ["平均自由程随压力降低而增大"]
  },
  {
    id: "core-06",
    question: "从大气抽到高真空时会经历哪些气体流态？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.2.2 Gas flow",
    expectedTerms: ["黏滞层流", "分子流"]
  },
  {
    id: "core-07",
    question: "分子流下长直圆管的直径和长度怎样影响流导？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Conductance",
    expectedTerms: ["直径的三次方"]
  },
  {
    id: "core-08",
    question: "为什么真空管路通常要尽量短而粗？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Conductance",
    expectedTerms: ["管路宜尽量短而粗"]
  },
  {
    id: "core-09",
    question: "抽速 S、压力 P 和气体通量 Q 的关系式是什么？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pumping speed and throughput",
    expectedTerms: ["Q = P×S"]
  },
  {
    id: "core-10",
    question: "稳态下气载、有效抽速和系统压力是什么关系？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pumping speed and throughput",
    expectedTerms: ["气载与有效抽速之比"]
  },
  {
    id: "core-11",
    question: "泵的铭牌抽速很大，为什么腔体端有效抽速仍然很小？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Effective pumping speed",
    expectedTerms: ["流导受限"]
  },
  {
    id: "core-12",
    question: "流导远小于泵口抽速时，应该换更大的泵还是先改管路？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Effective pumping speed",
    expectedTerms: ["缩短管路"]
  },
  {
    id: "core-13",
    question: "真空泵移除气体和捕集气体这两类原理有什么区别？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.3.3 Vacuum pumps",
    expectedTerms: ["捕集气体分子"]
  },
  {
    id: "core-14",
    question: "为什么一套真空系统经常需要不同类型的泵组合？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.3.3 Vacuum pumps",
    expectedTerms: ["全部压力范围"]
  },
  {
    id: "core-15",
    question: "涡轮分子泵为什么需要前级泵？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pump examples",
    expectedTerms: ["前级泵处理出口气体"]
  },
  {
    id: "core-16",
    question: "旋片泵、涡轮分子泵和离子泵分别适合承担什么作用？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pump examples",
    expectedTerms: ["粗抽", "维持真空"]
  },
  {
    id: "core-17",
    question: "系统没有真实泄漏，为什么压力仍然可能降不下去？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.4 Outgassing",
    expectedTerms: ["放气"]
  },
  {
    id: "core-18",
    question: "排查抽不到目标压力时，除了泵太小还要检查什么？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "II.8.4 Outgassing",
    expectedTerms: ["漏率", "污染"]
  },
  {
    id: "core-19",
    question: "做真空泵选型前至少需要收集哪些工况参数？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pump selection inputs",
    expectedTerms: ["腔体容积", "目标压力"]
  },
  {
    id: "core-20",
    question: "只有目标压力，没有气载和管路条件，能直接确定泵型号吗？",
    expectedSourceUrl: CERN_SOURCE_URL,
    expectedSection: "Pump selection inputs",
    expectedTerms: ["不能可靠确定泵型与规格"]
  }
];

export type CoreRetrievalEvalResult = {
  id: string;
  hit: boolean;
  matchedChunkId?: string;
};

export async function evaluateCoreRetrieval(
  retrieve: (query: string) => Promise<RetrievalCandidate[]>,
  cases = CORE_RETRIEVAL_EVAL_CASES
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
