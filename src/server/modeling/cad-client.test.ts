import { describe, expect, it, vi } from "vitest";

import type { ModelDocument } from "@/types/modeling";

import { ModelingServiceClient, ModelingServiceError } from "./cad-client";

const document = {
  version: "openvac.modeling.v1",
  id: "11111111-1111-4111-8111-111111111111",
  revision: 0,
  revisionId: "22222222-2222-4222-8222-222222222222",
  name: "测试零件",
  unitSystem: "mm-deg",
  parameters: [],
  sketches: [],
  features: [],
  components: [],
  assemblyConstraints: []
} satisfies ModelDocument;

describe("ModelingServiceClient", () => {
  it("authenticates and validates deterministic build responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "openvac.modeling.v1",
          job_id: "33333333-3333-4333-8333-333333333333",
          model_hash: "a".repeat(64),
          kernel_version: "2.8.0",
          solver_version: "slvs-3.2",
          valid: true,
          diagnostics: [],
          metrics: {
            solid_count: 1,
            volume_mm3: 1000,
            surface_area_mm2: 600,
            bounding_box_mm: [10, 10, 10],
            center_of_mass_mm: [0, 0, 0],
            mass_kg: null,
            mass_status: "unavailable_density_required"
          },
          artifacts: [],
          duration_ms: 20
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new ModelingServiceClient({
      baseUrl: "http://modeling.internal",
      token: "service-token",
      fetch: fetchMock
    });

    const result = await client.build({
      jobId: "33333333-3333-4333-8333-333333333333",
      document,
      formats: ["glb"]
    });

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    expect(
      new Headers(request?.[1]?.headers).get("x-openvac-service-token")
    ).toBe("service-token");
  });

  it("rejects malformed kernel results instead of trusting them", async () => {
    const client = new ModelingServiceClient({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ valid: true }), { status: 200 })
        )
    });

    await expect(
      client.build({
        jobId: "33333333-3333-4333-8333-333333333333",
        document,
        formats: ["glb"]
      })
    ).rejects.toBeInstanceOf(ModelingServiceError);
  });

  it("runs an artifact-free authoritative validation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "openvac.modeling.v1",
          job_id: "33333333-3333-4333-8333-333333333333",
          model_hash: "c".repeat(64),
          kernel_version: "2.8.0",
          solver_version: "slvs-3.2",
          valid: true,
          diagnostics: [],
          metrics: null,
          artifacts: [],
          duration_ms: 12
        }),
        { status: 200 }
      )
    );
    const client = new ModelingServiceClient({
      baseUrl: "http://modeling.internal",
      fetch: fetchMock
    });

    await expect(
      client.validate({
        jobId: "33333333-3333-4333-8333-333333333333",
        document
      })
    ).resolves.toMatchObject({ valid: true, artifacts: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://modeling.internal/v1/validations"
    );
  });

  it("authenticates and validates idempotent artifact cleanup", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "deleted", job_id: jobId }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new ModelingServiceClient({
      baseUrl: "http://modeling.internal",
      token: "service-token",
      fetch: fetchMock
    });

    await expect(client.cleanupArtifacts(jobId)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`http://modeling.internal/v1/artifacts/${jobId}`);
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("x-openvac-service-token")).toBe(
      "service-token"
    );
  });

  it("rejects unsafe artifact cleanup ids before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new ModelingServiceClient({ fetch: fetchMock });

    await expect(client.cleanupArtifacts("../another-job")).rejects.toThrow(
      "job id"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies artifact byte length", async () => {
    const client = new ModelingServiceClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-length": "2" }
        })
      )
    });

    await expect(
      client.downloadArtifact({
        kind: "glb",
        file_name: "model.glb",
        content_type: "model/gltf-binary",
        size_bytes: 3,
        sha256: "b".repeat(64),
        download_path: "/v1/artifacts/job/model.glb"
      })
    ).rejects.toThrow("长度");
  });

  it.each([undefined, "1"])(
    "rejects an oversized artifact body when Content-Length is %s",
    async (contentLength) => {
      const headers = new Headers();
      if (contentLength) {
        headers.set("content-length", contentLength);
      }
      const arrayBuffer = vi.fn(async () => {
        // A lightweight stand-in proves the post-read byteLength guard runs
        // before Uint8Array allocation, without allocating 100 MB in the test.
        return { byteLength: 100 * 1024 * 1024 + 1 } as ArrayBuffer;
      });
      const response = {
        ok: true,
        status: 200,
        headers,
        arrayBuffer
      } as unknown as Response;
      const client = new ModelingServiceClient({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response)
      });

      await expect(
        client.downloadArtifact({
          kind: "glb",
          file_name: "model.glb",
          content_type: "model/gltf-binary",
          size_bytes: 100 * 1024 * 1024 + 1,
          sha256: "b".repeat(64),
          download_path: "/v1/artifacts/job/model.glb"
        })
      ).rejects.toThrow("超过内部传输上限");
      expect(arrayBuffer).toHaveBeenCalledOnce();
    }
  );

  it("uploads STEP bytes as multipart and validates the import result", async () => {
    const bytes = new TextEncoder().encode("ISO-10303-21;");
    const sourceHash = "c".repeat(64);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "openvac.modeling.v1",
          job_id: "33333333-3333-4333-8333-333333333333",
          source_sha256: sourceHash,
          source_size_bytes: bytes.byteLength,
          kernel_version: "2.8.0",
          valid: true,
          diagnostics: [],
          metrics: {
            solid_count: 1,
            volume_mm3: 1000,
            surface_area_mm2: 600,
            bounding_box_mm: [10, 10, 10],
            center_of_mass_mm: [0, 0, 0],
            mass_kg: null,
            mass_status: "unavailable_density_required"
          },
          body_semantic_refs: ["import.body.abcdef.abcdef.1"],
          artifacts: [
            {
              kind: "glb",
              file_name: "model.glb",
              content_type: "model/gltf-binary",
              size_bytes: 12,
              sha256: "d".repeat(64),
              download_path:
                "/v1/artifacts/33333333-3333-4333-8333-333333333333/model.glb"
            }
          ],
          duration_ms: 10
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new ModelingServiceClient({
      baseUrl: "http://modeling.internal",
      fetch: fetchMock
    });

    const result = await client.importStep({
      jobId: "33333333-3333-4333-8333-333333333333",
      bytes,
      filename: "housing.step",
      contentType: "model/step"
    });

    expect(result.source_sha256).toBe(sourceHash);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("/v1/imports/step?job_id=");
    expect(init?.body).toBeInstanceOf(FormData);
    const uploaded = (init?.body as FormData).get("file");
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as File).name).toBe("housing.step");
    expect((uploaded as File).type).toBe("model/step");
  });

  it("sends an immutable STEP base with downstream validation as multipart", async () => {
    const bytes = new TextEncoder().encode("ISO-10303-21;BASE;ENDSEC;");
    const artifactId = "44444444-4444-4444-8444-444444444444";
    const artifactSha256 = "e".repeat(64);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "openvac.modeling.v1",
          job_id: "33333333-3333-4333-8333-333333333333",
          model_hash: "f".repeat(64),
          kernel_version: "cadquery-2.8.0/ocp-7.9.3.1",
          solver_version: "slvs-3.2",
          valid: true,
          diagnostics: [],
          metrics: {
            solid_count: 1,
            volume_mm3: 900,
            surface_area_mm2: 580,
            bounding_box_mm: [10, 10, 10],
            center_of_mass_mm: [0, 0, 0],
            mass_kg: null,
            mass_status: "unavailable_density_required"
          },
          artifacts: [],
          duration_ms: 18
        }),
        { status: 200 }
      )
    );
    const client = new ModelingServiceClient({
      baseUrl: "http://modeling.internal",
      fetch: fetchMock
    });

    await client.validate({
      jobId: "33333333-3333-4333-8333-333333333333",
      document,
      importedStep: {
        artifactId,
        artifactSha256,
        bytes,
        filename: "housing.step",
        contentType: "model/step"
      }
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("/v1/validations/imported-step?");
    expect(url).toContain(`artifact_id=${artifactId}`);
    expect(url).toContain(`artifact_sha256=${artifactSha256}`);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("document")).toBe(
      JSON.stringify(document)
    );
    const uploaded = (init?.body as FormData).get("file");
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as File).name).toBe("housing.step");
  });
});
