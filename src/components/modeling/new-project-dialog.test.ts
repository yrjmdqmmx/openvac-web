// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewProjectDialog } from "./new-project-dialog";

afterEach(cleanup);

describe("NewProjectDialog material input", () => {
  it("passes only an explicitly entered density to project creation", () => {
    const onCreate = vi.fn();
    render(
      createElement(NewProjectDialog, {
        open: false,
        onClose: () => undefined,
        onCreate
      })
    );

    fireEvent.change(screen.getByLabelText("材料名称"), {
      target: { value: "用户指定材料" }
    });
    fireEvent.change(screen.getByLabelText("材料密度（kg/m³）"), {
      target: { value: "7850" }
    });
    fireEvent.click(
      screen.getByRole("button", { name: "创建项目", hidden: true })
    );

    expect(onCreate).toHaveBeenCalledWith("通用单级旋片泵", "pump-template", {
      name: "用户指定材料",
      densityKgM3: 7850
    });
  });

  it("keeps material undefined when density is blank", () => {
    const onCreate = vi.fn();
    render(
      createElement(NewProjectDialog, {
        open: false,
        onClose: () => undefined,
        onCreate
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "创建项目", hidden: true })
    );

    expect(onCreate).toHaveBeenCalledWith(
      "通用单级旋片泵",
      "pump-template",
      undefined
    );
  });
});
