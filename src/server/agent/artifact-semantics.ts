import type { ArtifactSpec } from "@/types/chat-v3";

export type ParameterTableSemantics = {
  hasUnitValue: boolean;
  hasAssumptionValue: boolean;
};

type ParameterTableSemanticInput = Pick<
  ArtifactSpec,
  "kind" | "sections" | "tables"
> &
  Partial<ArtifactSpec>;

export function inspectParameterTableSemantics(
  spec: ParameterTableSemanticInput
): ParameterTableSemantics {
  if (spec.kind !== "parameter_table") {
    return { hasUnitValue: false, hasAssumptionValue: false };
  }
  const unitField = /(?:单位|unit)/iu;
  const hasUnitValue = spec.tables.some((table) =>
    table.columns.some(
      (column, columnIndex) =>
        unitField.test(column) &&
        table.rows.some((row) => hasPhysicalUnitValue(row[columnIndex] ?? ""))
    )
  );
  const hasAssumptionValue =
    spec.sections.some(
      (section) =>
        assumptionScopedField.test(section.heading) &&
        section.paragraphs.some(hasAssumptionValueText)
    ) ||
    spec.tables.some((table) =>
      table.columns.some((column, columnIndex) => {
        if (!assumptionScopedField.test(column)) return false;
        return table.rows.some((row) => {
          const value = row[columnIndex] ?? "";
          return hasAssumptionValueText(value);
        });
      })
    ) ||
    spec.tables.some((table) =>
      table.rows.some((row) => row.some(hasDelimitedAssumptionContent))
    ) ||
    spec.tables.some((table) =>
      table.rows.some((row) => hasExplicitAssumptionNote(row))
    );
  return { hasUnitValue, hasAssumptionValue };
}

export function parameterTableIncludesUnitsAndAssumptions(
  spec: ParameterTableSemanticInput
): boolean {
  const { hasUnitValue, hasAssumptionValue } =
    inspectParameterTableSemantics(spec);
  return hasUnitValue && hasAssumptionValue;
}

const explicitAssumptionNoteLabel =
  /^(?:(?:假设|工况|条件)(?:[\/、](?:假设|工况|条件))*(?:说明|备注|注)?|(?:assumption|operating\s+condition|condition)(?:\s+(?:note|notes|remark|remarks))?)\s*(?:[:：]\s*(?<inline>.+))?$/iu;
const delimitedAssumptionContent =
  /^(?:假设|工况|条件|assumption|operating\s+condition|condition)\s*(?:[:：-]\s*)?(?<inline>.+)$/iu;
const assumptionScopedField =
  /^(?:(?:单位\s*[\/、]\s*)?(?:\p{Script=Han}{0,6})?(?:假设|工况|条件)(?:[\/、](?:假设|工况|条件))*(?:说明|备注|注|值|范围|状态)?|(?:unit\s*\/\s*)?(?:(?:operating|design|boundary|applicable)\s+)?(?:assumptions?|conditions?)(?:\s+(?:notes?|remarks?|scope|range|status))?)$/iu;
const emptyPlaceholder = /^(?:n\/?a|none|[-—/]+)$/iu;
const assumptionMissingStatus =
  /^(?:待(?:用户)?确认|未提供|未知|待定|不详|tbd|not provided|unknown)$/iu;
const placeholderPhrase =
  /(?:待(?:用户)?确认|未提供|未知|待定|不详|\btbd\b|\bunknown\b|\bpending\b|\bn\/?a\b|\bnot\s+(?:provided|available|confirmed)\b|\bto\s+(?:be\s+)?confirm(?:ed)?\b)/iu;
const chineseUnitValue =
  /^(?:帕|千帕|兆帕|巴|毫巴|托|升|毫升|秒|分钟|小时|米|毫米|厘米|微米|纳米|千克|克|瓦|千瓦|伏|安|毫安|赫兹|转\/分|分贝|摄氏度|华氏度|开尔文|无量纲|(?:升|立方米)\/(?:秒|小时)|(?:帕|毫巴|托)[·*](?:升|立方米)\/秒)$/u;
const unitAtom = String.raw`(?:[yzafpnumcdhkMGTPEZYµμ]?(?:m|g|s|a|k|mol|cd|hz|n|pa|j|w|c|v|f|ω|ohm|siemens|wb|t|h|lm|lx|bq|gy|sv|kat|l)|min|(?:m|k|µ|μ)?bar|(?:m|µ|μ)?torr|psi|atm|rpm|cfm|sccm|mmhg|cmh2o|microns?|db(?:a)?|molecules?|dimensionless|%|℃|℉|°[cfk])`;
const unitExpression = new RegExp(
  String.raw`^${unitAtom}(?:[²³⁰¹⁴⁵⁶⁷⁸⁹⁻0-9^+\-]*)(?:[·*/]${unitAtom}(?:[²³⁰¹⁴⁵⁶⁷⁸⁹⁻0-9^+\-]*))*$`,
  "iu"
);

function hasPhysicalUnitValue(value: string): boolean {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    emptyPlaceholder.test(normalized) ||
    assumptionMissingStatus.test(normalized) ||
    placeholderPhrase.test(normalized)
  )
    return false;
  const unitSegment = normalized.split(/[;；]/u, 1)[0]?.trim() ?? "";
  if (
    unitSegment.length === 0 ||
    emptyPlaceholder.test(unitSegment) ||
    assumptionMissingStatus.test(unitSegment) ||
    placeholderPhrase.test(unitSegment)
  ) {
    return false;
  }
  const compact = unitSegment.replace(/\s+/gu, "").replace(/[()]/gu, "");
  if (chineseUnitValue.test(compact)) return true;
  return compact.length <= 48 && unitExpression.test(compact);
}

function hasAssumptionValueText(value: string): boolean {
  const normalized = value.trim();
  if (emptyPlaceholder.test(normalized)) return false;
  if (/^[-+]?\d/u.test(normalized)) {
    return hasNumericPhysicalCondition(normalized);
  }
  if (assumptionMissingStatus.test(normalized)) return true;
  if (placeholderPhrase.test(normalized)) return true;
  const delimitedParts = normalized.split(/[;；]/u);
  if (
    delimitedParts.length > 1 &&
    delimitedParts.slice(1).some(hasAssumptionValueText)
  ) {
    return true;
  }
  if (hasPhysicalUnitValue(normalized)) return false;
  const semanticRemainder = normalized
    .replace(/(?:单位|假设|工况|条件|unit|assumption|condition)/giu, "")
    .replace(/[\d\s\p{P}\p{S}]/gu, "");
  return Array.from(semanticRemainder).length >= 2;
}

function hasNumericPhysicalCondition(value: string): boolean {
  const match = value.match(
    /^[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?\s*(?<unit>[^\d\s].*?)\s*$/u
  );
  const unit = match?.groups?.unit;
  return Boolean(unit && hasPhysicalUnitValue(unit));
}

function hasExplicitAssumptionNote(row: readonly string[]): boolean {
  return row.some((value, index) => {
    const match = explicitAssumptionNoteLabel.exec(value.trim());
    if (!match) return false;
    const inline = match.groups?.inline;
    if (inline && hasAssumptionValueText(inline)) return true;
    return row.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && hasAssumptionValueText(candidate)
    );
  });
}

function hasDelimitedAssumptionContent(value: string): boolean {
  return value
    .split(/[;；]/u)
    .slice(1)
    .some((part) => {
      const match = delimitedAssumptionContent.exec(part.trim());
      const inline = match?.groups?.inline;
      return Boolean(inline && hasAssumptionValueText(inline));
    });
}
