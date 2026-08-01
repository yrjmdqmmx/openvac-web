import { describe, expect, it, vi } from "vitest";
import {
  cancelModelingJob,
  createModelingJob,
  importPrivateStep,
  listModelingRevisions,
  ModelingClientError,
  normalizeAiPlan,
  rejectAiPlan,
  withAiPlanOperationDiffs
} from "./api";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";

describe("modeling client AI plan normalization", () => {
  it("preserves plan rationale, explicit DSL operations, and dry-run evidence", () => {
    const result = normalizeAiPlan({
      plan: {
        id: "plan-1",
        planHash: "hash-1",
        draft: {
          status: "validated",
          summary: "增加入口孔并保留旧修订。",
          assumptions: ["单位为毫米"],
          warnings: ["孔位仍需工程师确认"],
          expectedChecks: ["闭合实体", "端口连通"],
          operationBatch: {
            operations: [
              {
                operationId: "operation-1",
                kind: "add",
                collection: "features",
                item: { semanticRef: "manual.feature.inlet-hole" }
              }
            ]
          }
        }
      },
      output: {
        artifactIds: ["artifact-preview"],
        dryRun: {
          diagnostics: [
            {
              code: "SOLID_VALID",
              severity: "info",
              message: "闭合实体有效"
            }
          ],
          metrics: { volume: 123.4 }
        }
      }
    });

    expect(result).toMatchObject({
      status: "preview",
      summary: "增加入口孔并保留旧修订。",
      assumptions: ["单位为毫米"],
      warnings: ["孔位仍需工程师确认"],
      expectedChecks: ["闭合实体", "端口连通"],
      previewArtifactId: "artifact-preview",
      operations: [
        {
          kind: "add",
          collection: "features",
          item: { semanticRef: "manual.feature.inlet-hole" },
          label: "新增特征 · manual.feature.inlet-hole",
          summary: "特征：不存在 → manual.feature.inlet-hole",
          diffs: [
            {
              field: "item",
              label: "特征",
              before: "不存在",
              after: "manual.feature.inlet-hole"
            }
          ]
        }
      ],
      diagnostics: [
        {
          code: "SOLID_VALID",
          severity: "info",
          message: "闭合实体有效"
        }
      ],
      metrics: { volume: 123.4 }
    });
  });

  it("computes exact parameter and feature before/after values from the base revision", () => {
    const document = createRotaryVanePumpTemplate({
      parameters: { eccentricity: 8 }
    });
    const eccentricity = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const feature = document.features[0]!;
    const result = normalizeAiPlan({
      id: "plan-diff",
      status: "validated",
      planHash: "hash-diff",
      draft: {
        status: "validated",
        operationBatch: {
          operations: [
            {
              operationId: "operation-parameter",
              kind: "update",
              collection: "parameters",
              target: {
                id: eccentricity.id,
                semanticRef: eccentricity.semanticRef
              },
              changes: { value: 9 }
            },
            {
              operationId: "operation-feature",
              kind: "update",
              collection: "features",
              target: { id: feature.id, semanticRef: feature.semanticRef },
              changes: { name: "更新后的特征", suppressed: true }
            }
          ]
        }
      }
    });

    expect(result.status).toBe("preview");
    if (result.status !== "preview") return;
    const operations = withAiPlanOperationDiffs(result.operations, document);

    expect(operations[0]).toMatchObject({
      kind: "update",
      collection: "parameters",
      target: { semanticRef: eccentricity.semanticRef },
      changes: { value: 9 },
      label: `修改参数 · ${eccentricity.label}`,
      diffs: [{ field: "value", label: "数值", before: "8 mm", after: "9 mm" }]
    });
    expect(operations[1]).toMatchObject({
      kind: "update",
      collection: "features",
      label: `修改特征 · ${feature.name}`,
      diffs: [
        {
          field: "name",
          label: "名称",
          before: feature.name,
          after: "更新后的特征"
        },
        {
          field: "suppressed",
          label: "抑制状态",
          before: "启用",
          after: "已抑制"
        }
      ]
    });
  });
});

describe("modeling client AI plan decisions", () => {
  it("rejects a plan with an idempotency key", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          data: { plan: { id: "plan-1", status: "rejected" } }
        });
      }
    );

    await rejectAiPlan("plan/with spaces", fetcher);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "/api/modeling/ai-plans/plan%2Fwith%20spaces/reject"
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      idempotencyKey: expect.stringContaining("reject-")
    });
  });
});

describe("modeling client export jobs", () => {
  it.each(["step", "stl", "glb"] as const)(
    "sends the selected %s format to the immutable revision export job",
    async (format) => {
      const fetcher = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          void input;
          void init;
          return Response.json({
            data: { job: { id: `job-${format}`, status: "queued" } }
          });
        }
      );

      const job = await createModelingJob(
        "project-1",
        {
          revisionId: "revision-1",
          kind: "export",
          formats: [format],
          idempotencyKey: `export-${format}`
        },
        fetcher
      );

      expect(job.id).toBe(`job-${format}`);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe("/api/modeling/projects/project-1/jobs");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        revisionId: "revision-1",
        kind: "export",
        formats: [format]
      });
    }
  );
});

describe("modeling client job cancellation", () => {
  it("requests idempotent server cancellation for a stale preview", async () => {
    const jobId = "10000000-0000-4000-8000-000000000008";
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          data: {
            job: { id: jobId, status: "running" },
            cancellationRequested: true
          }
        });
      }
    );

    const result = await cancelModelingJob(jobId, fetcher);

    expect(result.cancellationRequested).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`/api/modeling/jobs/${jobId}/cancel`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      idempotencyKey: expect.stringContaining(`cancel-${jobId}`)
    });
  });
});

describe("modeling client revision history", () => {
  it("loads immutable revision documents with bounded pagination", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          data: {
            items: [
              {
                id: "revision-2",
                revisionNumber: 2,
                source: "manual",
                document: { version: "openvac.modeling.v1" }
              }
            ],
            page: 1,
            pageSize: 50,
            total: 2
          }
        });
      }
    );

    const result = await listModelingRevisions(
      "project/with spaces",
      { pageSize: 50 },
      fetcher
    );

    expect(result.total).toBe(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/modeling/projects/project%2Fwith%20spaces/revisions?page=1&pageSize=50"
    );
  });
});

describe("modeling client private STEP import", () => {
  it("hashes, privately uploads, and only then confirms the import job", async () => {
    const file = new File([new TextEncoder().encode("abc")], "housing.step", {
      type: "model/step"
    });
    const progress: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/imports/presign")) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          expect(body).toMatchObject({
            filename: "housing.step",
            mimeType: "model/step",
            sizeBytes: 3,
            checksumSha256:
              "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
          });
          return Response.json({
            data: {
              upload: {
                key: "modeling/private/import.step",
                method: "PUT",
                url: "https://private-oss.test/signed-put",
                requiredHeaders: {
                  "Content-Type": "model/step",
                  "Content-Length": "3",
                  "x-oss-meta-sha256": body.checksumSha256
                },
                expiresAt: "2026-08-01T00:15:00.000Z"
              },
              constraints: { format: "STEP", maxBytes: 50 * 1024 * 1024 }
            }
          });
        }
        if (url === "https://private-oss.test/signed-put") {
          expect(init?.method).toBe("PUT");
          expect(new Headers(init?.headers).get("content-length")).toBeNull();
          expect(new Headers(init?.headers).get("content-type")).toBe(
            "model/step"
          );
          expect(init?.body).toBe(file);
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/imports/complete")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            objectKey: "modeling/private/import.step",
            sizeBytes: 3,
            checksumSha256:
              "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
          });
          return Response.json({
            data: { job: { id: "import-job", status: "queued" } }
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    const result = await importPrivateStep("project-1", file, {
      fetcher,
      onProgress: (value) => progress.push(value)
    });

    expect(result.job.id).toBe("import-job");
    expect(progress).toEqual([
      "hashing",
      "presigning",
      "uploading",
      "verifying"
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid file before requesting a signed URL", async () => {
    const fetcher = vi.fn();
    const file = new File(["not-step"], "notes.txt", { type: "text/plain" });

    await expect(
      importPrivateStep("project-1", file, { fetcher })
    ).rejects.toBeInstanceOf(ModelingClientError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not confirm an import when the private PUT fails", async () => {
    const file = new File(["STEP"], "housing.stp", {
      type: "application/octet-stream"
    });
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.endsWith("/imports/presign")) {
          return Response.json({
            data: {
              upload: {
                key: "modeling/private/housing.step",
                method: "PUT",
                url: "https://private-oss.test/signed-put",
                requiredHeaders: {},
                expiresAt: "2026-08-01T00:15:00.000Z"
              },
              constraints: { format: "STEP", maxBytes: 50 * 1024 * 1024 }
            }
          });
        }
        return new Response(null, { status: 403 });
      }
    );

    await expect(
      importPrivateStep("project-1", file, { fetcher })
    ).rejects.toThrow("尚未创建导入版本");
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).endsWith("/imports/complete")
      )
    ).toBe(false);
  });
});
