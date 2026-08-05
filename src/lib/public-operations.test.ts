import { describe, expect, it } from "vitest";

import { getPublicOperationsDetails } from "./public-operations";

describe("public operations details", () => {
  it("hides every optional field when values are empty", () => {
    const details = getPublicOperationsDetails({
      OPERATOR_NAME: " ",
      ICP_FILING_NUMBER: ""
    });

    expect(details).toEqual({
      operatorName: undefined,
      operatorAddress: undefined,
      publicContactEmail: undefined,
      legalComplaintEmail: undefined,
      icpFilingNumber: undefined,
      genAiFilingNumber: undefined
    });
  });

  it("trims configured fields and reports public details as available", () => {
    const details = getPublicOperationsDetails({
      OPERATOR_NAME: " 宁波义星科技有限公司 ",
      PUBLIC_CONTACT_EMAIL: " contact@example.cn ",
      ICP_FILING_NUMBER: " 浙ICP备00000000号 "
    });

    expect(details.operatorName).toBe("宁波义星科技有限公司");
    expect(details.publicContactEmail).toBe("contact@example.cn");
    expect(details.icpFilingNumber).toBe("浙ICP备00000000号");
  });
});
