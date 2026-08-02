from copy import deepcopy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.engine import (
    _authoritative_protocol_sketch_diagnostics,
    _protocol_parameter_values,
    _validate_document_assembly_constraints,
    build_to_artifacts,
    build_model,
    canonical_json,
    import_step_to_artifacts,
    model_hash,
)


def test_canonical_hash_is_key_order_independent() -> None:
    left = {"name": "part", "parameters": {"b": 2, "a": 1}}
    right = {"parameters": {"a": 1, "b": 2}, "name": "part"}

    assert canonical_json(left) == canonical_json(right)
    assert model_hash(left) == model_hash(right)


def test_rotary_vane_interactive_rebuild_skips_full_pump_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = Path(__file__).parent / "fixtures" / "rotary_vane_pump_v1.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))

    def unexpected_full_validation(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("interactive B-Rep rebuild invoked full pump validation")

    monkeypatch.setattr("app.engine.validate_rotary_vane_pump", unexpected_full_validation)
    monkeypatch.setattr(
        "app.engine._authoritative_protocol_sketch_diagnostics",
        lambda *_args, **_kwargs: [],
    )

    class FakeShape:
        def val(self) -> "FakeShape":
            return self

    class FakeAssembly:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def add(self, *_args: object, **_kwargs: object) -> None:
            pass

    class FakeCompound:
        @staticmethod
        def makeCompound(_shapes: list[FakeShape]) -> FakeShape:
            return FakeShape()

    fake_cq = SimpleNamespace(
        Assembly=FakeAssembly,
        Color=lambda *_args: object(),
        Compound=FakeCompound,
    )
    fake_geometry = SimpleNamespace(
        housing=FakeShape(),
        rotor=FakeShape(),
        shaft=FakeShape(),
        front_cover=FakeShape(),
        rear_cover=FakeShape(),
        vanes=(FakeShape(), FakeShape()),
    )
    monkeypatch.setattr("app.engine._cadquery", lambda: fake_cq)
    monkeypatch.setattr("app.engine.build_pump_brep_geometry", lambda _params: fake_geometry)
    monkeypatch.setattr(
        "app.engine._solve_document_assembly_constraints",
        lambda *_args, **_kwargs: ({}, []),
    )
    monkeypatch.setattr(
        "app.engine._validate_document_assembly_constraints",
        lambda *_args, **_kwargs: [],
    )

    built = build_model(document, validate_pump=False)

    assert built.shape is not None
    assert built.assembly is not None


def _assembly_document() -> dict:
    def component(identifier: str, translation: list[float], rotation: list[float]) -> dict:
        return {
            "id": identifier,
            "semanticRef": f"component.{identifier}",
            "transform": {
                "translationMm": translation,
                "rotationDegrees": rotation,
            },
            "suppressed": False,
        }

    def reference(identifier: str) -> dict:
        return {"id": identifier, "semanticRef": f"component.{identifier}"}

    return {
        "parameters": [
            {
                "id": "offset",
                "semanticRef": "parameter.offset",
                "value": 6,
            }
        ],
        "components": [
            component("base", [0, 0, 0], [0, 0, 0]),
            component("offset", [6, 0, 0], [0, 0, 0]),
            component("coaxial", [0, 0, 10], [0, 0, 180]),
            component("mated", [0, 0, 0], [0, 0, 0]),
        ],
        "assemblyConstraints": [
            {
                "id": "fixed",
                "semanticRef": "assembly.fixed",
                "constraintKind": "fixed",
                "componentRefs": [reference("base")],
                "status": "satisfied",
            },
            {
                "id": "distance",
                "semanticRef": "assembly.distance",
                "constraintKind": "distance",
                "componentRefs": [reference("base"), reference("offset")],
                "parameterRef": {
                    "id": "offset",
                    "semanticRef": "parameter.offset",
                },
                "status": "satisfied",
            },
            {
                "id": "concentric",
                "semanticRef": "assembly.concentric",
                "constraintKind": "concentric",
                "componentRefs": [reference("base"), reference("coaxial")],
                "status": "satisfied",
            },
            {
                "id": "mate",
                "semanticRef": "assembly.origin-mate",
                "constraintKind": "coincident",
                "componentRefs": [reference("base"), reference("mated")],
                "status": "satisfied",
            },
        ],
    }


def test_deterministic_assembly_datum_constraints_are_validated() -> None:
    document = _assembly_document()
    parameters = {"offset": 6.0, "parameter.offset": 6.0}
    diagnostics = _validate_document_assembly_constraints(document, parameters)
    codes = {item.code for item in diagnostics}

    assert codes == {
        "ASSEMBLY_FIXED_SATISFIED",
        "ASSEMBLY_DISTANCE_SATISFIED",
        "ASSEMBLY_CONCENTRIC_SATISFIED",
        "ASSEMBLY_ORIGIN_MATE_SATISFIED",
    }
    assert all(item.severity == "info" for item in diagnostics)


def test_assembly_mismatch_and_unsupported_constraint_fail_closed() -> None:
    document = _assembly_document()
    document["components"][1]["transform"]["translationMm"] = [5, 0, 0]
    document["assemblyConstraints"].append(
        {
            "id": "unsupported",
            "semanticRef": "assembly.unsupported-angle",
            "constraintKind": "angle",
            "componentRefs": [
                {"id": "base", "semanticRef": "component.base"},
                {"id": "offset", "semanticRef": "component.offset"},
            ],
            "status": "satisfied",
        }
    )
    diagnostics = _validate_document_assembly_constraints(
        document, {"offset": 6.0, "parameter.offset": 6.0}
    )
    by_code = {item.code: item for item in diagnostics}

    assert by_code["ASSEMBLY_DISTANCE_MISMATCH"].severity == "error"
    assert by_code["ASSEMBLY_CONSTRAINT_UNSUPPORTED"].severity == "error"
    assert "未被静默忽略" in by_code["ASSEMBLY_CONSTRAINT_UNSUPPORTED"].message


def _template_style_sketch_document(*, rotor_x: float = 6) -> dict:
    def ref(identifier: str) -> dict:
        return {"id": identifier, "semanticRef": f"sketch.{identifier}"}

    parameter_values = {
        "eccentricity": 6,
        "chamber-diameter": 100,
        "rotor-diameter": 80,
        "shaft-diameter": 20,
        "vane-width": 4,
        "vane-height": 26,
        "axial-width": 60,
        "vane-count": 2,
        "inlet-width": 18,
        "outlet-width": 16,
    }
    parameter_names = {
        "eccentricity": "eccentricity",
        "chamber-diameter": "chamberDiameter",
        "rotor-diameter": "rotorDiameter",
        "shaft-diameter": "shaftDiameter",
        "vane-width": "vaneThickness",
        "vane-height": "vaneHeight",
        "axial-width": "axialWidth",
        "vane-count": "vaneCount",
        "inlet-width": "inletWidth",
        "outlet-width": "outletWidth",
    }
    parameters = [
        {
            "id": identifier,
            "semanticRef": f"parameter.{identifier}",
            "name": parameter_names[identifier],
            "parameterType": "integer" if identifier == "vane-count" else "length",
            "unit": "count" if identifier == "vane-count" else "mm",
            "value": value,
        }
        for identifier, value in parameter_values.items()
    ]
    center = {
        **ref("chamber-center"),
        "entityKind": "point",
        "construction": True,
        "x": 0,
        "y": 0,
    }
    rotor = {
        **ref("rotor-center"),
        "entityKind": "point",
        "construction": True,
        "x": rotor_x,
        "y": 0,
    }
    entities = [
        center,
        rotor,
        {
            **ref("chamber-circle"),
            "entityKind": "circle",
            "construction": False,
            "centerPointRef": ref("chamber-center"),
            "diameterParameterRef": {
                "id": "chamber-diameter",
                "semanticRef": "parameter.chamber-diameter",
            },
        },
        {
            **ref("rotor-circle"),
            "entityKind": "circle",
            "construction": False,
            "centerPointRef": ref("rotor-center"),
            "diameterParameterRef": {
                "id": "rotor-diameter",
                "semanticRef": "parameter.rotor-diameter",
            },
        },
        {
            **ref("shaft-circle"),
            "entityKind": "circle",
            "construction": False,
            "centerPointRef": ref("rotor-center"),
            "diameterParameterRef": {
                "id": "shaft-diameter",
                "semanticRef": "parameter.shaft-diameter",
            },
        },
        {
            **ref("vane-profile"),
            "entityKind": "rectangle",
            "construction": False,
            "centerPointRef": ref("rotor-center"),
            "widthParameterRef": {
                "id": "vane-width",
                "semanticRef": "parameter.vane-width",
            },
            "heightParameterRef": {
                "id": "vane-height",
                "semanticRef": "parameter.vane-height",
            },
            "rotationDegrees": 0,
        },
    ]

    def constraint(
        identifier: str,
        kind: str,
        targets: list[dict],
        parameter: str | None = None,
    ) -> dict:
        result = {
            "id": identifier,
            "semanticRef": f"constraint.{identifier}",
            "constraintKind": kind,
            "targetRefs": targets,
            "status": "satisfied",
        }
        if parameter is not None:
            result["parameterRef"] = {
                "id": parameter,
                "semanticRef": f"parameter.{parameter}",
            }
        return result

    constraints = [
        constraint("center-fixed", "fixed", [ref("chamber-center")]),
        constraint(
            "centers-horizontal",
            "horizontal",
            [ref("chamber-center"), ref("rotor-center")],
        ),
        constraint(
            "eccentricity",
            "distance",
            [ref("chamber-center"), ref("rotor-center")],
            "eccentricity",
        ),
        constraint("chamber-diameter", "diameter", [ref("chamber-circle")], "chamber-diameter"),
        constraint("rotor-diameter", "diameter", [ref("rotor-circle")], "rotor-diameter"),
        constraint("shaft-diameter", "diameter", [ref("shaft-circle")], "shaft-diameter"),
        constraint("vane-fixed", "fixed", [ref("vane-profile")]),
    ]
    return {
        "version": "openvac.modeling.v1",
        "unitSystem": "mm-deg",
        "parameters": parameters,
        "sketches": [
            {
                "id": "cross-section",
                "semanticRef": "sketch.cross-section",
                "plane": "xy",
                "entities": entities,
                "constraints": constraints,
                "solveStatus": "fully_constrained",
                "suppressed": False,
            }
        ],
    }


def test_template_two_point_horizontal_and_fixed_rectangle_solve_authoritatively() -> None:
    document = _template_style_sketch_document()
    diagnostics = _authoritative_protocol_sketch_diagnostics(
        document, _protocol_parameter_values(document)
    )

    assert [item.code for item in diagnostics] == ["SKETCH_SOLVED_AUTHORITATIVE"]
    assert diagnostics[0].severity == "info"
    assert "未作为证据" in diagnostics[0].message


@pytest.mark.timeout(90)
def test_strict_template_style_pump_build_solves_sketch_before_real_brep(
    tmp_path: Path,
) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    pytest.importorskip("cadquery")
    document = _template_style_sketch_document()
    document["name"] = "strict template pump"
    document["templateKind"] = "rotary_vane_pump"

    response = build_to_artifacts("strict-template-pump", document, [], tmp_path, True)
    codes = {item.code for item in response.diagnostics}

    assert response.valid is True
    assert "SKETCH_SOLVED_AUTHORITATIVE" in codes
    assert "PUMP_GEOMETRY_VALID" in codes


@pytest.mark.timeout(90)
def test_structured_typescript_template_metadata_routes_to_pump_builder(
    tmp_path: Path,
) -> None:
    pytest.importorskip("cadquery")
    fixture = Path(__file__).parent / "fixtures" / "rotary_vane_pump_v1.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))

    response = build_to_artifacts("structured-template-pump", document, [], tmp_path, True)
    codes = {item.code for item in response.diagnostics}

    assert response.valid is True
    assert "PUMP_GEOMETRY_VALID" in codes
    assert "PUMP_BREP_ROTATION_VALID" in codes
    assert "PUMP_BREP_INLET_PASSAGE_CONNECTED" in codes
    assert "PUMP_BREP_OUTLET_PASSAGE_CONNECTED" in codes


def test_structured_pump_template_rejects_ignored_tree_edits(
    tmp_path: Path,
) -> None:
    pytest.importorskip("cadquery")
    fixture = Path(__file__).parent / "fixtures" / "rotary_vane_pump_v1.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))

    suppressed = deepcopy(document)
    suppressed["features"][0]["suppressed"] = True
    with pytest.raises(ValueError, match="template contract violation"):
        build_to_artifacts("suppressed-pump-tree", suppressed, [], tmp_path, True)

    reordered = deepcopy(document)
    reordered["features"][0], reordered["features"][1] = (
        reordered["features"][1],
        reordered["features"][0],
    )
    with pytest.raises(ValueError, match="template contract violation"):
        build_to_artifacts("reordered-pump-tree", reordered, [], tmp_path, True)

    drifted_transform = deepcopy(document)
    drifted_transform["components"][1]["transform"]["translationMm"][0] += 1
    with pytest.raises(ValueError, match="rotating-group translation"):
        build_to_artifacts("drifted-pump-transform", drifted_transform, [], tmp_path, True)

    missing_cover = deepcopy(document)
    missing_cover["features"].pop()
    with pytest.raises(ValueError, match="feature tree"):
        build_to_artifacts("missing-rear-cover", missing_cover, [], tmp_path, True)

    concentric_cover_bore = deepcopy(document)
    concentric_cover_bore["sketches"][1]["entities"][1]["x"] = 0
    with pytest.raises(ValueError, match="eccentric annulus"):
        build_to_artifacts(
            "concentric-cover-bore",
            concentric_cover_bore,
            [],
            tmp_path,
            True,
        )

    forged_cover_dimension = deepcopy(document)
    forged_cover_dimension["parameters"][-1]["value"] += 1
    with pytest.raises(ValueError, match="non-editable derived value"):
        build_to_artifacts(
            "forged-cover-dimension",
            forged_cover_dimension,
            [],
            tmp_path,
            True,
        )


def test_artifact_root_symlink_is_normalized_before_path_guard(
    tmp_path: Path,
) -> None:
    pytest.importorskip("cadquery")
    real_root = tmp_path / "real-artifacts"
    real_root.mkdir()
    linked_root = tmp_path / "linked-artifacts"
    linked_root.symlink_to(real_root, target_is_directory=True)
    document = _template_style_sketch_document()
    document["templateKind"] = "rotary_vane_pump"

    response = build_to_artifacts("symlink-root", document, [], linked_root, True)

    assert response.valid is True
    assert (real_root / "symlink-root").is_dir()


def test_solver_updated_geometry_replaces_client_seed_coordinates() -> None:
    document = _template_style_sketch_document(rotor_x=7)
    diagnostics = _authoritative_protocol_sketch_diagnostics(
        document, _protocol_parameter_values(document)
    )

    assert [item.code for item in diagnostics] == ["SKETCH_SOLVED_GEOMETRY_UPDATED"]
    assert diagnostics[0].severity == "info"
    assert "B-Rep 将使用求解后坐标" in diagnostics[0].message
    assert "solveStatus=fully_constrained 未作为证据" in diagnostics[0].message


def test_unsupported_sketch_constraint_is_never_silently_ignored() -> None:
    document = _template_style_sketch_document()
    document["sketches"][0]["constraints"][1]["constraintKind"] = "projected_magic"
    diagnostics = _authoritative_protocol_sketch_diagnostics(
        document, _protocol_parameter_values(document)
    )

    assert [item.code for item in diagnostics] == ["SKETCH_PROTOCOL_MAPPING_UNSUPPORTED"]
    assert diagnostics[0].severity == "error"
    assert "未静默忽略" in diagnostics[0].message


def test_basic_box_builds_real_artifacts(tmp_path: Path) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    cq = pytest.importorskip("cadquery")
    response = build_to_artifacts(
        "box-job",
        {
            "name": "benchmark-box",
            "features": [
                {
                    "id": "box-feature",
                    "kind": "box",
                    "parameters": {"width": 30, "depth": 20, "height": 10},
                }
            ],
        },
        ["step", "stl", "glb"],
        tmp_path,
        False,
    )

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 1
    assert response.metrics.volume_mm3 == pytest.approx(6000, rel=1e-6)
    assert response.metrics.mass_kg is None
    assert response.metrics.mass_status == "unavailable_density_required"
    assert {item.kind for item in response.artifacts} == {"step", "stl", "glb"}
    assert {
        "STEP_EXPORT_READBACK_VALID",
        "STL_EXPORT_READBACK_VALID",
        "GLB_EXPORT_READBACK_VALID",
    }.issubset({item.code for item in response.diagnostics})
    for artifact in response.artifacts:
        assert (tmp_path / "box-job" / artifact.file_name).stat().st_size > 0

    # STEP is not accepted merely because an exporter returned successfully:
    # read it back through OCCT and enforce the V1 interoperability tolerances.
    round_trip = cq.importers.importStep(str(tmp_path / "box-job" / "model.step")).val()
    bounds = round_trip.BoundingBox()
    for actual, expected in zip((bounds.xlen, bounds.ylen, bounds.zlen), (30, 20, 10)):
        assert abs(actual - expected) <= max(0.05, expected * 0.0005)
    assert round_trip.Volume() == pytest.approx(6000, rel=0.001)

    glb = (tmp_path / "box-job" / "model.glb").read_bytes()
    assert glb[:4] == b"glTF"


def test_mass_uses_only_explicit_user_density(tmp_path: Path) -> None:
    pytest.importorskip("cadquery")
    document = {
        "name": "density-box",
        "metadata": {
            "material": {
                "name": "user material",
                "densityKgM3": 7_850,
                "densitySource": "user",
            }
        },
        "features": [
            {
                "id": "box-feature",
                "kind": "box",
                "parameters": {"width": 30, "depth": 20, "height": 10},
            }
        ],
    }

    response = build_to_artifacts("density-job", document, [], tmp_path, False)

    assert response.metrics is not None
    assert response.metrics.mass_status == "computed_from_user_density"
    assert response.metrics.mass_kg == pytest.approx(0.0471, rel=1e-9)

    document["metadata"]["material"]["densitySource"] = "inferred"
    with pytest.raises(ValueError, match="explicitly supplied"):
        build_to_artifacts("inferred-density-job", document, [], tmp_path, False)


def test_step_export_readback_mismatch_fails_before_artifact_registration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cq = pytest.importorskip("cadquery")

    monkeypatch.setattr(
        cq.importers,
        "importStep",
        lambda _path: cq.Workplane("XY").box(1, 1, 1),
    )

    with pytest.raises(ValueError, match="bounding envelope differs"):
        build_to_artifacts(
            "bad-step-readback",
            {
                "name": "30 x 20 x 10 mm block",
                "features": [
                    {
                        "id": "block",
                        "kind": "box",
                        "parameters": {"width": 30, "depth": 20, "height": 10},
                    }
                ],
            },
            ["step"],
            tmp_path,
            False,
        )


def test_step_import_creates_stable_opaque_bodies_and_glb(tmp_path: Path) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    cq = pytest.importorskip("cadquery")
    job_dir = tmp_path / "step-import"
    job_dir.mkdir()
    source = job_dir / "import.step"
    cq.exporters.export(cq.Workplane("XY").box(12, 8, 4), str(source))

    first = import_step_to_artifacts("step-import", source, tmp_path, formats=("stl", "glb"))
    second = import_step_to_artifacts("step-import", source, tmp_path, formats=("stl", "glb"))

    assert first.valid is True
    assert first.metrics.solid_count == 1
    assert first.metrics.volume_mm3 == pytest.approx(384, rel=1e-6)
    assert first.body_semantic_refs == second.body_semantic_refs
    assert first.body_semantic_refs[0].startswith(f"import.body.{first.source_sha256[:12]}.")
    assert [artifact.kind for artifact in first.artifacts] == ["stl", "glb"]
    assert (job_dir / "model.stl").stat().st_size >= 84
    assert (job_dir / "model.glb").read_bytes()[:4] == b"glTF"


def test_step_import_rejects_non_step_content(tmp_path: Path) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    pytest.importorskip("cadquery")
    job_dir = tmp_path / "bad-import"
    job_dir.mkdir()
    source = job_dir / "import.step"
    source.write_bytes(b"this is not STEP")

    with pytest.raises(Exception, match="STEP|step|syntax|parse"):
        import_step_to_artifacts("bad-import", source, tmp_path)


def test_imported_step_is_a_real_base_feature_for_downstream_history(
    tmp_path: Path,
) -> None:
    cq = pytest.importorskip("cadquery")
    source_job = tmp_path / "editable-import-source"
    source_job.mkdir()
    source = source_job / "import.step"
    cq.exporters.export(cq.Workplane("XY").box(10, 10, 10), str(source))
    imported = import_step_to_artifacts(
        "editable-import-source", source, tmp_path, formats=("glb",)
    )
    imported_feature = {
        "id": "imported-base-id",
        "semanticRef": "feature.imported-base",
        "name": "opaque STEP base",
        "featureKind": "imported_step",
        "artifactId": "source-artifact-id",
        "artifactSha256": imported.source_sha256,
        "sourceName": "import.step",
        "bodySemanticRefs": imported.body_semantic_refs,
        "suppressed": False,
    }
    document = {
        "version": "openvac.modeling.v1",
        "id": "document",
        "revisionId": "revision",
        "unitSystem": "mm-deg",
        "name": "editable imported base",
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
                "id": "hole-id",
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

    response = build_to_artifacts(
        "editable-import-build",
        document,
        [],
        tmp_path,
        False,
        {"source-artifact-id": str(source)},
    )

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1_000 - math.pi * 2**2 * 10, rel=1e-6)
    assert "IMPORTED_STEP_BASE_RESOLVED" in {item.code for item in response.diagnostics}

    with pytest.raises(ValueError, match="trusted worker"):
        build_to_artifacts(
            "missing-import-source",
            document,
            [],
            tmp_path,
            False,
        )


def test_original_pump_builds_valid_closed_solids(tmp_path: Path) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    pytest.importorskip("cadquery")
    response = build_to_artifacts(
        "pump-job",
        {
            "name": "原创单级旋片泵",
            "templateKind": "rotary_vane_pump",
            "parameters": {
                "chamberDiameter": 100,
                "rotorDiameter": 80,
                "eccentricity": 6,
                "axialWidth": 60,
                "vaneCount": 2,
                "vaneThickness": 4,
                "vaneHeight": 26,
                "shaftDiameter": 20,
                "inletWidth": 18,
                "outletWidth": 16,
            },
        },
        ["glb"],
        tmp_path,
        True,
    )

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count >= 7
    assert any(item.code == "PUMP_GEOMETRY_VALID" for item in response.diagnostics)


def test_strict_protocol_closed_polyline_builds_a_solid(tmp_path: Path) -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    pytest.importorskip("cadquery")
    points = [
        {
            "id": f"point-{index}",
            "semanticRef": f"profile.point.{index}",
            "entityKind": "point",
            "construction": False,
            "x": x,
            "y": y,
        }
        for index, (x, y) in enumerate([(-10, -5), (10, -5), (10, 5), (-10, 5)])
    ]
    profile_refs = [{"id": point["id"], "semanticRef": point["semanticRef"]} for point in points]
    response = build_to_artifacts(
        "protocol-profile",
        {
            "version": "openvac.modeling.v1",
            "id": "document",
            "revisionId": "revision",
            "unitSystem": "mm-deg",
            "name": "protocol plate",
            "parameters": [
                {
                    "id": "depth",
                    "semanticRef": "parameter.depth",
                    "name": "depth",
                    "parameterType": "length",
                    "unit": "mm",
                    "value": 5,
                }
            ],
            "sketches": [
                {
                    "id": "sketch",
                    "semanticRef": "sketch.profile",
                    "plane": "xy",
                    "suppressed": False,
                    "entities": [
                        *points,
                        {
                            "id": "outline",
                            "semanticRef": "profile.outline",
                            "entityKind": "polyline",
                            "construction": False,
                            "pointRefs": profile_refs,
                            "closed": True,
                        },
                    ],
                    "constraints": [
                        {
                            "id": "fixed-outline",
                            "semanticRef": "constraint.fixed-outline",
                            "constraintKind": "fixed",
                            "targetRefs": [
                                {
                                    "id": "outline",
                                    "semanticRef": "profile.outline",
                                }
                            ],
                            "status": "satisfied",
                        }
                    ],
                    "solveStatus": "fully_constrained",
                }
            ],
            "features": [
                {
                    "id": "extrude",
                    "semanticRef": "feature.extrude",
                    "featureKind": "extrude",
                    "profileRefs": [{"id": "outline", "semanticRef": "profile.outline"}],
                    "distanceParameterRef": {
                        "id": "depth",
                        "semanticRef": "parameter.depth",
                    },
                    "direction": "normal",
                    "operation": "new_body",
                    "suppressed": False,
                }
            ],
            "components": [],
        },
        ["step"],
        tmp_path,
        False,
    )

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1000, rel=1e-6)
