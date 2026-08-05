export type PublicOperationsDetails = {
  operatorName?: string;
  operatorAddress?: string;
  publicContactEmail?: string;
  legalComplaintEmail?: string;
  icpFilingNumber?: string;
  genAiFilingNumber?: string;
};

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getPublicOperationsDetails(
  env: Readonly<Record<string, string | undefined>> = process.env
): PublicOperationsDetails {
  return {
    operatorName: optionalValue(env.OPERATOR_NAME),
    operatorAddress: optionalValue(env.OPERATOR_ADDRESS),
    publicContactEmail: optionalValue(env.PUBLIC_CONTACT_EMAIL),
    legalComplaintEmail: optionalValue(env.LEGAL_COMPLAINT_EMAIL),
    icpFilingNumber: optionalValue(env.ICP_FILING_NUMBER),
    genAiFilingNumber: optionalValue(env.GEN_AI_FILING_NUMBER)
  };
}
