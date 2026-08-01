from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
from typing import Any

import pytest

from app.engine import build_to_artifacts, validate_document


def ref(name: str) -> dict[str, str]:
    return {"id": name, "semanticRef": name}


def parameter(name: str, value: float) -> dict[str, Any]:
    parameter_type, unit = (
        ("integer", "count")
        if name == "count"
        else ("angle", "deg")
        if name == "angle"
        else ("length", "mm")
    )
    return {
        "id": name,
        "semanticRef": name,
        "name": name,
        "parameterType": parameter_type,
        "unit": unit,
        "value": value,
    }


def base_document(*, center_x: float = 0) -> dict[str, Any]:
    return {
        "version": "openvac.modeling.v1",
        "id": "document",
        "revisionId": "revision",
        "unitSystem": "mm-deg",
        "name": "protocol feature test",
        "parameters": [
            parameter("width", 20),
            parameter("height", 10),
            parameter("depth", 5),
            parameter("diameter", 4),
            parameter("small", 1),
            parameter("count", 3),
            parameter("spacing", 30),
            parameter("angle", 360),
        ],
        "sketches": [
            {
                "id": "sketch",
                "semanticRef": "sketch",
                "plane": "xy",
                "suppressed": False,
                "entities": [
                    {
                        **ref("center"),
                        "entityKind": "point",
                        "construction": True,
                        "x": center_x,
                        "y": 0,
                    },
                    {
                        **ref("profile"),
                        "entityKind": "rectangle",
                        "construction": False,
                        "centerPointRef": ref("center"),
                        "widthParameterRef": ref("width"),
                        "heightParameterRef": ref("height"),
                        "rotationDegrees": 0,
                    },
                ],
            }
        ],
        "features": [
            {
                **ref("base"),
                "featureKind": "extrude",
                "profileRefs": [ref("profile")],
                "distanceParameterRef": ref("depth"),
                "direction": "normal",
                "operation": "new_body",
                "suppressed": False,
            }
        ],
        "components": [],
        "assemblyConstraints": [],
    }


def build(document: dict[str, Any], tmp_path: Path):
    return build_to_artifacts("feature-test", document, [], tmp_path, False)


def test_protocol_accepts_exact_100_entities_and_200_user_constraints(
    tmp_path: Path,
) -> None:
    document = base_document()
    entities = [
        {
            **ref(f"point-{index}"),
            "entityKind": "point",
            "construction": True,
            "x": float(index),
            "y": 0.0,
        }
        for index in range(100)
    ]
    constraints = [
        {
            **ref(f"fixed-{index}"),
            "constraintKind": "fixed",
            "targetRefs": [ref(f"point-{index % 100}")],
            "status": "suppressed",
        }
        for index in range(200)
    ]
    document["sketches"][0]["entities"] = entities
    document["sketches"][0]["constraints"] = constraints
    document["features"] = []

    response = validate_document("protocol-capacity", document, tmp_path, validate_pump=False)

    assert response.valid is True
    assert "SKETCH_UNDERCONSTRAINED" in {item.code for item in response.diagnostics}
    assert any("200 个明确 suppressed" in item.message for item in response.diagnostics)


def test_parameter_constraint_moves_authoritative_profile_before_brep(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["parameters"] = [
        parameter("offset", 5),
        parameter("diameter", 10),
        parameter("depth", 4),
    ]
    origin = {
        **ref("origin"),
        "entityKind": "point",
        "construction": True,
        "x": 0,
        "y": 0,
    }
    center = {
        **ref("center"),
        "entityKind": "point",
        "construction": True,
        "x": 4,
        "y": 0,
    }
    document["sketches"] = [
        {
            "id": "sketch",
            "semanticRef": "sketch",
            "plane": "xy",
            "suppressed": False,
            "entities": [
                origin,
                center,
                {
                    **ref("profile"),
                    "entityKind": "circle",
                    "construction": False,
                    "centerPointRef": ref("center"),
                    "diameterParameterRef": ref("diameter"),
                },
            ],
            "constraints": [
                {
                    **ref("fixed-origin"),
                    "constraintKind": "fixed",
                    "targetRefs": [ref("origin")],
                    "status": "satisfied",
                },
                {
                    **ref("horizontal-centers"),
                    "constraintKind": "horizontal",
                    "targetRefs": [ref("origin"), ref("center")],
                    "status": "satisfied",
                },
                {
                    **ref("center-offset"),
                    "constraintKind": "distance",
                    "targetRefs": [ref("origin"), ref("center")],
                    "parameterRef": ref("offset"),
                    "status": "satisfied",
                },
                {
                    **ref("profile-diameter"),
                    "constraintKind": "diameter",
                    "targetRefs": [ref("profile")],
                    "parameterRef": ref("diameter"),
                    "status": "satisfied",
                },
            ],
        }
    ]
    document["features"] = [
        {
            **ref("base"),
            "featureKind": "extrude",
            "profileRefs": [ref("profile")],
            "distanceParameterRef": ref("depth"),
            "direction": "normal",
            "operation": "new_body",
            "suppressed": False,
        }
    ]

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.center_of_mass_mm[0] == pytest.approx(5, abs=1e-6)
    assert "SKETCH_SOLVED_GEOMETRY_UPDATED" in {item.code for item in response.diagnostics}


def test_feature_parameter_dimension_mismatch_fails_before_brep(
    tmp_path: Path,
) -> None:
    document = base_document()
    depth = next(item for item in document["parameters"] if item["id"] == "depth")
    depth["parameterType"] = "angle"
    depth["unit"] = "deg"

    with pytest.raises(ValueError, match="extrude distance requires length/mm"):
        build(document, tmp_path)


def test_pattern_count_never_truncates_a_fractional_value(tmp_path: Path) -> None:
    document = base_document()
    document["features"].append(
        {
            **ref("linear-pattern"),
            "featureKind": "linear_pattern",
            "sourceFeatureRef": ref("base"),
            "directionVector": [1, 0, 0],
            "countParameterRef": ref("count"),
            "spacingParameterRef": ref("spacing"),
            "suppressed": False,
        }
    )
    count = next(item for item in document["parameters"] if item["id"] == "count")
    count["value"] = 2.9

    with pytest.raises(ValueError, match="exact integer"):
        build(document, tmp_path)


def test_two_circle_profile_builds_a_real_annulus(tmp_path: Path) -> None:
    document = base_document()
    document["parameters"] = [
        parameter("outer", 20),
        parameter("inner", 10),
        parameter("depth", 5),
    ]
    document["sketches"] = [
        {
            "id": "ring-sketch",
            "semanticRef": "sketch.ring",
            "plane": "xy",
            "suppressed": False,
            "entities": [
                {
                    **ref("center"),
                    "entityKind": "point",
                    "construction": True,
                    "x": 0,
                    "y": 0,
                },
                {
                    **ref("outer-circle"),
                    "entityKind": "circle",
                    "construction": False,
                    "centerPointRef": ref("center"),
                    "diameterParameterRef": ref("outer"),
                },
                {
                    **ref("inner-circle"),
                    "entityKind": "circle",
                    "construction": False,
                    "centerPointRef": ref("center"),
                    "diameterParameterRef": ref("inner"),
                },
            ],
            "constraints": [
                {
                    **ref("center-fixed"),
                    "constraintKind": "fixed",
                    "targetRefs": [ref("center")],
                    "status": "satisfied",
                },
                {
                    **ref("outer-diameter"),
                    "constraintKind": "diameter",
                    "targetRefs": [ref("outer-circle")],
                    "parameterRef": ref("outer"),
                    "status": "satisfied",
                },
                {
                    **ref("inner-diameter"),
                    "constraintKind": "diameter",
                    "targetRefs": [ref("inner-circle")],
                    "parameterRef": ref("inner"),
                    "status": "satisfied",
                },
            ],
        }
    ]
    document["features"] = [
        {
            **ref("ring"),
            "featureKind": "extrude",
            "profileRefs": [ref("outer-circle"), ref("inner-circle")],
            "distanceParameterRef": ref("depth"),
            "direction": "normal",
            "operation": "new_body",
            "suppressed": False,
        }
    ]

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(math.pi * (10**2 - 5**2) * 5, rel=1e-6)


def test_disconnected_line_profile_is_not_silently_closed(tmp_path: Path) -> None:
    document = base_document()
    points = [(0, 0), (10, 0), (12, 10), (0, 10)]
    document["sketches"][0]["entities"] = [
        *[
            {
                **ref(f"point-{index}"),
                "entityKind": "point",
                "construction": False,
                "x": x,
                "y": y,
            }
            for index, (x, y) in enumerate(points)
        ],
        {
            **ref("line-0"),
            "entityKind": "line",
            "construction": False,
            "startPointRef": ref("point-0"),
            "endPointRef": ref("point-1"),
        },
        {
            **ref("line-1"),
            "entityKind": "line",
            "construction": False,
            "startPointRef": ref("point-2"),
            "endPointRef": ref("point-3"),
        },
    ]
    document["sketches"][0]["constraints"] = [
        {
            **ref("points-fixed"),
            "constraintKind": "fixed",
            "targetRefs": [ref(f"point-{index}") for index in range(4)],
            "status": "satisfied",
        }
    ]
    document["features"][0]["profileRefs"] = [ref("line-0"), ref("line-1")]

    with pytest.raises(ValueError, match="continuous closed loop"):
        build(document, tmp_path)


def test_clockwise_arc_and_line_form_a_closed_profile(tmp_path: Path) -> None:
    document = base_document()
    document["sketches"][0]["entities"] = [
        {
            **ref("left"),
            "entityKind": "point",
            "construction": False,
            "x": -10,
            "y": 0,
        },
        {
            **ref("right"),
            "entityKind": "point",
            "construction": False,
            "x": 10,
            "y": 0,
        },
        {
            **ref("center"),
            "entityKind": "point",
            "construction": True,
            "x": 0,
            "y": 0,
        },
        {
            **ref("diameter-line"),
            "entityKind": "line",
            "construction": False,
            "startPointRef": ref("left"),
            "endPointRef": ref("right"),
        },
        {
            **ref("semicircle"),
            "entityKind": "arc",
            "construction": False,
            "centerPointRef": ref("center"),
            "startPointRef": ref("right"),
            "endPointRef": ref("left"),
            "clockwise": True,
        },
    ]
    # This fixture verifies arc orientation/profile construction. Leaving the
    # seed geometry underconstrained avoids adding a deliberately redundant
    # endpoint/arc-radius constraint system to that separate concern.
    document["sketches"][0]["constraints"] = []
    document["features"][0]["profileRefs"] = [
        ref("diameter-line"),
        ref("semicircle"),
    ]

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(math.pi * 10**2 / 2 * 5, rel=1e-5)
    assert response.metrics.center_of_mass_mm[1] < 0


@pytest.mark.parametrize("kind", ["fillet", "chamfer"])
def test_semantic_edge_finishing_rebuilds(kind: str, tmp_path: Path) -> None:
    document = base_document()
    amount_key = "radiusParameterRef" if kind == "fillet" else "distanceParameterRef"
    document["features"].append(
        {
            **ref(f"{kind}-feature"),
            "featureKind": kind,
            "sourceFeatureRefs": [ref("base")],
            "edgeSelector": "vertical",
            amount_key: ref("small"),
            "suppressed": False,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 < 1_000


def test_semantic_face_hole_cuts_the_previous_solid(tmp_path: Path) -> None:
    document = base_document()
    document["features"].append(
        {
            **ref("hole-feature"),
            "featureKind": "hole",
            "placement": {
                "placementKind": "semantic_face",
                "sourceFeatureRef": ref("base"),
                "faceSelector": "top",
            },
            "diameterParameterRef": ref("diameter"),
            "termination": "through_all",
            "operation": "cut",
            "suppressed": False,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1_000 - math.pi * 2**2 * 5, rel=1e-6)


def test_cut_extrusion_uses_a_semantic_circle_profile(tmp_path: Path) -> None:
    document = base_document()
    document["sketches"][0]["entities"].append(
        {
            **ref("cut-profile"),
            "entityKind": "circle",
            "construction": False,
            "centerPointRef": ref("center"),
            "diameterParameterRef": ref("diameter"),
        }
    )
    document["features"].append(
        {
            **ref("cut-extrude"),
            "featureKind": "extrude",
            "profileRefs": [ref("cut-profile")],
            "distanceParameterRef": ref("depth"),
            "direction": "normal",
            "operation": "cut",
            "suppressed": False,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1_000 - math.pi * 2**2 * 5, rel=1e-6)


def test_slot_profile_extrudes_to_a_closed_solid(tmp_path: Path) -> None:
    document = base_document()
    document["parameters"].append(parameter("slot-width", 4))
    document["sketches"][0]["entities"].extend(
        [
            {
                **ref("slot-start"),
                "entityKind": "point",
                "construction": True,
                "x": -8,
                "y": 0,
            },
            {
                **ref("slot-end"),
                "entityKind": "point",
                "construction": True,
                "x": 8,
                "y": 0,
            },
            {
                **ref("slot-profile"),
                "entityKind": "slot",
                "construction": False,
                "startPointRef": ref("slot-start"),
                "endPointRef": ref("slot-end"),
                "widthParameterRef": ref("slot-width"),
            },
        ]
    )
    document["features"] = [
        {
            **ref("slot-extrude"),
            "featureKind": "extrude",
            "profileRefs": [ref("slot-profile")],
            "distanceParameterRef": ref("depth"),
            "direction": "symmetric",
            "operation": "new_body",
            "suppressed": False,
        }
    ]

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 1


def test_revolve_uses_a_semantic_axis_in_the_sketch(tmp_path: Path) -> None:
    document = base_document()
    entities: list[dict[str, Any]] = []
    for name, x, y in (
        ("p0", 5, 0),
        ("p1", 10, 0),
        ("p2", 10, 5),
        ("p3", 5, 5),
        ("axis-start", 0, 0),
        ("axis-end", 0, 5),
    ):
        entities.append(
            {
                **ref(name),
                "entityKind": "point",
                "construction": True,
                "x": x,
                "y": y,
            }
        )
    entities.extend(
        [
            {
                **ref("revolve-profile"),
                "entityKind": "polyline",
                "construction": False,
                "pointRefs": [ref("p0"), ref("p1"), ref("p2"), ref("p3")],
                "closed": True,
            },
            {
                **ref("axis"),
                "entityKind": "line",
                "construction": True,
                "startPointRef": ref("axis-start"),
                "endPointRef": ref("axis-end"),
            },
        ]
    )
    document["sketches"][0]["entities"] = entities
    document["features"] = [
        {
            **ref("revolve"),
            "featureKind": "revolve",
            "profileRefs": [ref("revolve-profile")],
            "axisRef": ref("axis"),
            "angleParameterRef": ref("angle"),
            "operation": "new_body",
            "suppressed": False,
        }
    ]

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 1


def test_port_cut_rebuilds_without_topology_indices(tmp_path: Path) -> None:
    document = base_document(center_x=20)
    document["features"].append(
        {
            **ref("port"),
            "featureKind": "port",
            "role": "inlet",
            "chamberProfileRef": ref("profile"),
            "widthParameterRef": ref("diameter"),
            "axialWidthParameterRef": ref("depth"),
            "centerAngleDegrees": 0,
            "operation": "cut",
            "suppressed": False,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert 0 < response.metrics.volume_mm3 < 1_000
    assert "PORT_PROFILE_SEMANTICS_VALID" in {item.code for item in response.diagnostics}


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            {"role": "service"},
            "port role must be inlet or outlet",
        ),
        (
            {"operation": "add"},
            "V1 port operation must be cut",
        ),
        (
            {"chamberProfileRef": ref("missing-profile")},
            "unknown semantic sketch reference: missing-profile",
        ),
        (
            {"chamberProfileRef": ref("center")},
            "construction geometry cannot define a solid profile",
        ),
        (
            {"chamberProfileRef": ref("other-profile")},
            "port chamberProfileRef must belong to the current body profile lineage",
        ),
    ],
)
def test_port_semantics_fail_closed(mutation: dict[str, Any], message: str, tmp_path: Path) -> None:
    document = base_document()
    document["sketches"][0]["entities"].append(
        {
            **ref("other-profile"),
            "entityKind": "rectangle",
            "construction": False,
            "centerPointRef": ref("center"),
            "widthParameterRef": ref("small"),
            "heightParameterRef": ref("small"),
            "rotationDegrees": 0,
        }
    )
    port = {
        **ref("port"),
        "featureKind": "port",
        "role": "inlet",
        "chamberProfileRef": ref("profile"),
        "widthParameterRef": ref("diameter"),
        "axialWidthParameterRef": ref("depth"),
        "centerAngleDegrees": 0,
        "operation": "cut",
        "suppressed": False,
    }
    port.update(deepcopy(mutation))
    document["features"].append(port)

    with pytest.raises(ValueError, match=message):
        build(document, tmp_path)


@pytest.mark.parametrize(
    ("kind", "feature", "expected_volume"),
    [
        (
            "mirror",
            {
                **ref("mirror-feature"),
                "featureKind": "mirror",
                "sourceFeatureRefs": [ref("base")],
                "mirrorPlane": "yz",
                "suppressed": False,
            },
            2_000,
        ),
        (
            "linear",
            {
                **ref("linear-feature"),
                "featureKind": "linear_pattern",
                "sourceFeatureRef": ref("base"),
                "directionVector": [1, 0, 0],
                "countParameterRef": ref("count"),
                "spacingParameterRef": ref("spacing"),
                "suppressed": False,
            },
            3_000,
        ),
        (
            "circular",
            {
                **ref("circular-feature"),
                "featureKind": "circular_pattern",
                "sourceFeatureRef": ref("base"),
                "axisOrigin": [0, 0, 0],
                "axisDirection": [0, 0, 1],
                "countParameterRef": ref("count"),
                "totalAngleDegrees": 360,
                "suppressed": False,
            },
            3_000,
        ),
    ],
)
def test_patterns_and_mirror_keep_all_bodies(
    kind: str, feature: dict[str, Any], expected_volume: float, tmp_path: Path
) -> None:
    document = base_document(center_x=20)
    document["features"].append(deepcopy(feature))

    response = build(document, tmp_path)

    assert response.valid is True, kind
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(expected_volume, rel=1e-6)


def test_boolean_uses_semantic_feature_references(tmp_path: Path) -> None:
    document = base_document(center_x=-6)
    document["sketches"][0]["entities"].extend(
        [
            {
                **ref("tool-center"),
                "entityKind": "point",
                "construction": True,
                "x": 6,
                "y": 0,
            },
            {
                **ref("tool-profile"),
                "entityKind": "rectangle",
                "construction": False,
                "centerPointRef": ref("tool-center"),
                "widthParameterRef": ref("width"),
                "heightParameterRef": ref("height"),
                "rotationDegrees": 0,
            },
        ]
    )
    document["features"].extend(
        [
            {
                **ref("tool"),
                "featureKind": "extrude",
                "profileRefs": [ref("tool-profile")],
                "distanceParameterRef": ref("depth"),
                "direction": "normal",
                "operation": "new_body",
                "suppressed": False,
            },
            {
                **ref("union"),
                "featureKind": "boolean",
                "targetFeatureRef": ref("base"),
                "toolFeatureRefs": [ref("tool")],
                "operation": "union",
                "suppressed": False,
            },
        ]
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1_600, rel=1e-6)


def test_suppressed_feature_is_not_executed(tmp_path: Path) -> None:
    document = base_document()
    document["features"].append(
        {
            **ref("future-feature"),
            "featureKind": "not_supported",
            "suppressed": True,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.volume_mm3 == pytest.approx(1_000, rel=1e-6)


def test_multiple_new_body_features_remain_distinct_terminal_solids(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["sketches"].append(
        {
            "id": "offset-sketch",
            "semanticRef": "sketch.offset",
            "plane": "xy",
            "suppressed": False,
            "entities": [
                {
                    **ref("offset-center"),
                    "entityKind": "point",
                    "construction": True,
                    "x": 30,
                    "y": 0,
                },
                {
                    **ref("offset-profile"),
                    "entityKind": "rectangle",
                    "construction": False,
                    "centerPointRef": ref("offset-center"),
                    "widthParameterRef": ref("width"),
                    "heightParameterRef": ref("height"),
                    "rotationDegrees": 0,
                },
            ],
            "constraints": [],
        }
    )
    document["features"].append(
        {
            **ref("offset-body"),
            "featureKind": "extrude",
            "profileRefs": [ref("offset-profile")],
            "distanceParameterRef": ref("depth"),
            "direction": "normal",
            "operation": "new_body",
            "suppressed": False,
        }
    )

    response = build(document, tmp_path)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 2
    assert response.metrics.volume_mm3 == pytest.approx(2_000, rel=1e-6)
    assert response.metrics.bounding_box_mm == pytest.approx((50, 10, 5), rel=1e-6)


def test_component_cannot_compound_ancestor_and_terminal_snapshot(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["features"].append(
        {
            **ref("fillet-feature"),
            "featureKind": "fillet",
            "sourceFeatureRefs": [ref("base")],
            "edgeSelector": "vertical",
            "radiusParameterRef": ref("small"),
            "suppressed": False,
        }
    )
    document["components"] = [
        {
            "id": "component-body-id",
            "semanticRef": "component.body",
            "name": "invalid history compound",
            "featureRefs": [ref("base"), ref("fillet-feature")],
            "transform": {
                "translationMm": [0, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        }
    ]

    with pytest.raises(ValueError, match="terminal feature outputs"):
        build(document, tmp_path)


def test_assembly_metrics_and_exports_use_transformed_component_compound(
    tmp_path: Path,
) -> None:
    def component_identity(name: str) -> dict[str, str]:
        return {"id": f"component-{name}-id", "semanticRef": f"component.{name}"}

    def component_ref(name: str) -> dict[str, str]:
        return component_identity(name)

    document = base_document()
    document["parameters"].append(parameter("assembly-offset", 10))
    document["components"] = [
        {
            **component_identity("base"),
            "name": "fixed base",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [0, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        },
        {
            **component_identity("offset"),
            "name": "offset instance",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [0, 0, 10],
                "rotationDegrees": [0, 0, 90],
            },
            "suppressed": False,
        },
    ]
    document["assemblyConstraints"] = [
        {
            **ref("assembly-fixed"),
            "name": "fix base",
            "constraintKind": "fixed",
            "componentRefs": [component_ref("base")],
            "status": "satisfied",
        },
        {
            **ref("assembly-distance"),
            "name": "separate instances",
            "constraintKind": "distance",
            "componentRefs": [component_ref("base"), component_ref("offset")],
            "parameterRef": ref("assembly-offset"),
            "status": "satisfied",
        },
        {
            **ref("assembly-concentric"),
            "name": "share local z axis",
            "constraintKind": "concentric",
            "componentRefs": [component_ref("base"), component_ref("offset")],
            "status": "satisfied",
        },
    ]

    response = build_to_artifacts("assembly-compound", document, ["step", "glb"], tmp_path, False)

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 2
    assert response.metrics.volume_mm3 == pytest.approx(2_000, rel=1e-6)
    assert response.metrics.bounding_box_mm == pytest.approx((20, 20, 15), rel=1e-6)
    assert "ASSEMBLY_NO_INTERFERENCE" in {item.code for item in response.diagnostics}
    assert (tmp_path / "assembly-compound" / "model.step").stat().st_size > 0
    assert (tmp_path / "assembly-compound" / "model.glb").read_bytes()[:4] == b"glTF"


def test_distance_mate_solves_component_frame_before_geometry_and_checks(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["parameters"].append(parameter("assembly-offset", 10))
    document["components"] = [
        {
            "id": "component-base-id",
            "semanticRef": "component.base",
            "name": "fixed base",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [0, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        },
        {
            "id": "component-moving-id",
            "semanticRef": "component.moving",
            "name": "moving instance",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [3, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        },
    ]
    document["assemblyConstraints"] = [
        {
            **ref("assembly-fixed"),
            "name": "fix base",
            "constraintKind": "fixed",
            "componentRefs": [{"id": "component-base-id", "semanticRef": "component.base"}],
            "status": "satisfied",
        },
        {
            **ref("assembly-distance"),
            "name": "solve offset",
            "constraintKind": "distance",
            "componentRefs": [
                {"id": "component-base-id", "semanticRef": "component.base"},
                {
                    "id": "component-moving-id",
                    "semanticRef": "component.moving",
                },
            ],
            "parameterRef": ref("assembly-offset"),
            "status": "unsolved",
        },
    ]

    response = build(document, tmp_path)
    codes = {item.code for item in response.diagnostics}

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.bounding_box_mm == pytest.approx((30, 10, 5), rel=1e-6)
    assert "ASSEMBLY_DATUM_MATE_SOLVED" in codes
    assert "ASSEMBLY_DISTANCE_SATISFIED" in codes
    assert "ASSEMBLY_DISTANCE_MISMATCH" not in codes


def test_exact_component_interference_is_reported_without_invalidating_solid(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["components"] = [
        {
            "id": "component-base-id",
            "semanticRef": "component.base",
            "name": "base",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [0, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        },
        {
            "id": "component-overlap-id",
            "semanticRef": "component.overlap",
            "name": "overlap",
            "featureRefs": [ref("base")],
            "transform": {
                "translationMm": [0, 0, 4],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        },
    ]

    response = build(document, tmp_path)
    interference = next(
        item for item in response.diagnostics if item.code == "ASSEMBLY_INTERFERENCE_DETECTED"
    )

    assert response.valid is True
    assert interference.severity == "warning"
    assert "200 mm^3" in interference.message


def test_unsuppressed_component_without_feature_refs_fails_closed(
    tmp_path: Path,
) -> None:
    document = base_document()
    document["components"] = [
        {
            "id": "empty-component-id",
            "semanticRef": "component.empty",
            "name": "empty component",
            "featureRefs": [],
            "transform": {
                "translationMm": [0, 0, 0],
                "rotationDegrees": [0, 0, 0],
            },
            "suppressed": False,
        }
    ]

    with pytest.raises(ValueError, match="at least one featureRef"):
        build(document, tmp_path)
