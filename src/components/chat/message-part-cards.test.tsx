// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessagePartCards } from "./message-part-cards";

afterEach(cleanup);

describe("MessagePartCards stored attachment history", () => {
  it("renders hydrated attachment filename and server status after reload", () => {
    render(
      <MessagePartCards
        parts={[
          {
            type: "attachment",
            attachmentId: "00000000-0000-4000-8000-000000000051",
            kind: "image",
            filename: "真空计读数.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            status: "ready"
          }
        ]}
        inputParts={[
          {
            type: "attachment",
            attachmentId: "00000000-0000-4000-8000-000000000051"
          }
        ]}
      />
    );

    expect(screen.getByText("真空计读数.png")).toBeVisible();
    expect(screen.getByText("已就绪")).toBeVisible();
    expect(screen.getByRole("button", { name: "预览" })).toBeVisible();
    expect(screen.queryByText("工程附件")).not.toBeInTheDocument();
  });
});
