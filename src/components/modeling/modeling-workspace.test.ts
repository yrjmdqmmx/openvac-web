// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyOperationBatch } from "@/lib/modeling/operations";
import {
  createBlankPartDocument,
  createOperationBatchFromManualState
} from "@/lib/modeling/client/protocol-adapter";
import type { ManualOperation } from "@/lib/modeling/client/workspace-state";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";
import type { ModelDocument, ModelOperationBatch } from "@/types/modeling";
import { ModelingWorkspace } from "./modeling-workspace";

vi.mock("./viewport-stage", () => ({
  ViewportStage: ({
    selectedPartId,
    kernelPreview,
    hiddenSemanticIds,
    isolatedSemanticId
  }: {
    selectedPartId: string;
    kernelPreview: { url?: string; message?: string };
    hiddenSemanticIds: string[];
    isolatedSemanticId?: string;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "viewport",
        "data-preview-url": kernelPreview.url,
        "data-preview-message": kernelPreview.message,
        "data-hidden": hiddenSemanticIds.join(","),
        "data-isolated": isolatedSemanticId
      },
      selectedPartId
    )
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const template = createRotaryVanePumpTemplate({
  documentId: "11111111-1111-4111-8111-111111111111",
  revisionId: "22222222-2222-4222-8222-222222222222",
  name: "原创单级旋片泵",
  parameters: { eccentricity: 8 }
});

function projectListResponse(document = template) {
  return jsonResponse({
    data: {
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "原创单级旋片泵",
          currentRevision: {
            id: document.revisionId,
            document
          }
        }
      ]
    }
  });
}

function renderWorkspace(
  initialTemplate: ModelDocument = template,
  initialProjectId?: string
) {
  return render(
    createElement(ModelingWorkspace, {
      userId: "user-1",
      userName: "测试工程师",
      initialProjectId,
      initialTemplate
    })
  );
}

describe("modeling workspace manual and AI flows", () => {
  it("opens an owned project from a deep link even when it is not on the first page", async () => {
    const targetProjectId = "44444444-4444-4444-8444-444444444444";
    const targetDocument = {
      ...template,
      revisionId: "55555555-5555-4555-8555-555555555555",
      name: "深链目标项目"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modeling/projects") return projectListResponse();
      if (url === `/api/modeling/projects/${targetProjectId}`) {
        return jsonResponse({
          data: {
            id: targetProjectId,
            name: "深链目标项目",
            currentRevision: {
              id: targetDocument.revisionId,
              document: targetDocument
            }
          }
        });
      }
      if (url.includes("/revisions?"))
        return revisionListResponse(targetDocument);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(template, targetProjectId);

    expect((await screen.findAllByText("深链目标项目")).length).toBeGreaterThan(
      0
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/modeling/projects/${targetProjectId}`,
      { cache: "no-store" }
    );
  });

  it("edits a pump parameter and keeps it as an unsaved manual operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(projectListResponse()));
    renderWorkspace();

    await screen.findByText("已保存到项目");
    const input = screen.getByLabelText("偏心量（mm）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });

    expect(input).toHaveValue(10);
    expect(screen.getByText("有未保存更改")).toBeInTheDocument();
    expect(screen.getByText("参数更新 · 偏心量")).toBeInTheDocument();
  });

  it("undoes the latest parameter edit without losing the redo path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(projectListResponse()));
    renderWorkspace();

    await screen.findByText("已保存到项目");
    const input = screen.getByLabelText("偏心量（mm）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    expect(input).toHaveValue(8);
    expect(screen.getByRole("button", { name: "重做" })).toBeEnabled();
  });

  it("shows an AI pending state and does not execute the prompt directly", async () => {
    const pending = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modeling/projects") {
        return Promise.resolve(projectListResponse());
      }
      if (url.includes("/revisions?")) {
        return Promise.resolve(revisionListResponse());
      }
      return pending;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("描述希望 AI 规划的建模修改"), {
      target: { value: "将偏心量改为 9 mm" }
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 AI 建模计划" }));

    expect(await screen.findByText("AI 计划生成中")).toBeInTheDocument();
    expect(screen.getByText(/不会自动执行/)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/ai-plans"),
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/confirm"))
    ).toBe(false);
    const planRequest = (
      fetchMock.mock.calls as unknown as Array<
        [RequestInfo | URL, RequestInit?]
      >
    ).find(([url]) => String(url).includes("/ai-plans"));
    expect(JSON.parse(String(planRequest?.[1]?.body))).toMatchObject({
      selectedSemanticRefs: ["pump.feature.vane-pattern"]
    });
  });

  it("keeps generic tools disabled on the dedicated rotary-vane template", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(projectListResponse()));
    renderWorkspace();

    await screen.findByText("已保存到项目");
    expect(
      screen.getByRole("button", { name: "拉伸（未开放）" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "布尔（未开放）" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "装配（未开放）" })
    ).toBeDisabled();
    expect(screen.getByLabelText("旋片数量（V1 固定双滑片）")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "抑制旋片 1" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "导出模型" })).toBeEnabled();
  });

  it("cancels an older authoritative preview before starting a newer one", async () => {
    let previewCount = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse();
        if (url.includes("/revisions?")) return revisionListResponse();
        if (url.endsWith("/cancel") && init?.method === "POST") {
          const jobId = url.split("/").at(-2)!;
          return jsonResponse({
            data: {
              job: { id: jobId, status: "running" },
              cancellationRequested: true
            }
          });
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          previewCount += 1;
          return jsonResponse({
            data: {
              job: { id: `preview-job-${previewCount}`, status: "queued" }
            }
          });
        }
        if (url.includes("/api/modeling/jobs/")) {
          return jsonResponse({
            data: { id: "preview-job-1", status: "queued" }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    const interference = screen.getByRole("button", { name: "干涉检查" });
    fireEvent.click(interference);
    await waitFor(() => expect(previewCount).toBe(1));

    fireEvent.click(interference);

    await waitFor(() => expect(previewCount).toBe(2));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/modeling/jobs/preview-job-1/cancel" &&
          init?.method === "POST"
      )
    ).toBe(true);
  });

  it("edits, undoes, and redoes an editable generic model parameter", async () => {
    const blank = createBlankPartDocument("通用参数测试");
    const document: ModelDocument = {
      ...blank,
      parameters: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          semanticRef: "manual.parameter.width",
          name: "Width",
          label: "宽度",
          parameterType: "length",
          unit: "mm",
          value: 20,
          minimum: 1,
          maximum: 100,
          source: "user",
          editable: true
        }
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(projectListResponse(document))
    );
    renderWorkspace(document);

    await screen.findByText("已保存到项目");
    const input = screen.getByLabelText("宽度（mm）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "24" } });

    expect(input).toHaveValue(24);
    expect(screen.getByText("有未保存更改")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(input).toHaveValue(20);
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(input).toHaveValue(24);
  });

  it("hides and isolates generic semantic objects as local viewport state", async () => {
    const document = twoBodyGeneralDocument();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(projectListResponse(document))
    );
    renderWorkspace(document);

    await screen.findByText("已保存到项目");
    const feature = document.features[0]!;
    const semanticId = `feature:${feature.semanticRef}`;
    fireEvent.click(
      screen.getByRole("button", { name: `隐藏${feature.name}` })
    );
    expect(screen.getByTestId("viewport")).toHaveAttribute(
      "data-hidden",
      semanticId
    );

    fireEvent.click(
      screen.getByRole("button", { name: `隔离${feature.name}` })
    );
    expect(screen.getByTestId("viewport")).toHaveAttribute("data-hidden", "");
    expect(screen.getByTestId("viewport")).toHaveAttribute(
      "data-isolated",
      semanticId
    );
  });

  it("stages a real sketch and extrude batch for a blank general part", async () => {
    const blank = createBlankPartDocument("空白测试零件");
    let submittedBatch: ModelOperationBatch | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") {
          return projectListResponse(blank);
        }
        if (url.includes("/operation-batches")) {
          submittedBatch = JSON.parse(
            String(init?.body)
          ) as ModelOperationBatch;
          const next = applyOperationBatch(blank, submittedBatch);
          return jsonResponse({
            data: { revision: { id: next.revisionId, document: next } }
          });
        }
        if (url.includes("/jobs")) {
          return jsonResponse({
            data: {
              job: {
                id: "job-preview",
                status: "succeeded",
                output: { artifactIds: ["artifact-preview"] }
              }
            }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(blank);

    await screen.findByText("已保存到项目");
    fireEvent.click(screen.getByRole("button", { name: "草图" }));
    fireEvent.click(screen.getByRole("button", { name: "加入待保存批次" }));
    fireEvent.click(screen.getByRole("button", { name: "拉伸" }));
    expect(screen.getByText("待保存的基础草图")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入待保存批次" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    await waitFor(() => expect(submittedBatch).toBeDefined());
    expect(
      submittedBatch?.operations.some(
        (operation) =>
          operation.kind === "add" && operation.collection === "sketches"
      )
    ).toBe(true);
    expect(
      submittedBatch?.operations.some(
        (operation) =>
          operation.kind === "add" &&
          operation.collection === "features" &&
          "featureKind" in operation.item &&
          operation.item.featureKind === "extrude"
      )
    ).toBe(true);
  });

  it("selects a same-sketch entity and stages a fixed sketch constraint", async () => {
    const blank = createBlankPartDocument("草图约束 UI 测试");
    const base = applyOperationBatch(
      blank,
      createOperationBatchFromManualState(
        blank,
        [
          toolCommand("workspace-line-base", "sketch", {
            action: "primitive",
            plane: "xy",
            shape: "line",
            startX: 0,
            startY: 0,
            endX: 20,
            endY: 0,
            construction: false
          })
        ],
        "workspace-line-base-1"
      )!
    );
    let submittedBatch: ModelOperationBatch | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse(base);
        if (url.includes("/operation-batches")) {
          submittedBatch = JSON.parse(
            String(init?.body)
          ) as ModelOperationBatch;
          const next = applyOperationBatch(base, submittedBatch);
          return jsonResponse({
            data: { revision: { id: next.revisionId, document: next } }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    renderWorkspace(base);

    await screen.findByText("已保存到项目");
    fireEvent.click(screen.getByRole("button", { name: "草图" }));
    expect(screen.getByRole("option", { name: "点" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "折线" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "圆弧" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("草图操作"), {
      target: { value: "constraint" }
    });
    expect(
      screen.getByRole("option", { name: "等长（两直线）" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "等半径（圆/圆弧）" })
    ).toBeInTheDocument();
    const line = base.sketches[0]!.entities.find(
      (entity) => entity.entityKind === "line"
    )!;
    fireEvent.change(screen.getByLabelText("固定对象"), {
      target: { value: line.semanticRef }
    });
    fireEvent.click(screen.getByRole("button", { name: "加入待保存批次" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    await waitFor(() => expect(submittedBatch).toBeDefined());
    const sketchUpdate = submittedBatch?.operations.find(
      (operation) =>
        operation.kind === "update" && operation.collection === "sketches"
    );
    expect(sketchUpdate).toMatchObject({
      changes: {
        constraints: [
          expect.objectContaining({
            constraintKind: "fixed",
            targetRefs: [{ id: line.id, semanticRef: line.semanticRef }]
          })
        ]
      }
    });
  });

  it("shows the AI dry-run artifact in the viewport before confirmation", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse();
        if (url.includes("/projects/") && url.endsWith("/ai-plans")) {
          return jsonResponse({
            data: { status: "pending", job: { id: "job-ai" } }
          });
        }
        if (url.endsWith("/jobs/job-ai")) {
          return jsonResponse({
            data: {
              id: "job-ai",
              status: "succeeded",
              planId: "plan-ai",
              output: { artifactIds: ["artifact-ai-preview"] }
            }
          });
        }
        if (url.endsWith("/ai-plans/plan-ai")) {
          return jsonResponse({
            data: {
              id: "plan-ai",
              status: "validated",
              planHash: "plan-hash",
              draft: {
                status: "validated",
                operationBatch: { operations: [] }
              }
            }
          });
        }
        throw new Error(`Unexpected request ${url} ${init?.method ?? "GET"}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("描述希望 AI 规划的建模修改"), {
      target: { value: "预览选中旋片的修改" }
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 AI 建模计划" }));

    await waitFor(
      () =>
        expect(screen.getByTestId("viewport")).toHaveAttribute(
          "data-preview-url",
          expect.stringContaining("artifact-ai-preview")
        ),
      { timeout: 4_000 }
    );
    expect(screen.getByTestId("viewport")).toHaveAttribute(
      "data-preview-message",
      "AI 计划 dry-run · 尚未确认"
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/confirm"))
    ).toBe(false);
  });

  it("renders exact AI parameter and feature diffs and rejects without changing the revision", async () => {
    const eccentricity = template.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const feature = template.features[0]!;
    let finishReject!: (response: Response) => void;
    const rejectResponse = new Promise<Response>((resolve) => {
      finishReject = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse();
        if (url.includes("/revisions?")) return revisionListResponse();
        if (url.includes("/projects/") && url.endsWith("/ai-plans")) {
          return jsonResponse({
            data: {
              id: "66666666-6666-4666-8666-666666666666",
              status: "validated",
              planHash: "plan-hash",
              draft: {
                status: "validated",
                summary: "修改偏心量和入口特征。",
                assumptions: [],
                warnings: [],
                expectedChecks: ["闭合实体"],
                operationBatch: {
                  operations: [
                    {
                      operationId: "77777777-7777-4777-8777-777777777777",
                      kind: "update",
                      collection: "parameters",
                      target: {
                        id: eccentricity.id,
                        semanticRef: eccentricity.semanticRef
                      },
                      changes: { value: 9 }
                    },
                    {
                      operationId: "88888888-8888-4888-8888-888888888888",
                      kind: "update",
                      collection: "features",
                      target: {
                        id: feature.id,
                        semanticRef: feature.semanticRef
                      },
                      changes: { name: "更新后的入口特征" }
                    }
                  ]
                }
              },
              output: { artifactIds: ["artifact-reject-preview"] }
            }
          });
        }
        if (
          url.endsWith("/ai-plans/66666666-6666-4666-8666-666666666666/reject")
        ) {
          return rejectResponse;
        }
        throw new Error(`Unexpected request ${url} ${init?.method ?? "GET"}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("描述希望 AI 规划的建模修改"), {
      target: { value: "把偏心量改成 9 mm，并更新入口特征" }
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 AI 建模计划" }));

    const parameterHeading = await screen.findByText(
      `修改参数 · ${eccentricity.label}`
    );
    const parameterOperation = parameterHeading.closest("li")!;
    expect(within(parameterOperation).getByText("8 mm")).toBeInTheDocument();
    expect(within(parameterOperation).getByText("9 mm")).toBeInTheDocument();
    const featureHeading = screen.getByText(`修改特征 · ${feature.name}`);
    const featureOperation = featureHeading.closest("li")!;
    expect(
      within(featureOperation).getByText("更新后的入口特征")
    ).toBeInTheDocument();
    expect(screen.getByTestId("viewport")).toHaveAttribute(
      "data-preview-url",
      expect.stringContaining("artifact-reject-preview")
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝计划" }));

    expect(screen.getByRole("button", { name: "正在拒绝…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认并执行" })).toBeDisabled();
    expect(screen.getByLabelText("描述希望 AI 规划的建模修改")).toBeDisabled();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/modeling/ai-plans/66666666-6666-4666-8666-666666666666/reject",
        expect.objectContaining({ method: "POST" })
      )
    );
    const rejectCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/reject")
    );
    expect(JSON.parse(String(rejectCall?.[1]?.body))).toMatchObject({
      idempotencyKey: expect.stringContaining("reject-")
    });

    await act(async () => {
      finishReject(
        jsonResponse({
          data: {
            plan: {
              id: "66666666-6666-4666-8666-666666666666",
              status: "rejected"
            }
          }
        })
      );
    });

    expect(
      await screen.findAllByText("AI 计划已拒绝，当前修订未发生变化。")
    ).not.toHaveLength(0);
    expect(screen.getByLabelText("偏心量（mm）")).toHaveValue(8);
    expect(screen.getByTestId("viewport")).not.toHaveAttribute(
      "data-preview-url"
    );
  });

  it("keeps an AI plan available for retry when rejection fails", async () => {
    const eccentricity = template.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse();
        if (url.includes("/revisions?")) return revisionListResponse();
        if (url.includes("/projects/") && url.endsWith("/ai-plans")) {
          return jsonResponse({
            data: {
              id: "99999999-9999-4999-8999-999999999999",
              status: "validated",
              planHash: "plan-hash",
              draft: {
                status: "validated",
                operationBatch: {
                  operations: [
                    {
                      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                      kind: "update",
                      collection: "parameters",
                      target: {
                        id: eccentricity.id,
                        semanticRef: eccentricity.semanticRef
                      },
                      changes: { value: 9 }
                    }
                  ]
                }
              }
            }
          });
        }
        if (url.endsWith("/reject") && init?.method === "POST") {
          return jsonResponse(
            { error: { code: "OSS_UNAVAILABLE", message: "暂时无法拒绝计划" } },
            503
          );
        }
        throw new Error(`Unexpected request ${url} ${init?.method ?? "GET"}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("描述希望 AI 规划的建模修改"), {
      target: { value: "把偏心量改成 9 mm" }
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 AI 建模计划" }));
    fireEvent.click(await screen.findByRole("button", { name: "拒绝计划" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "拒绝失败：暂时无法拒绝计划。计划仍保留，可重试。"
    );
    expect(
      screen.getByText(`修改参数 · ${eccentricity.label}`)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝计划" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认并执行" })).toBeEnabled();
  });

  it("uses semantic multi-selection to submit a subtract boolean batch", async () => {
    const base = twoBodyGeneralDocument();
    let submittedBatch: ModelOperationBatch | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse(base);
        if (url.includes("/operation-batches")) {
          submittedBatch = JSON.parse(
            String(init?.body)
          ) as ModelOperationBatch;
          const next = applyOperationBatch(base, submittedBatch);
          return jsonResponse({
            data: { revision: { id: next.revisionId, document: next } }
          });
        }
        if (url.includes("/jobs")) {
          return jsonResponse({
            data: {
              job: {
                id: "job-boolean-preview",
                status: "succeeded",
                output: { artifactIds: ["artifact-boolean-preview"] }
              }
            }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(base);

    await screen.findByText("已保存到项目");
    const secondFeature = base.features[1]!;
    fireEvent.click(
      screen.getByRole("button", {
        name: `加入多选：${secondFeature.name}`
      })
    );
    expect(screen.getByText("已多选 2 个语义对象")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "布尔" }));
    fireEvent.change(screen.getByLabelText("布尔方式"), {
      target: { value: "subtract" }
    });
    fireEvent.click(screen.getByRole("button", { name: "加入待保存批次" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    await waitFor(() => expect(submittedBatch).toBeDefined());
    expect(
      submittedBatch?.operations.find(
        (operation) =>
          operation.kind === "add" &&
          operation.collection === "features" &&
          "featureKind" in operation.item &&
          operation.item.featureKind === "boolean"
      )
    ).toMatchObject({ item: { operation: "subtract" } });
  });

  it("stages a fixed assembly constraint for a selected component", async () => {
    const base = twoBodyGeneralDocument();
    let submittedBatch: ModelOperationBatch | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse(base);
        if (url.includes("/operation-batches")) {
          submittedBatch = JSON.parse(
            String(init?.body)
          ) as ModelOperationBatch;
          const next = applyOperationBatch(base, submittedBatch);
          return jsonResponse({
            data: { revision: { id: next.revisionId, document: next } }
          });
        }
        if (url.includes("/jobs")) {
          return jsonResponse({
            data: {
              job: {
                id: "job-assembly-preview",
                status: "succeeded",
                output: { artifactIds: ["artifact-assembly-preview"] }
              }
            }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(base);

    await screen.findByText("已保存到项目");
    const sourceComponent = base.components[0]!;
    fireEvent.click(
      screen.getByRole("button", {
        name: `选择组件：${sourceComponent.name}`
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "装配" }));
    fireEvent.change(screen.getByLabelText("装配操作"), {
      target: { value: "constraint" }
    });
    fireEvent.click(screen.getByRole("button", { name: "加入待保存批次" }));
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    await waitFor(() => expect(submittedBatch).toBeDefined());
    expect(submittedBatch?.operations).toContainEqual(
      expect.objectContaining({
        kind: "add",
        collection: "assemblyConstraints",
        item: expect.objectContaining({ constraintKind: "fixed" })
      })
    );
  });

  it("surfaces a server validation error and names the preserved base revision", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modeling/projects") {
        return Promise.resolve(projectListResponse());
      }
      if (url.includes("/revisions?")) {
        return Promise.resolve(revisionListResponse());
      }
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              code: "CAD_VALIDATION_FAILED",
              message: "CAD 内核拒绝了本次操作，上一版本保持不变。"
            }
          },
          422
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("偏心量（mm）"), {
      target: { value: "9" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    expect(await screen.findByText("保存失败 · 旧版保留")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "服务器仍保留基础修订 22222222"
    );
    expect(screen.getByRole("button", { name: "保存项目" })).toBeEnabled();
  });

  it("reports an explicit offline draft when an operation batch cannot persist", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modeling/projects") {
        return Promise.resolve(projectListResponse());
      }
      if (url.includes("/revisions?")) {
        return Promise.resolve(revisionListResponse());
      }
      return Promise.reject(new TypeError("network down"));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    await screen.findByText("已保存到项目");
    fireEvent.change(screen.getByLabelText("偏心量（mm）"), {
      target: { value: "9" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));

    expect(await screen.findByText("离线草稿 · 未持久化")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("离线草稿");
  });

  it("opens an immutable historical revision read-only and returns to the server current revision", async () => {
    const historicalRevisionId = "90000000-0000-4000-8000-000000000001";
    const historicalDocument = createRotaryVanePumpTemplate({
      documentId: template.id,
      revisionId: historicalRevisionId,
      name: "历史旋片泵版本",
      parameters: { eccentricity: 6 }
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") return projectListResponse();
        if (url.includes("/revisions?")) {
          return jsonResponse({
            data: {
              items: [
                {
                  id: template.revisionId,
                  revisionNumber: 2,
                  source: "manual",
                  document: template,
                  createdAt: "2026-08-01T01:00:00.000Z"
                },
                {
                  id: historicalRevisionId,
                  revisionNumber: 1,
                  source: "initial",
                  document: historicalDocument,
                  createdAt: "2026-08-01T00:00:00.000Z"
                }
              ],
              page: 1,
              pageSize: 50,
              total: 2
            }
          });
        }
        if (
          url === "/api/modeling/projects/33333333-3333-4333-8333-333333333333"
        ) {
          return jsonResponse({
            data: {
              id: "33333333-3333-4333-8333-333333333333",
              name: "原创单级旋片泵",
              currentRevision: {
                id: template.revisionId,
                document: template
              }
            }
          });
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          return jsonResponse({
            data: {
              job: {
                id: `preview-${fetchMock.mock.calls.length}`,
                status: "succeeded",
                output: { artifactIds: ["artifact-preview"] }
              }
            }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace();

    const historicalVersion = await screen.findByText("V1");
    fireEvent.click(historicalVersion.closest("button")!);

    expect(await screen.findByText(/正在只读查看 V1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存项目" })).toBeDisabled();
    expect(screen.getByLabelText("偏心量（mm）")).toHaveValue(6);

    fireEvent.click(
      screen.getAllByRole("button", { name: "返回当前版本" })[0]!
    );

    await waitFor(() =>
      expect(screen.queryByText(/正在只读查看 V1/)).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "保存项目" })).toBeDisabled();
    expect(screen.getByLabelText("偏心量（mm）")).toHaveValue(8);
  });

  it("uploads a STEP privately, waits for the import job, and hydrates its new revision", async () => {
    const blank = createBlankPartDocument("STEP 导入测试");
    const importedRevisionId = "90000000-0000-4000-8000-000000000002";
    const importedDocument: ModelDocument = {
      ...blank,
      revision: 1,
      revisionId: importedRevisionId,
      name: "housing",
      features: [
        {
          id: "90000000-0000-4000-8000-000000000003",
          semanticRef: "feature.imported-step.test",
          name: "Imported STEP: housing.step",
          featureKind: "imported_step",
          artifactId: "90000000-0000-4000-8000-000000000004",
          artifactSha256: "0".repeat(64),
          sourceName: "housing.step",
          bodySemanticRefs: ["body.imported-step.test"],
          suppressed: false
        }
      ]
    };
    const cryptoStub = {
      randomUUID: () => "90000000-0000-4000-8000-000000000099",
      subtle: {
        digest: async () => new Uint8Array(32).buffer
      }
    };
    vi.stubGlobal("crypto", cryptoStub);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/modeling/projects") {
          return projectListResponse(blank);
        }
        if (url.includes("/revisions?")) {
          return revisionListResponse(
            url.includes("refresh-import") ? importedDocument : blank
          );
        }
        if (url.endsWith("/imports/presign")) {
          return jsonResponse({
            data: {
              upload: {
                key: "modeling/private/housing.step",
                method: "PUT",
                url: "https://private-oss.test/signed-put",
                requiredHeaders: { "Content-Type": "model/step" },
                expiresAt: "2026-08-01T00:15:00.000Z"
              },
              constraints: { format: "STEP", maxBytes: 50 * 1024 * 1024 }
            }
          });
        }
        if (url === "https://private-oss.test/signed-put") {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/imports/complete")) {
          return jsonResponse({
            data: {
              job: {
                id: "import-job",
                status: "succeeded",
                output: { revisionId: importedRevisionId }
              }
            }
          });
        }
        if (
          url === "/api/modeling/projects/33333333-3333-4333-8333-333333333333"
        ) {
          return jsonResponse({
            data: {
              id: "33333333-3333-4333-8333-333333333333",
              name: "STEP 导入测试",
              currentRevision: {
                id: importedRevisionId,
                document: importedDocument
              }
            }
          });
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          return jsonResponse({
            data: {
              job: {
                id: "import-preview-job",
                status: "succeeded",
                output: { artifactIds: ["import-preview"] }
              }
            }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(blank);
    await screen.findByText("已保存到项目");
    const file = new File(["STEP"], "housing.step", { type: "model/step" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("STEP").buffer
    });

    fireEvent.change(screen.getByLabelText("导入 STEP 文件"), {
      target: { files: [file] }
    });

    expect(
      await screen.findByText(/housing.step 已导入为新的 STEP 基础实体版本/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("1. Imported STEP: housing.step")
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-oss\.test/)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "https://private-oss.test/signed-put"
      )
    ).toBe(true);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}

function revisionListResponse(document = template) {
  return jsonResponse({
    data: {
      items: [
        {
          id: document.revisionId,
          revisionNumber: 1,
          source: "initial",
          document,
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      page: 1,
      pageSize: 50,
      total: 1
    }
  });
}

function twoBodyGeneralDocument() {
  const blank = createBlankPartDocument("双实体通用零件");
  const commands: ManualOperation[] = [
    toolCommand("workspace-sketch-a", "sketch", {
      plane: "xy",
      shape: "rectangle",
      width: 40,
      height: 30,
      diameter: 30
    }),
    toolCommand("workspace-extrude-a", "extrude", {
      distance: 20,
      direction: "normal"
    }),
    toolCommand("workspace-sketch-b", "sketch", {
      plane: "xy",
      shape: "circle",
      width: 20,
      height: 20,
      diameter: 12
    }),
    toolCommand("workspace-extrude-b", "extrude", {
      distance: 20,
      direction: "normal"
    })
  ];
  return applyOperationBatch(
    blank,
    createOperationBatchFromManualState(
      blank,
      commands,
      "workspace-two-body-base-1"
    )!
  );
}

function toolCommand(
  id: string,
  tool: Extract<ManualOperation, { type: "tool_command" }>["tool"],
  settings: Record<string, number | string | boolean>
): ManualOperation {
  return { id, type: "tool_command", tool, targetPartId: "", settings };
}
