import { describe, expect, it } from "vitest";

import * as storeModule from "./store";

type PromptPolicy = (input: {
  currentStatus: string;
  nextStatus: "active" | "archived";
}) => void;

const assertPromptVersionTransitionAllowed = (
  storeModule as unknown as {
    assertPromptVersionTransitionAllowed: PromptPolicy;
  }
).assertPromptVersionTransitionAllowed;

describe("prompt version lifecycle policy", () => {
  it("allows a draft to be activated or archived", () => {
    expect(() =>
      assertPromptVersionTransitionAllowed({
        currentStatus: "draft",
        nextStatus: "active"
      })
    ).not.toThrow();
    expect(() =>
      assertPromptVersionTransitionAllowed({
        currentStatus: "draft",
        nextStatus: "archived"
      })
    ).not.toThrow();
  });

  it("allows an active version to be archived but never reactivated in place", () => {
    expect(() =>
      assertPromptVersionTransitionAllowed({
        currentStatus: "active",
        nextStatus: "archived"
      })
    ).not.toThrow();
    expect(() =>
      assertPromptVersionTransitionAllowed({
        currentStatus: "active",
        nextStatus: "active"
      })
    ).toThrowError(/已激活/);
  });

  it("keeps archived versions immutable", () => {
    expect(() =>
      assertPromptVersionTransitionAllowed({
        currentStatus: "archived",
        nextStatus: "active"
      })
    ).toThrowError(/已归档/);
  });
});
