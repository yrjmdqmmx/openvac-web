import type { ArtifactSpec } from "@/types/chat-v3";

export function parameterTableIncludesUnitsAndAssumptions(
  spec: ArtifactSpec
): boolean {
  if (spec.kind !== "parameter_table") return false;
  const unitField = /(?:单位|unit)/iu;
  const assumptionField = /(?:假设|工况|条件|assumption|condition)/iu;
  const combinedAssumptionContent =
    /(?:假设|工况|条件|稳态|额定|assum|condition|steady|rated)/iu;
  const hasUnitValue = spec.tables.some((table) =>
    table.columns.some(
      (column, columnIndex) =>
        unitField.test(column) &&
        table.rows.some((row) => hasSubstantiveText(row[columnIndex] ?? ""))
    )
  );
  const hasAssumptionValue =
    spec.sections.some(
      (section) =>
        assumptionField.test(section.heading) &&
        section.paragraphs.some(hasSubstantiveText)
    ) ||
    spec.tables.some((table) =>
      table.columns.some((column, columnIndex) => {
        if (!assumptionField.test(column)) return false;
        return table.rows.some((row) => {
          const value = row[columnIndex] ?? "";
          if (!hasSubstantiveText(value)) return false;
          return (
            !unitField.test(column) || combinedAssumptionContent.test(value)
          );
        });
      })
    ) ||
    spec.tables.some((table) =>
      table.rows.some((row) =>
        row.some(
          (value) =>
            combinedAssumptionContent.test(value) && hasSubstantiveText(value)
        )
      )
    );
  return hasUnitValue && hasAssumptionValue;
}

function hasSubstantiveText(value: string): boolean {
  return (
    Array.from(
      value
        .trim()
        .replace(/(?:单位|假设|工况|条件|unit|assumption|condition)/giu, "")
        .replace(/[\s\p{P}\p{S}]/gu, "")
    ).length >= 2
  );
}
