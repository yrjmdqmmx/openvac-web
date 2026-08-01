from dataclasses import replace
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app import main as main_module
from app.isolation import IsolatedExecutionTimeout
from app.main import app


client = TestClient(app)


def test_health_is_public() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "openvac-modeling"


def test_required_internal_token_fails_closed_when_unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            require_service_token=True,
            service_token=None,
        ),
    )

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["detail"] == "service token is not configured"


def test_lifespan_preloads_and_stops_the_isolated_kernel() -> None:
    main_module._kernel_executor.stop()
    assert main_module._kernel_executor.pid is None

    with TestClient(app) as lifespan_client:
        response = lifespan_client.get("/ready")
        assert response.status_code == 200
        assert main_module._kernel_executor.pid is not None

    assert main_module._kernel_executor.pid is None


@pytest.mark.timeout(90)
def test_pump_validation_is_deterministic() -> None:
    response = client.post(
        "/v1/pumps/validate",
        json={
            "chamber_diameter": 100,
            "rotor_diameter": 80,
            "eccentricity": 6,
            "axial_width": 60,
            "vane_count": 2,
            "vane_thickness": 4,
            "vane_height": 26,
            "shaft_diameter": 20,
            "inlet_width": 18,
            "outlet_width": 16,
            "tip_clearance": 0.15,
        },
    )
    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["samples"] == 360
    assert response.json()["analysis_method"] == "deterministic_analytic_geometry_with_occt_brep"
    assert response.json()["brep_checked"] is True
    assert response.json()["brep_samples"] == 360
    assert response.json()["brep_sampling_step_degrees"] <= 1
    assert response.json()["inlet_passage_connected"] is True
    assert response.json()["outlet_passage_connected"] is True
    assert response.json()["port_same_chamber_samples"] == 0


def test_sketch_solve_runs_in_isolated_solver_process() -> None:
    response = client.post(
        "/v1/sketches/solve",
        json={
            "version": "openvac.modeling.v1",
            "entities": [{"id": "axis", "kind": "line", "start": [0, 0], "end": [25, 0]}],
            "constraints": [
                {"id": "origin", "kind": "fixed", "refs": ["axis:start"]},
                {"id": "horizontal", "kind": "horizontal", "refs": ["axis"]},
                {
                    "id": "length",
                    "kind": "distance",
                    "refs": ["axis:start", "axis:end"],
                    "value": 25,
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "solved"
    assert response.json()["dof"] == 0


def test_build_endpoint_returns_real_step_and_glb_descriptors() -> None:
    response = client.post(
        "/v1/builds",
        json={
            "version": "openvac.modeling.v1",
            "job_id": "service-box",
            "document": {
                "name": "service-box",
                "features": [
                    {
                        "id": "body",
                        "kind": "box",
                        "parameters": {"width": 12, "depth": 8, "height": 4},
                    }
                ],
            },
            "formats": ["step", "glb"],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["valid"] is True
    assert payload["metrics"]["volume_mm3"] == 384
    assert {artifact["kind"] for artifact in payload["artifacts"]} == {"step", "glb"}


def test_validation_endpoint_rebuilds_without_writing_exports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, artifact_root=tmp_path.resolve()),
    )
    response = client.post(
        "/v1/validations",
        json={
            "version": "openvac.modeling.v1",
            "job_id": "validate-box",
            "document": {
                "name": "validate-box",
                "features": [
                    {
                        "id": "body",
                        "kind": "box",
                        "parameters": {"width": 6, "depth": 5, "height": 4},
                    }
                ],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["artifacts"] == []
    assert not (tmp_path / "validate-box").exists()


def test_validation_endpoint_accepts_authoritatively_solved_sketch_without_solid() -> None:
    response = client.post(
        "/v1/validations",
        json={
            "version": "openvac.modeling.v1",
            "job_id": "validate-sketch-only",
            "document": {
                "version": "openvac.modeling.v1",
                "unitSystem": "mm-deg",
                "parameters": [
                    {
                        "id": "width",
                        "semanticRef": "parameter.width",
                        "name": "width",
                        "parameterType": "length",
                        "unit": "mm",
                        "value": 20,
                    },
                    {
                        "id": "height",
                        "semanticRef": "parameter.height",
                        "name": "height",
                        "parameterType": "length",
                        "unit": "mm",
                        "value": 10,
                    },
                ],
                "sketches": [
                    {
                        "id": "sketch",
                        "semanticRef": "sketch.profile",
                        "plane": "xy",
                        "suppressed": False,
                        "entities": [
                            {
                                "id": "center",
                                "semanticRef": "sketch.center",
                                "entityKind": "point",
                                "construction": True,
                                "x": 0,
                                "y": 0,
                            },
                            {
                                "id": "profile",
                                "semanticRef": "sketch.profile.rectangle",
                                "entityKind": "rectangle",
                                "construction": False,
                                "centerPointRef": {
                                    "id": "center",
                                    "semanticRef": "sketch.center",
                                },
                                "widthParameterRef": {
                                    "id": "width",
                                    "semanticRef": "parameter.width",
                                },
                                "heightParameterRef": {
                                    "id": "height",
                                    "semanticRef": "parameter.height",
                                },
                                "rotationDegrees": 0,
                            },
                        ],
                        "constraints": [],
                    }
                ],
                "features": [],
                "components": [],
                "assemblyConstraints": [],
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["valid"] is True
    assert payload["metrics"] is None
    assert payload["artifacts"] == []
    assert "MODEL_DOCUMENT_NO_SOLID" in {item["code"] for item in payload["diagnostics"]}


def test_validation_timeout_cleans_request_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, artifact_root=tmp_path.resolve()),
    )

    async def timeout_after_creating_workspace(*args, timeout_seconds):
        job_id = str(args[2])
        (tmp_path / job_id).mkdir(parents=True)
        (tmp_path / job_id / "partial.tmp").write_bytes(b"partial")
        raise IsolatedExecutionTimeout("forced timeout")

    monkeypatch.setattr(
        main_module,
        "_run_kernel_single_flight",
        timeout_after_creating_workspace,
    )
    response = client.post(
        "/v1/validations",
        json={
            "version": "openvac.modeling.v1",
            "job_id": "validate-timeout-cleanup",
            "document": {"name": "timeout", "features": []},
        },
    )

    assert response.status_code == 504
    assert not (tmp_path / "validate-timeout-cleanup").exists()


def test_step_import_endpoint_validates_brep_and_returns_glb(tmp_path) -> None:
    import pytest

    pytest.importorskip("vtk", exc_type=ImportError)
    cq = pytest.importorskip("cadquery")
    source = tmp_path / "housing.step"
    cq.exporters.export(cq.Workplane("XY").box(12, 8, 4), str(source))
    source_bytes = source.read_bytes()

    response = client.post(
        "/v1/imports/step?job_id=service-step-import&formats=stl,glb",
        files={"file": ("housing.step", source_bytes, "model/step")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["valid"] is True
    assert payload["source_size_bytes"] == len(source_bytes)
    assert payload["metrics"]["solid_count"] == 1
    assert payload["body_semantic_refs"][0].startswith("import.body.")
    assert [item["kind"] for item in payload["artifacts"]] == ["stl", "glb"]


def test_step_import_endpoint_rejects_invalid_content() -> None:
    response = client.post(
        "/v1/imports/step?job_id=service-bad-step",
        files={"file": ("bad.step", b"not a STEP file", "model/step")},
    )

    assert response.status_code == 422


def test_imported_step_validation_rebuilds_downstream_feature_history(
    tmp_path,
) -> None:
    import pytest

    pytest.importorskip("vtk", exc_type=ImportError)
    cq = pytest.importorskip("cadquery")
    source = tmp_path / "editable.step"
    cq.exporters.export(cq.Workplane("XY").box(10, 10, 10), str(source))
    source_bytes = source.read_bytes()
    imported = client.post(
        "/v1/imports/step?job_id=service-editable-import&formats=glb",
        files={"file": ("editable.step", source_bytes, "model/step")},
    )
    assert imported.status_code == 200
    imported_payload = imported.json()
    artifact_id = "44444444-4444-4444-8444-444444444444"
    imported_feature = {
        "id": "55555555-5555-4555-8555-555555555555",
        "semanticRef": "feature.imported-base",
        "name": "Imported STEP base",
        "featureKind": "imported_step",
        "artifactId": artifact_id,
        "artifactSha256": imported_payload["source_sha256"],
        "sourceName": "editable.step",
        "bodySemanticRefs": imported_payload["body_semantic_refs"],
        "suppressed": False,
    }
    document = {
        "version": "openvac.modeling.v1",
        "id": "document",
        "revisionId": "revision",
        "unitSystem": "mm-deg",
        "name": "Imported base with hole",
        "parameters": [
            {
                "id": "diameter",
                "semanticRef": "parameter.diameter",
                "name": "diameter",
                "parameterType": "length",
                "unit": "mm",
                "value": 4,
            }
        ],
        "sketches": [],
        "features": [
            imported_feature,
            {
                "id": "66666666-6666-4666-8666-666666666666",
                "semanticRef": "feature.hole",
                "featureKind": "hole",
                "placement": {
                    "placementKind": "semantic_face",
                    "sourceFeatureRef": {
                        "id": imported_feature["id"],
                        "semanticRef": imported_feature["semanticRef"],
                    },
                    "faceSelector": "top",
                },
                "diameterParameterRef": {
                    "id": "diameter",
                    "semanticRef": "parameter.diameter",
                },
                "termination": "through_all",
                "operation": "cut",
                "suppressed": False,
            },
        ],
        "components": [],
        "assemblyConstraints": [],
    }
    response = client.post(
        "/v1/validations/imported-step",
        params={
            "job_id": "service-imported-history",
            "artifact_id": artifact_id,
            "artifact_sha256": imported_payload["source_sha256"],
        },
        data={"document": json.dumps(document)},
        files={"file": ("editable.step", source_bytes, "model/step")},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["valid"] is True
    assert payload["artifacts"] == []
    assert payload["metrics"]["volume_mm3"] == pytest.approx(
        1_000 - 3.141592653589793 * 2**2 * 10,
        rel=1e-6,
    )
    assert "IMPORTED_STEP_BASE_RESOLVED" in {item["code"] for item in payload["diagnostics"]}
    assert not (tmp_path / "service-imported-history").exists()


def test_imported_validation_cleans_workspace_when_upload_validation_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, artifact_root=tmp_path.resolve()),
    )
    client = TestClient(app)
    artifact_id = "55555555-5555-4555-8555-555555555555"

    response = client.post(
        "/v1/validations/imported-step",
        params={
            "job_id": "failed-imported-validation",
            "artifact_id": artifact_id,
            "artifact_sha256": "0" * 64,
        },
        data={"document": "{}"},
        files={"file": ("invalid.step", b"not-the-expected-file", "model/step")},
    )

    assert response.status_code == 422
    assert not (tmp_path / "failed-imported-validation").exists()


def test_artifact_cleanup_is_authenticated_idempotent_and_job_scoped(
    monkeypatch,
    tmp_path,
) -> None:
    job_id = "cleanup-job_01"
    job_dir = tmp_path / job_id
    job_dir.mkdir()
    (job_dir / "model.glb").write_bytes(b"glTF")
    root_marker = tmp_path / "keep.txt"
    root_marker.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            artifact_root=tmp_path,
            service_token="cleanup-secret",
        ),
    )

    unauthorized = client.delete(f"/v1/artifacts/{job_id}")
    assert unauthorized.status_code == 401
    assert job_dir.is_dir()

    deleted = client.delete(
        f"/v1/artifacts/{job_id}",
        headers={"x-openvac-service-token": "cleanup-secret"},
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "deleted", "job_id": job_id}
    assert not job_dir.exists()
    assert root_marker.read_text(encoding="utf-8") == "keep"

    repeated = client.delete(
        f"/v1/artifacts/{job_id}",
        headers={"x-openvac-service-token": "cleanup-secret"},
    )
    assert repeated.status_code == 200
    assert repeated.json() == {"status": "absent", "job_id": job_id}


def test_artifact_cleanup_rejects_invalid_ids_and_symlinks(
    monkeypatch,
    tmp_path,
) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "must-stay.txt").write_text("safe", encoding="utf-8")
    (tmp_path / "linked-job").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            artifact_root=tmp_path,
            service_token="cleanup-secret",
        ),
    )
    headers = {"x-openvac-service-token": "cleanup-secret"}

    invalid = client.delete("/v1/artifacts/bad.job", headers=headers)
    assert invalid.status_code == 422
    linked = client.delete("/v1/artifacts/linked-job", headers=headers)
    assert linked.status_code == 409
    assert (outside / "must-stay.txt").read_text(encoding="utf-8") == "safe"
