import coreVacuumSystems from "../../../knowledge/core/cern-vacuum-systems-2024.json";
import superconducting from "../../../knowledge/candidates/cern-vacuum-superconducting-devices-2014.json";
import hseDsear from "../../../knowledge/candidates/hse-dsear.json";
import hseOxygen from "../../../knowledge/candidates/hse-oxygen-safety.json";
import hseMaintenance from "../../../knowledge/candidates/hse-safe-maintenance.json";
import cnPatent from "../../../knowledge/candidates/patent-cn221568833u.metadata.json";
import usPatent from "../../../knowledge/candidates/patent-us7674096b2.metadata.json";
import sourceManifest from "../../../knowledge/source-manifest.json";

import { OPENVAC_V1_EVAL_CASES } from "@/evals/v1";

import {
  parseKnowledgeCandidate,
  type KnowledgeCandidate
} from "./candidate-schema";

const governedCoreCandidate = {
  sourceCanonicalUrl: coreVacuumSystems.source.canonicalUrl,
  document: {
    ...coreVacuumSystems.document,
    externalKey: `${coreVacuumSystems.document.externalKey}-governed-v2`,
    title: "II.8 — Vacuum systems（正式复核候选版）",
    description:
      "旧预发布种子的正式治理迁移副本；内容和页码必须由真人复核并留下内容哈希后，才能替代旧版本进入检索。"
  },
  citation: coreVacuumSystems.citation,
  review: {
    status: "required" as const,
    requirements: [
      "逐条核对中文表述与 CERN 原文页码",
      "核对压力、抽速、流导、单位和公式适用条件",
      "确认未把教学示例或特定设备参数推广为通用性能",
      "由真空行业专家批准后才允许替代旧种子版本"
    ]
  },
  sections: coreVacuumSystems.chunks
};

export const PHASE_ONE_SOURCE_MANIFEST = sourceManifest;

export const PHASE_ONE_CANDIDATE_ENTRIES: ReadonlyArray<{
  path: string;
  value: KnowledgeCandidate;
}> = [
  {
    path: "knowledge/core/cern-vacuum-systems-2024.json#governed-v2",
    value: parseKnowledgeCandidate(governedCoreCandidate)
  },
  {
    path: "knowledge/candidates/cern-vacuum-superconducting-devices-2014.json",
    value: parseKnowledgeCandidate(superconducting)
  },
  {
    path: "knowledge/candidates/patent-us7674096b2.metadata.json",
    value: parseKnowledgeCandidate(usPatent)
  },
  {
    path: "knowledge/candidates/patent-cn221568833u.metadata.json",
    value: parseKnowledgeCandidate(cnPatent)
  },
  {
    path: "knowledge/candidates/hse-safe-maintenance.json",
    value: parseKnowledgeCandidate(hseMaintenance)
  },
  {
    path: "knowledge/candidates/hse-dsear.json",
    value: parseKnowledgeCandidate(hseDsear)
  },
  {
    path: "knowledge/candidates/hse-oxygen-safety.json",
    value: parseKnowledgeCandidate(hseOxygen)
  }
];

export const PHASE_ONE_EVAL_CASES = OPENVAC_V1_EVAL_CASES;
