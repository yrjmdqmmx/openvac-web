from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal

from .models import (
    ArtifactDescriptor,
    BuildMetrics,
    BuildResponse,
    Diagnostic,
    PROTOCOL_VERSION,
    StepImportResponse,
)
from .pump import parameters_from_document, validate_rotary_vane_pump
from .pump_geometry import build_pump_brep_geometry
from .sketch_solver import solve_sketch_payload


@dataclass
class BuiltModel:
    shape: Any
    assembly: Any
    diagnostics: list[Diagnostic]


def _cadquery():
    try:
        # Import VTK before CadQuery. On macOS/arm64 the OCP IVtk bindings can
        # otherwise enter a loader cycle while importing vtk for the first time.
        import vtk  # noqa: F401
        import cadquery as cq
    except ImportError as exc:  # pragma: no cover - exercised by readiness in real runtime
        raise RuntimeError("CadQuery/OCP is not installed in the modeling service") from exc
    return cq


def preload_cad_kernel() -> None:
    """Load VTK, CadQuery and OCCT once inside the isolated kernel process."""

    _cadquery()


def _kernel_version(cq: Any) -> str:
    """Report both the DSL facade and the OCCT binding used for B-Rep work."""

    try:
        ocp_version = importlib.metadata.version("cadquery-ocp")
    except importlib.metadata.PackageNotFoundError:
        ocp_version = "unknown"
    return f"cadquery-{getattr(cq, '__version__', 'unknown')}/ocp-{ocp_version}"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def model_hash(document: dict[str, Any]) -> str:
    payload = f"{PROTOCOL_VERSION}\n{canonical_json(document)}".encode()
    return hashlib.sha256(payload).hexdigest()


def build_model(
    document: dict[str, Any],
    validate_pump: bool = False,
    imported_sources: dict[str, str] | None = None,
) -> BuiltModel:
    template = document.get("templateKind") or document.get("template_kind")
    metadata = document.get("metadata")
    if isinstance(metadata, dict):
        template = template or metadata.get("templateKind") or metadata.get("template")
    if isinstance(template, dict):
        template = template.get("templateId") or template.get("template_id")
    if not isinstance(template, str):
        template = None
    is_rotary_vane_template = template in {
        "rotary_vane_pump",
        "rotary-vane-pump",
        "openvac-rv1",
        "template.rotary-vane-pump.single-stage-double-vane",
    }
    if is_rotary_vane_template:
        return build_rotary_vane_pump(document, validate_pump=validate_pump)
    return build_feature_document(document, imported_sources=imported_sources)


def build_rotary_vane_pump(document: dict[str, Any], validate_pump: bool = True) -> BuiltModel:
    _validate_rotary_vane_template_contract(document)
    authoritative_sketch_diagnostics = _authoritative_protocol_sketch_diagnostics(
        document, _protocol_parameter_values(document)
    )
    _fail_on_sketch_errors(authoritative_sketch_diagnostics)
    params = parameters_from_document(document)
    validation = validate_rotary_vane_pump(params) if validate_pump else None
    diagnostics = [
        *authoritative_sketch_diagnostics,
        *(list(validation.diagnostics) if validation is not None else []),
    ]
    if validation is not None and not validation.valid:
        raise ValueError(
            "; ".join(item.message for item in diagnostics if item.severity == "error")
        )
    cq = _cadquery()
    geometry = build_pump_brep_geometry(params)
    housing = geometry.housing
    rotor = geometry.rotor
    shaft = geometry.shaft
    front_cover = geometry.front_cover
    rear_cover = geometry.rear_cover
    vane_solids = list(geometry.vanes)

    assembly = cq.Assembly(name="OpenVac-RV1")
    assembly.add(housing, name="pump-housing", color=cq.Color(0.64, 0.67, 0.68))
    assembly.add(rotor, name="eccentric-rotor", color=cq.Color(0.36, 0.39, 0.40))
    assembly.add(shaft, name="shaft", color=cq.Color(0.72, 0.74, 0.75))
    assembly.add(front_cover, name="front-cover", color=cq.Color(0.56, 0.59, 0.60, 0.5))
    assembly.add(rear_cover, name="rear-cover", color=cq.Color(0.56, 0.59, 0.60, 0.5))
    for index, vane in enumerate(vane_solids, start=1):
        assembly.add(vane, name=f"vane-{index}", color=cq.Color(0.06, 0.49, 0.46))

    component_frames, assembly_solve_diagnostics = _solve_document_assembly_constraints(
        document, _protocol_parameter_values(document)
    )
    diagnostics.extend(assembly_solve_diagnostics)
    diagnostics.extend(
        _validate_document_assembly_constraints(
            document,
            _protocol_parameter_values(document),
            component_frames=component_frames,
        )
    )

    shapes = [housing, rotor, shaft, front_cover, rear_cover, *vane_solids]
    compound = cq.Compound.makeCompound([shape.val() for shape in shapes])
    return BuiltModel(compound, assembly, diagnostics)


def _validate_rotary_vane_template_contract(document: dict[str, Any]) -> None:
    """Reject edits that the specialized V1 pump generator would ignore.

    The current pump template is a deterministic domain recipe, not a generic
    replay of arbitrary feature nodes. Production documents identify that
    recipe through structured metadata. Its public tree therefore has a strict
    contract: parameter edits are supported, while deleting, suppressing,
    reordering, or structurally rewriting recipe nodes fails closed instead of
    returning unchanged geometry under a misleading new revision.

    Legacy low-level benchmark payloads use ``templateKind`` without structured
    metadata and intentionally remain outside this protocol contract.
    """

    if document.get("version") != PROTOCOL_VERSION:
        return
    metadata = document.get("metadata")
    template = metadata.get("template") if isinstance(metadata, dict) else None
    if not isinstance(template, dict) or template.get("templateId") != (
        "template.rotary-vane-pump.single-stage-double-vane"
    ):
        return

    def fail(message: str) -> None:
        raise ValueError(f"rotary-vane template contract violation: {message}")

    def semantic(reference: Any) -> str:
        if not isinstance(reference, dict):
            fail("every structural reference must contain a semanticRef")
        value = reference.get("semanticRef")
        if not isinstance(value, str) or not value:
            fail("every structural reference must contain a semanticRef")
        return value

    def require_vector(actual: Any, expected: tuple[float, float, float], label: str) -> None:
        if (
            not isinstance(actual, list)
            or len(actual) != 3
            or any(
                not isinstance(value, (int, float)) or isinstance(value, bool) for value in actual
            )
            or any(
                not math.isclose(float(value), target, abs_tol=1e-9)
                for value, target in zip(actual, expected)
            )
        ):
            fail(f"{label} must equal {list(expected)}")

    expected_parameters = [
        "pump.parameter.chamber-diameter",
        "pump.parameter.rotor-diameter",
        "pump.parameter.eccentricity",
        "pump.parameter.axial-width",
        "pump.parameter.vane-count",
        "pump.parameter.vane-thickness",
        "pump.parameter.vane-height",
        "pump.parameter.shaft-diameter",
        "pump.parameter.inlet-width",
        "pump.parameter.outlet-width",
        "pump.parameter.cover-outer-diameter",
        "pump.parameter.cover-thickness",
        "pump.parameter.cover-bore-diameter",
    ]
    parameters = document.get("parameters")
    if (
        not isinstance(parameters, list)
        or [semantic(item) for item in parameters] != expected_parameters
    ):
        fail("parameter set/order must match template version 1.0.0")
    parameter_values = _protocol_parameter_values(document)
    eccentricity = parameter_values.get("pump.parameter.eccentricity")
    if eccentricity is None:
        fail("eccentricity parameter is missing")
    chamber_diameter = parameter_values.get("pump.parameter.chamber-diameter")
    shaft_diameter = parameter_values.get("pump.parameter.shaft-diameter")
    axial_width = parameter_values.get("pump.parameter.axial-width")
    if chamber_diameter is None or shaft_diameter is None or axial_width is None:
        fail("cover derivation inputs are missing")
    wall = max(6.0, chamber_diameter * 0.09)
    expected_cover_values = {
        "pump.parameter.cover-outer-diameter": chamber_diameter + wall * 2,
        "pump.parameter.cover-thickness": max(5.0, wall * 0.75),
        "pump.parameter.cover-bore-diameter": shaft_diameter + 2.0,
    }
    by_parameter = {
        str(item.get("semanticRef")): item for item in parameters if isinstance(item, dict)
    }
    for parameter_ref, expected_value in expected_cover_values.items():
        parameter = by_parameter[parameter_ref]
        if (
            parameter.get("source") != "derived"
            or parameter.get("editable") is not False
            or not math.isclose(
                float(parameter.get("value", float("nan"))),
                expected_value,
                abs_tol=1e-9,
            )
        ):
            fail(f"{parameter_ref} must remain a non-editable derived value")

    expected_entities: list[tuple[str, str, bool]] = [
        ("pump.sketch.cross-section.chamber-center", "point", True),
        ("pump.sketch.cross-section.rotor-center", "point", True),
        ("pump.sketch.cross-section.chamber-circle", "circle", False),
        ("pump.sketch.cross-section.rotor-circle", "circle", False),
        ("pump.sketch.cross-section.shaft-circle", "circle", False),
        ("pump.sketch.cross-section.vane-profile", "rectangle", False),
    ]
    sketches = document.get("sketches")
    if (
        not isinstance(sketches, list)
        or len(sketches) != 3
        or not isinstance(sketches[0], dict)
        or sketches[0].get("semanticRef") != "pump.sketch.cross-section"
        or sketches[0].get("suppressed") is True
    ):
        fail("pump cross-section and two active cover sketches are required")
    entities = sketches[0].get("entities")
    if (
        not isinstance(entities, list)
        or [
            (
                str(item.get("semanticRef")) if isinstance(item, dict) else "",
                str(item.get("entityKind")) if isinstance(item, dict) else "",
                bool(item.get("construction")) if isinstance(item, dict) else False,
            )
            for item in entities
        ]
        != expected_entities
    ):
        fail("pump sketch entity set/order/kinds must match template version 1.0.0")

    expected_constraints = [
        ("pump.constraint.chamber-center-fixed", "fixed"),
        ("pump.constraint.centers-horizontal", "horizontal"),
        ("pump.constraint.rotor-eccentricity", "distance"),
        ("pump.constraint.chamber-diameter", "diameter"),
        ("pump.constraint.rotor-diameter", "diameter"),
        ("pump.constraint.shaft-diameter", "diameter"),
        ("pump.constraint.vane-profile-fixed", "fixed"),
    ]
    constraints = sketches[0].get("constraints")
    if (
        not isinstance(constraints, list)
        or [
            (
                str(item.get("semanticRef")) if isinstance(item, dict) else "",
                str(item.get("constraintKind")) if isinstance(item, dict) else "",
            )
            for item in constraints
        ]
        != expected_constraints
        or any(
            not isinstance(item, dict) or item.get("status") == "suppressed" for item in constraints
        )
    ):
        fail("pump sketch constraints must remain active and in template order")

    for position, side in ((1, "front"), (2, "rear")):
        sketch = sketches[position]
        sketch_ref = f"pump.sketch.{side}-cover-profile"
        if (
            not isinstance(sketch, dict)
            or sketch.get("semanticRef") != sketch_ref
            or sketch.get("plane") != "xy"
            or sketch.get("suppressed") is True
        ):
            fail(f"{side} cover sketch structure was modified")
        cover_entities = sketch.get("entities")
        expected_cover_entities = [
            (f"{sketch_ref}.outer-center", "point", True),
            (f"{sketch_ref}.bore-center", "point", True),
            (f"{sketch_ref}.outer-circle", "circle", False),
            (f"{sketch_ref}.shaft-clearance-circle", "circle", False),
        ]
        if (
            not isinstance(cover_entities, list)
            or [
                (
                    str(item.get("semanticRef")) if isinstance(item, dict) else "",
                    str(item.get("entityKind")) if isinstance(item, dict) else "",
                    bool(item.get("construction")) if isinstance(item, dict) else False,
                )
                for item in cover_entities
            ]
            != expected_cover_entities
        ):
            fail(f"{side} cover sketch entities were modified")
        outer_center, bore_center, outer_circle, bore_circle = cover_entities
        if (
            not math.isclose(float(outer_center.get("x", float("nan"))), 0.0, abs_tol=1e-9)
            or not math.isclose(float(outer_center.get("y", float("nan"))), 0.0, abs_tol=1e-9)
            or not math.isclose(
                float(bore_center.get("x", float("nan"))), eccentricity, abs_tol=1e-9
            )
            or not math.isclose(float(bore_center.get("y", float("nan"))), 0.0, abs_tol=1e-9)
            or semantic(outer_circle.get("centerPointRef")) != f"{sketch_ref}.outer-center"
            or semantic(outer_circle.get("diameterParameterRef"))
            != "pump.parameter.cover-outer-diameter"
            or semantic(bore_circle.get("centerPointRef")) != f"{sketch_ref}.bore-center"
            or semantic(bore_circle.get("diameterParameterRef"))
            != "pump.parameter.cover-bore-diameter"
        ):
            fail(f"{side} cover eccentric annulus definition was modified")
        expected_cover_constraints = [
            (f"pump.constraint.{side}-cover-outer-center-fixed", "fixed"),
            (f"pump.constraint.{side}-cover-centers-horizontal", "horizontal"),
            (f"pump.constraint.{side}-cover-bore-eccentricity", "distance"),
            (f"pump.constraint.{side}-cover-outer-diameter", "diameter"),
            (f"pump.constraint.{side}-cover-bore-diameter", "diameter"),
        ]
        cover_constraints = sketch.get("constraints")
        if (
            not isinstance(cover_constraints, list)
            or [
                (
                    str(item.get("semanticRef")) if isinstance(item, dict) else "",
                    str(item.get("constraintKind")) if isinstance(item, dict) else "",
                )
                for item in cover_constraints
            ]
            != expected_cover_constraints
            or any(
                not isinstance(item, dict) or item.get("status") == "suppressed"
                for item in cover_constraints
            )
            or semantic(cover_constraints[2].get("parameterRef")) != "pump.parameter.eccentricity"
            or semantic(cover_constraints[3].get("parameterRef"))
            != "pump.parameter.cover-outer-diameter"
            or semantic(cover_constraints[4].get("parameterRef"))
            != "pump.parameter.cover-bore-diameter"
        ):
            fail(f"{side} cover constraints were modified")

    expected_features: list[tuple[str, str]] = [
        ("pump.feature.chamber-volume", "extrude"),
        ("pump.feature.rotor", "extrude"),
        ("pump.feature.shaft", "extrude"),
        ("pump.feature.vane", "extrude"),
        ("pump.feature.vane-pattern", "circular_pattern"),
        ("pump.feature.inlet-port", "port"),
        ("pump.feature.outlet-port", "port"),
        ("pump.feature.front-cover", "extrude"),
        ("pump.feature.rear-cover", "extrude"),
    ]
    features = document.get("features")
    if (
        not isinstance(features, list)
        or [
            (
                str(item.get("semanticRef")) if isinstance(item, dict) else "",
                str(item.get("featureKind")) if isinstance(item, dict) else "",
            )
            for item in features
        ]
        != expected_features
        or any(not isinstance(item, dict) or item.get("suppressed") is True for item in features)
    ):
        fail("feature tree must remain active and in template order")

    by_feature = {str(item["semanticRef"]): item for item in features if isinstance(item, dict)}
    profile_contract = [
        (
            "pump.feature.chamber-volume",
            "pump.sketch.cross-section.chamber-circle",
            "pump.parameter.axial-width",
        ),
        (
            "pump.feature.rotor",
            "pump.sketch.cross-section.rotor-circle",
            "pump.parameter.axial-width",
        ),
        (
            "pump.feature.shaft",
            "pump.sketch.cross-section.shaft-circle",
            "pump.parameter.axial-width",
        ),
        (
            "pump.feature.vane",
            "pump.sketch.cross-section.vane-profile",
            "pump.parameter.axial-width",
        ),
    ]
    for feature_ref, profile_ref, distance_ref in profile_contract:
        feature = by_feature[feature_ref]
        profile_refs = feature.get("profileRefs")
        if (
            not isinstance(profile_refs, list)
            or len(profile_refs) != 1
            or semantic(profile_refs[0]) != profile_ref
            or semantic(feature.get("distanceParameterRef")) != distance_ref
            or feature.get("direction") != "symmetric"
            or feature.get("operation") != "new_body"
        ):
            fail(f"{feature_ref} structural fields were modified")

    pattern = by_feature["pump.feature.vane-pattern"]
    if (
        semantic(pattern.get("sourceFeatureRef")) != "pump.feature.vane"
        or semantic(pattern.get("countParameterRef")) != "pump.parameter.vane-count"
        or not math.isclose(float(pattern.get("totalAngleDegrees", 0)), 360.0, abs_tol=1e-9)
    ):
        fail("vane pattern structural fields were modified")
    require_vector(pattern.get("axisOrigin"), (eccentricity, 0.0, 0.0), "vane pattern axisOrigin")
    require_vector(pattern.get("axisDirection"), (0.0, 0.0, 1.0), "vane pattern axisDirection")

    for feature_ref, role, width_ref, angle in (
        (
            "pump.feature.inlet-port",
            "inlet",
            "pump.parameter.inlet-width",
            225.0,
        ),
        (
            "pump.feature.outlet-port",
            "outlet",
            "pump.parameter.outlet-width",
            45.0,
        ),
    ):
        feature = by_feature[feature_ref]
        if (
            feature.get("role") != role
            or semantic(feature.get("chamberProfileRef"))
            != "pump.sketch.cross-section.chamber-circle"
            or semantic(feature.get("widthParameterRef")) != width_ref
            or semantic(feature.get("axialWidthParameterRef")) != "pump.parameter.axial-width"
            or not math.isclose(float(feature.get("centerAngleDegrees", 0)), angle, abs_tol=1e-9)
            or feature.get("operation") != "cut"
        ):
            fail(f"{feature_ref} structural fields were modified")

    for side, direction in (("front", "reverse"), ("rear", "normal")):
        feature_ref = f"pump.feature.{side}-cover"
        sketch_ref = f"pump.sketch.{side}-cover-profile"
        feature = by_feature[feature_ref]
        if (
            [semantic(item) for item in feature.get("profileRefs", [])]
            != [
                f"{sketch_ref}.outer-circle",
                f"{sketch_ref}.shaft-clearance-circle",
            ]
            or semantic(feature.get("distanceParameterRef")) != "pump.parameter.cover-thickness"
            or feature.get("direction") != direction
            or feature.get("operation") != "new_body"
        ):
            fail(f"{feature_ref} structural fields were modified")

    expected_components = [
        (
            "pump.component.chamber-and-ports",
            [
                "pump.feature.chamber-volume",
                "pump.feature.inlet-port",
                "pump.feature.outlet-port",
            ],
            (0.0, 0.0, 0.0),
        ),
        (
            "pump.component.rotating-group",
            [
                "pump.feature.rotor",
                "pump.feature.shaft",
                "pump.feature.vane-pattern",
            ],
            (eccentricity, 0.0, 0.0),
        ),
        (
            "pump.component.front-cover",
            ["pump.feature.front-cover"],
            (0.0, 0.0, 0.0),
        ),
        (
            "pump.component.rear-cover",
            ["pump.feature.rear-cover"],
            (0.0, 0.0, axial_width),
        ),
    ]
    components = document.get("components")
    if not isinstance(components, list) or len(components) != len(expected_components):
        fail("component set must match template version 1.0.0")
    for component, (component_ref, feature_refs, translation) in zip(
        components, expected_components
    ):
        if (
            not isinstance(component, dict)
            or component.get("semanticRef") != component_ref
            or component.get("suppressed") is True
            or [semantic(item) for item in component.get("featureRefs", [])] != feature_refs
        ):
            fail(f"component {component_ref} structure was modified")
        transform = component.get("transform")
        if not isinstance(transform, dict):
            fail(f"component {component_ref} transform is missing")
        require_vector(transform.get("translationMm"), translation, f"{component_ref} translation")
        require_vector(
            transform.get("rotationDegrees"),
            (0.0, 0.0, 0.0),
            f"{component_ref} rotation",
        )

    expected_assembly = [
        (
            "pump.assembly.chamber-fixed",
            "fixed",
            ["pump.component.chamber-and-ports"],
            None,
        ),
        (
            "pump.assembly.rotor-eccentric-offset",
            "distance",
            [
                "pump.component.chamber-and-ports",
                "pump.component.rotating-group",
            ],
            "pump.parameter.eccentricity",
        ),
        (
            "pump.assembly.front-cover-to-chamber",
            "coincident",
            [
                "pump.component.chamber-and-ports",
                "pump.component.front-cover",
            ],
            None,
        ),
        (
            "pump.assembly.rear-cover-axial-offset",
            "distance",
            [
                "pump.component.chamber-and-ports",
                "pump.component.rear-cover",
            ],
            "pump.parameter.axial-width",
        ),
    ]
    assembly_constraints = document.get("assemblyConstraints")
    if not isinstance(assembly_constraints, list) or len(assembly_constraints) != len(
        expected_assembly
    ):
        fail("assembly constraint set must match template version 1.0.0")
    for constraint, (constraint_ref, kind, component_refs, parameter_ref) in zip(
        assembly_constraints, expected_assembly
    ):
        actual_parameter_ref = (
            constraint.get("parameterRef") if isinstance(constraint, dict) else None
        )
        if (
            not isinstance(constraint, dict)
            or constraint.get("semanticRef") != constraint_ref
            or constraint.get("constraintKind") != kind
            or [semantic(item) for item in constraint.get("componentRefs", [])] != component_refs
            or (semantic(actual_parameter_ref) if actual_parameter_ref is not None else None)
            != parameter_ref
        ):
            fail(f"assembly constraint {constraint_ref} was modified")


def build_feature_document(
    document: dict[str, Any], imported_sources: dict[str, str] | None = None
) -> BuiltModel:
    if document.get("unitSystem") == "mm-deg" and isinstance(document.get("parameters"), list):
        return build_protocol_document(document, imported_sources=imported_sources)
    cq = _cadquery()
    features = document.get("features", [])
    if not isinstance(features, list) or not features:
        raise ValueError("document must contain at least one supported feature")
    shapes: dict[str, Any] = {}
    current: Any | None = None
    diagnostics: list[Diagnostic] = []

    for feature in features:
        if not isinstance(feature, dict):
            raise ValueError("feature must be an object")
        feature_id = str(feature.get("id", ""))
        if not feature_id:
            raise ValueError("feature.id is required")
        if feature.get("suppressed") is True:
            continue
        kind = str(feature.get("kind") or feature.get("type") or "")
        params = feature.get("parameters") or feature.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError(f"feature {feature_id} parameters must be an object")

        if kind == "box":
            shape = cq.Workplane("XY").box(
                _number(params, "width"),
                _number(params, "depth"),
                _number(params, "height"),
                centered=bool(params.get("centered", True)),
            )
            current = _combine(current, shape, str(params.get("operation", "new")))
        elif kind == "cylinder":
            shape = (
                cq.Workplane("XY")
                .circle(_number(params, "diameter") / 2)
                .extrude(_number(params, "height"))
            )
            current = _combine(current, shape, str(params.get("operation", "new")))
        elif kind in {"extrude", "pocket"}:
            profile = params.get("profile")
            if not isinstance(profile, dict):
                raise ValueError(f"feature {feature_id} requires a profile")
            workplane = _profile_workplane(cq, profile)
            distance = _number(params, "distance")
            shape = workplane.extrude(distance)
            operation = "cut" if kind == "pocket" else str(params.get("operation", "new"))
            current = _combine(current, shape, operation)
        elif kind in {"revolve", "groove"}:
            points = params.get("points")
            if not isinstance(points, list) or len(points) < 3:
                raise ValueError(f"feature {feature_id} requires at least three profile points")
            profile = cq.Workplane("XZ").polyline([tuple(point) for point in points]).close()
            shape = profile.revolve(float(params.get("angleDegrees", 360)))
            current = _combine(
                current, shape, "cut" if kind == "groove" else str(params.get("operation", "new"))
            )
        elif kind == "hole":
            if current is None:
                raise ValueError("hole requires an existing body")
            points = params.get("points", [[0, 0]])
            current = (
                cq.Workplane(obj=current.val() if hasattr(current, "val") else current)
                .faces(_face_selector(str(params.get("face", "top"))))
                .workplane()
                .pushPoints([tuple(point) for point in points])
                .hole(_number(params, "diameter"), float(params.get("depth", 0)) or None)
            )
        elif kind in {"fillet", "chamfer"}:
            if current is None:
                raise ValueError(f"{kind} requires an existing body")
            edge_selector = _edge_selector(str(params.get("edges", "all")))
            selected = current.edges(edge_selector) if edge_selector else current.edges()
            current = (
                selected.fillet(_number(params, "radius"))
                if kind == "fillet"
                else selected.chamfer(_number(params, "distance"))
            )
        elif kind == "mirror":
            if current is None:
                raise ValueError("mirror requires an existing body")
            mirrored = current.mirror(str(params.get("plane", "YZ")))
            current = current.union(mirrored) if bool(params.get("merge", True)) else mirrored
        elif kind == "linearPattern":
            if current is None:
                raise ValueError("linearPattern requires an existing body")
            count = _positive_int(params, "count", maximum=100)
            spacing = _number(params, "spacing")
            axis = str(params.get("axis", "x")).lower()
            base = current
            for index in range(1, count):
                delta = {
                    "x": (spacing * index, 0, 0),
                    "y": (0, spacing * index, 0),
                    "z": (0, 0, spacing * index),
                }.get(axis)
                if delta is None:
                    raise ValueError("linearPattern axis must be x, y or z")
                current = current.union(base.translate(delta))
        elif kind == "circularPattern":
            if current is None:
                raise ValueError("circularPattern requires an existing body")
            count = _positive_int(params, "count", maximum=100)
            base = current
            for index in range(1, count):
                current = current.union(base.rotate((0, 0, 0), (0, 0, 1), index * 360.0 / count))
        elif kind == "boolean":
            left = shapes.get(str(params.get("left")))
            right = shapes.get(str(params.get("right")))
            if left is None or right is None:
                raise ValueError("boolean requires existing semantic left and right feature ids")
            current = _combine(left, right, str(params.get("operation", "union")))
        else:
            raise ValueError(f"unsupported feature kind: {kind}")

        position = params.get("position")
        if isinstance(position, list) and len(position) == 3:
            current = current.translate(tuple(float(value) for value in position))
        shapes[feature_id] = current

    if current is None:
        raise ValueError("all features are suppressed")
    shape = current.val() if hasattr(current, "val") else current
    assembly = cq.Assembly(name=str(document.get("name", "OpenVac model")))
    assembly.add(shape, name="body", color=cq.Color(0.64, 0.67, 0.68))
    return BuiltModel(shape, assembly, diagnostics)


def build_protocol_document(
    document: dict[str, Any], imported_sources: dict[str, str] | None = None
) -> BuiltModel:
    """Build the strict TypeScript openvac.modeling.v1 document shape.

    Semantic references are resolved from stable ids/paths. No topology array
    index supplied by a client is accepted.
    """

    _validate_protocol_parameter_contract(document)
    parameter_values = _protocol_parameter_values(document)
    diagnostics, solved_geometry = _solve_protocol_sketches(document, parameter_values)
    _fail_on_sketch_errors(diagnostics)
    cq = _cadquery()

    entity_by_key: dict[str, dict[str, Any]] = {}
    sketch_by_entity: dict[str, dict[str, Any]] = {}
    for sketch in document.get("sketches", []):
        if not isinstance(sketch, dict) or sketch.get("suppressed") is True:
            continue
        for entity in sketch.get("entities", []):
            if not isinstance(entity, dict):
                continue
            for key in (str(entity.get("id")), str(entity.get("semanticRef"))):
                entity_by_key[key] = entity
                sketch_by_entity[key] = sketch

    feature_shapes: dict[str, Any] = {}
    feature_canonical_by_key: dict[str, str] = {}
    feature_profile_lineage: dict[str, set[str]] = {}
    feature_order: list[str] = []
    terminal_features: set[str] = set()
    last_shape: Any | None = None
    last_feature: str | None = None

    def canonical_for_ref(reference: Any) -> str:
        key = _ref_key(reference)
        try:
            return feature_canonical_by_key[key]
        except KeyError as exc:
            raise ValueError(f"unknown semantic feature reference: {key}") from exc

    def remember(
        feature: dict[str, Any],
        shape: Any,
        dependencies: Iterable[str] = (),
        profile_references: Iterable[Any] = (),
    ) -> str:
        identifier = feature.get("id")
        semantic_ref = feature.get("semanticRef")
        if not isinstance(identifier, str) or not identifier:
            raise ValueError("protocol feature id is required")
        if not isinstance(semantic_ref, str) or not semantic_ref:
            raise ValueError(f"feature {identifier} semanticRef is required")
        canonical = semantic_ref
        if canonical in feature_order:
            raise ValueError(f"duplicate protocol feature semanticRef: {canonical}")
        for key in (identifier, semantic_ref):
            existing = feature_canonical_by_key.get(key)
            if existing is not None and existing != canonical:
                raise ValueError(f"duplicate protocol feature reference: {key}")
            feature_shapes[key] = shape
            feature_canonical_by_key[key] = canonical
        for dependency in dependencies:
            terminal_features.discard(dependency)
        profile_lineage: set[str] = set()
        for dependency in dependencies:
            profile_lineage.update(feature_profile_lineage.get(dependency, set()))
        for reference in profile_references:
            entity = _entity_for_ref(reference, entity_by_key)
            entity_semantic_ref = entity.get("semanticRef")
            if not isinstance(entity_semantic_ref, str) or not entity_semantic_ref:
                raise ValueError("solid profile entities require a semanticRef")
            profile_lineage.add(entity_semantic_ref)
        feature_profile_lineage[canonical] = profile_lineage
        terminal_features.add(canonical)
        feature_order.append(canonical)
        return canonical

    for feature in document.get("features", []):
        if not isinstance(feature, dict) or feature.get("suppressed") is True:
            continue
        kind = str(feature.get("featureKind", ""))
        if kind == "extrude":
            refs = feature.get("profileRefs", [])
            profile = _protocol_profile(
                cq,
                refs,
                entity_by_key,
                sketch_by_entity,
                parameter_values,
                solved_geometry,
            )
            distance = _parameter_value(feature.get("distanceParameterRef"), parameter_values)
            direction = str(feature.get("direction", "normal"))
            if direction == "symmetric":
                shape = profile.extrude(distance / 2, both=True)
            else:
                shape = profile.extrude(-distance if direction == "reverse" else distance)
            operation = {
                "new_body": "new",
                "add": "join",
                "cut": "cut",
                "intersect": "intersect",
            }[str(feature.get("operation", "new_body"))]
            dependencies = (
                set()
                if operation == "new"
                else ({last_feature} if last_feature is not None else set())
            )
            last_shape = _combine(last_shape, shape, operation)
            last_feature = remember(feature, last_shape, dependencies, profile_references=refs)
        elif kind == "revolve":
            refs = feature.get("profileRefs", [])
            profile = _protocol_profile(
                cq,
                refs,
                entity_by_key,
                sketch_by_entity,
                parameter_values,
                solved_geometry,
            )
            angle = _parameter_value(feature.get("angleParameterRef"), parameter_values)
            axis = _entity_for_ref(feature.get("axisRef"), entity_by_key)
            if axis.get("entityKind") != "line":
                raise ValueError("revolve axisRef must reference a semantic sketch line")
            start = _point_for_ref(axis.get("startPointRef"), entity_by_key, solved_geometry)
            end = _point_for_ref(axis.get("endPointRef"), entity_by_key, solved_geometry)
            shape = profile.revolve(angle, (start[0], start[1]), (end[0], end[1]))
            operation = {
                "new_body": "new",
                "add": "join",
                "cut": "cut",
                "intersect": "intersect",
            }[str(feature.get("operation", "new_body"))]
            dependencies = (
                set()
                if operation == "new"
                else ({last_feature} if last_feature is not None else set())
            )
            last_shape = _combine(last_shape, shape, operation)
            last_feature = remember(feature, last_shape, dependencies, profile_references=refs)
        elif kind == "boolean":
            target_ref = feature.get("targetFeatureRef")
            target = _shape_for_ref(target_ref, feature_shapes)
            dependencies = {canonical_for_ref(target_ref)}
            result = target
            for tool_ref in feature.get("toolFeatureRefs", []):
                dependencies.add(canonical_for_ref(tool_ref))
                result = _combine(
                    result,
                    _shape_for_ref(tool_ref, feature_shapes),
                    str(feature.get("operation", "union")),
                )
            last_shape = result
            last_feature = remember(feature, result, dependencies)
        elif kind == "circular_pattern":
            source_ref = feature.get("sourceFeatureRef")
            source = _shape_for_ref(source_ref, feature_shapes)
            count = int(_parameter_value(feature.get("countParameterRef"), parameter_values))
            if count < 1 or count > 100:
                raise ValueError("circular pattern count must be between 1 and 100")
            origin = tuple(float(value) for value in feature.get("axisOrigin", [0, 0, 0]))
            direction = tuple(float(value) for value in feature.get("axisDirection", [0, 0, 1]))
            total = float(feature.get("totalAngleDegrees", 360))
            result = source
            step = total / count
            for index in range(1, count):
                result = result.union(source.rotate(origin, direction, index * step))
            last_shape = result
            last_feature = remember(feature, result, {canonical_for_ref(source_ref)})
        elif kind == "port":
            if last_shape is None or last_feature is None:
                raise ValueError("port feature requires an existing chamber body")
            role = feature.get("role")
            if role not in {"inlet", "outlet"}:
                raise ValueError("port role must be inlet or outlet")
            if feature.get("operation") != "cut":
                raise ValueError("V1 port operation must be cut")
            chamber_reference = feature.get("chamberProfileRef")
            chamber_profile = _entity_for_ref(chamber_reference, entity_by_key)
            chamber_key = _ref_key(chamber_reference)
            chamber_sketch = sketch_by_entity.get(chamber_key)
            if chamber_sketch is None:
                raise ValueError(
                    "port chamberProfileRef must belong to an active sketch in this document"
                )
            if str(chamber_sketch.get("plane", "xy")).lower() != "xy":
                raise ValueError("V1 port chamberProfileRef must belong to an XY sketch")
            chamber_wire = _protocol_profile(
                cq,
                [chamber_reference],
                entity_by_key,
                sketch_by_entity,
                parameter_values,
                solved_geometry,
            )
            chamber_semantic_ref = chamber_profile.get("semanticRef")
            if not isinstance(
                chamber_semantic_ref, str
            ) or chamber_semantic_ref not in feature_profile_lineage.get(last_feature, set()):
                raise ValueError(
                    "port chamberProfileRef must belong to the current body profile lineage"
                )
            chamber_bounds = chamber_wire.val().BoundingBox()
            chamber_center = (
                (chamber_bounds.xmin + chamber_bounds.xmax) / 2,
                (chamber_bounds.ymin + chamber_bounds.ymax) / 2,
            )
            width = _parameter_value(feature.get("widthParameterRef"), parameter_values)
            axial = _parameter_value(feature.get("axialWidthParameterRef"), parameter_values)
            angle_degrees = float(feature.get("centerAngleDegrees", 0))
            if not math.isfinite(angle_degrees):
                raise ValueError("port centerAngleDegrees must be finite")
            angle = math.radians(angle_degrees)
            bounds = (last_shape.val() if hasattr(last_shape, "val") else last_shape).BoundingBox()
            radial_extent = max(
                abs(bounds.xmin - chamber_center[0]),
                abs(bounds.xmax - chamber_center[0]),
                abs(bounds.ymin - chamber_center[1]),
                abs(bounds.ymax - chamber_center[1]),
            )
            reach = radial_extent * 2 + width
            cutter = (
                cq.Workplane("XY")
                .box(reach, width, axial, centered=True)
                .rotate((0, 0, 0), (0, 0, 1), angle_degrees)
                .translate(
                    (
                        chamber_center[0] + math.cos(angle) * reach / 2,
                        chamber_center[1] + math.sin(angle) * reach / 2,
                        bounds.zmin + axial / 2,
                    )
                )
            )
            last_shape = last_shape.cut(cutter)
            last_feature = remember(feature, last_shape, {last_feature})
            diagnostics.append(
                Diagnostic(
                    code="PORT_PROFILE_SEMANTICS_VALID",
                    severity="info",
                    message=(
                        f"{role} 端口已绑定当前实体谱系中的 XY 草图轮廓，并按显式角度执行 cut。"
                    ),
                    target_id=str(feature.get("semanticRef") or feature.get("id")),
                )
            )
        elif kind == "hole":
            diameter = _parameter_value(feature.get("diameterParameterRef"), parameter_values)
            depth = _optional_parameter_value(feature.get("depthParameterRef"), parameter_values)
            placement = feature.get("placement")
            if not isinstance(placement, dict):
                raise ValueError("hole requires a semantic placement")
            placement_kind = str(placement.get("placementKind", ""))
            source = last_shape
            source_feature = last_feature
            if placement_kind == "semantic_face":
                source_ref = placement.get("sourceFeatureRef")
                source = _shape_for_ref(source_ref, feature_shapes)
                source_feature = canonical_for_ref(source_ref)
                face = _face_selector(str(placement.get("faceSelector", "top")))
                workplane = source.faces(face).workplane()
            elif placement_kind == "point":
                if source is None:
                    raise ValueError("point hole placement requires an existing body")
                point = _point_for_ref(placement.get("pointRef"), entity_by_key, solved_geometry)
                workplane = source.faces(">Z").workplane().pushPoints([point])
            elif placement_kind == "profile":
                if source is None:
                    raise ValueError("profile hole placement requires an existing body")
                cutter_profile = _protocol_profile(
                    cq,
                    [placement.get("profileRef")],
                    entity_by_key,
                    sketch_by_entity,
                    parameter_values,
                    solved_geometry,
                )
                bounds = (source.val() if hasattr(source, "val") else source).BoundingBox()
                cutter_depth = depth or max(bounds.xlen, bounds.ylen, bounds.zlen) * 2
                last_shape = source.cut(cutter_profile.extrude(cutter_depth, both=True))
                if source_feature is None:
                    raise ValueError("profile hole placement requires a source feature")
                last_feature = remember(feature, last_shape, {source_feature})
                continue
            else:
                raise ValueError("unsupported hole placement kind")
            last_shape = workplane.hole(diameter, depth)
            if source_feature is None:
                raise ValueError("hole placement requires a source feature")
            last_feature = remember(feature, last_shape, {source_feature})
        elif kind in {"fillet", "chamfer"}:
            source_refs = feature.get("sourceFeatureRefs", [])
            sources = [_shape_for_ref(reference, feature_shapes) for reference in source_refs]
            source = _union_shapes(sources) if sources else last_shape
            if source is None:
                raise ValueError(f"{kind} requires an existing body")
            dependencies = (
                {canonical_for_ref(reference) for reference in source_refs}
                if sources
                else ({last_feature} if last_feature is not None else set())
            )
            amount_ref = feature.get("radiusParameterRef") or feature.get("distanceParameterRef")
            amount = _parameter_value(amount_ref, parameter_values)
            selector = _edge_selector(str(feature.get("edgeSelector", "all")))
            edges = source.edges(selector) if selector else source.edges()
            last_shape = edges.fillet(amount) if kind == "fillet" else edges.chamfer(amount)
            last_feature = remember(feature, last_shape, dependencies)
        elif kind == "mirror":
            source_refs = feature.get("sourceFeatureRefs", [])
            sources = [_shape_for_ref(reference, feature_shapes) for reference in source_refs]
            source = _union_shapes(sources)
            plane = str(feature.get("mirrorPlane", "YZ")).upper()
            if plane not in {"XY", "XZ", "YZ"}:
                raise ValueError("mirror plane must be XY, XZ or YZ")
            result = source.union(source.mirror(plane))
            last_shape = result
            last_feature = remember(
                feature,
                result,
                {canonical_for_ref(reference) for reference in source_refs},
            )
        elif kind == "linear_pattern":
            source_ref = feature.get("sourceFeatureRef")
            source = _shape_for_ref(source_ref, feature_shapes)
            count = int(_parameter_value(feature.get("countParameterRef"), parameter_values))
            if count < 1 or count > 100:
                raise ValueError("linear pattern count must be between 1 and 100")
            spacing = _parameter_value(feature.get("spacingParameterRef"), parameter_values)
            direction = feature.get("directionVector", [1, 0, 0])
            if not isinstance(direction, list) or len(direction) != 3:
                raise ValueError("linear pattern direction must be a 3-vector")
            result = source
            for index in range(1, count):
                delta = tuple(float(value) * spacing * index for value in direction)
                result = result.union(source.translate(delta))
            last_shape = result
            last_feature = remember(feature, result, {canonical_for_ref(source_ref)})
        elif kind == "imported_step":
            artifact_id = feature.get("artifactId")
            artifact_sha256 = feature.get("artifactSha256")
            if not isinstance(artifact_id, str) or not artifact_id:
                raise ValueError("imported STEP feature artifactId is required")
            if (
                not isinstance(artifact_sha256, str)
                or len(artifact_sha256) != 64
                or any(character not in "0123456789abcdef" for character in artifact_sha256)
            ):
                raise ValueError("imported STEP feature artifactSha256 is invalid")
            source_value = (imported_sources or {}).get(artifact_id)
            if not isinstance(source_value, str) or not source_value:
                raise ValueError("imported STEP source was not supplied by the trusted worker")
            source_path = Path(source_value).resolve()
            if not source_path.is_file():
                raise ValueError("imported STEP source does not exist")
            if source_path.stat().st_size <= 0 or source_path.stat().st_size > 50 * 1024 * 1024:
                raise ValueError("imported STEP source must be between 1 byte and 50 MB")
            digest = hashlib.sha256()
            with source_path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != artifact_sha256:
                raise ValueError("imported STEP source SHA-256 does not match the feature")
            imported = cq.importers.importStep(str(source_path))
            solids = [solid for item in imported.vals() for solid in item.Solids()]
            if not solids or any(
                not solid.isValid() or float(solid.Volume()) <= 1e-9 for solid in solids
            ):
                raise ValueError("imported STEP source has no valid closed solid")
            fingerprinted = sorted(
                ((_solid_fingerprint(solid), solid) for solid in solids),
                key=lambda item: item[0],
            )
            expected_body_refs = [
                f"import.body.{artifact_sha256[:12]}.{fingerprint[:12]}.{ordinal}"
                for ordinal, (fingerprint, _) in enumerate(fingerprinted, start=1)
            ]
            if feature.get("bodySemanticRefs") != expected_body_refs:
                raise ValueError(
                    "imported STEP body semantic references no longer match the immutable source"
                )
            compound = cq.Compound.makeCompound([solid for _, solid in fingerprinted])
            if not compound.isValid():
                raise ValueError("imported STEP compound failed OCCT validity checking")
            last_shape = cq.Workplane(obj=compound)
            last_feature = remember(feature, last_shape)
            diagnostics.append(
                Diagnostic(
                    code="IMPORTED_STEP_BASE_RESOLVED",
                    severity="info",
                    message=(
                        f"私有 STEP 基础实体已按 SHA-256 和 {len(solids)} 个稳定实体引用重新验证，"
                        "后续特征在同一 OCCT 图中重建。"
                    ),
                    target_id=str(feature.get("semanticRef") or feature.get("id")),
                )
            )
        else:
            raise ValueError(f"unsupported protocol feature kind: {kind}")

    if last_shape is None:
        raise ValueError("document does not contain a buildable, unsuppressed feature")

    assembly = cq.Assembly(name=str(document.get("name", "OpenVac model")))
    components = document.get("components", [])
    component_frames, assembly_solve_diagnostics = _solve_document_assembly_constraints(
        document, parameter_values
    )
    diagnostics.extend(assembly_solve_diagnostics)
    assembly_shapes: list[Any] = []
    assembly_members: list[tuple[str, str, Any]] = []
    if isinstance(components, list) and components:
        for component in components:
            if not isinstance(component, dict) or component.get("suppressed") is True:
                continue
            feature_refs = component.get("featureRefs", [])
            if not isinstance(feature_refs, list) or not feature_refs:
                raise ValueError("unsuppressed assembly components require at least one featureRef")
            component_feature_ids = [canonical_for_ref(reference) for reference in feature_refs]
            stale_refs = [
                reference
                for reference in component_feature_ids
                if reference not in terminal_features
            ]
            if stale_refs:
                raise ValueError(
                    "components may reference only terminal feature outputs; "
                    "historical ancestor snapshots would duplicate or stale body geometry: "
                    + ", ".join(stale_refs)
                )
            if len(set(component_feature_ids)) != len(component_feature_ids):
                raise ValueError("component featureRefs must not contain duplicates")
            component_shapes = [
                _shape_for_ref(reference, feature_shapes) for reference in feature_refs
            ]
            compound = cq.Compound.makeCompound(
                [(shape.val() if hasattr(shape, "val") else shape) for shape in component_shapes]
            )
            frame = component_frames.get(str(component.get("semanticRef") or component.get("id")))
            if frame is None:
                raise ValueError("component frame could not be resolved")
            translation = frame["translation"]
            rotation = frame["rotation"]
            # Component transforms use an intrinsic local rotation followed by
            # a world-space translation. Apply them in that order so exported
            # geometry and datum-constraint validation share one frame model.
            moved: Any = cq.Workplane(obj=compound)
            for axis, angle in zip(((1, 0, 0), (0, 1, 0), (0, 0, 1)), rotation):
                if angle:
                    moved = moved.rotate((0, 0, 0), axis, float(angle))
            moved = moved.translate(tuple(translation))
            moved_shape = moved.val() if hasattr(moved, "val") else moved
            assembly_shapes.append(moved_shape)
            assembly_members.append(
                (
                    str(component.get("id") or component.get("semanticRef")),
                    str(component.get("semanticRef") or component.get("id")),
                    moved_shape,
                )
            )
            assembly.add(
                moved,
                name=str(component.get("semanticRef") or component.get("id")),
                color=cq.Color(0.64, 0.67, 0.68),
            )
        if not assembly_shapes:
            raise ValueError("document does not contain an unsuppressed assembly component")
        shape = cq.Compound.makeCompound(assembly_shapes)
    else:
        terminal_shapes = [
            feature_shapes[feature_ref]
            for feature_ref in feature_order
            if feature_ref in terminal_features
        ]
        if not terminal_shapes:
            raise ValueError("document does not contain a terminal body output")
        for feature_ref, terminal_shape in zip(
            [item for item in feature_order if item in terminal_features],
            terminal_shapes,
        ):
            assembly.add(
                terminal_shape,
                name=feature_ref,
                color=cq.Color(0.64, 0.67, 0.68),
            )
        shape = (
            terminal_shapes[0].val()
            if len(terminal_shapes) == 1 and hasattr(terminal_shapes[0], "val")
            else terminal_shapes[0]
            if len(terminal_shapes) == 1
            else cq.Compound.makeCompound(
                [item.val() if hasattr(item, "val") else item for item in terminal_shapes]
            )
        )
    diagnostics.extend(
        _validate_document_assembly_constraints(
            document, parameter_values, component_frames=component_frames
        )
    )
    diagnostics.extend(_validate_component_interference(assembly_members))
    return BuiltModel(shape, assembly, diagnostics)


def _validate_component_interference(
    members: list[tuple[str, str, Any]],
) -> list[Diagnostic]:
    """Run exact OCCT intersections for component pairs whose boxes overlap."""

    if len(members) < 2:
        return []
    cq = _cadquery()
    tolerance_mm3 = 1e-6
    bounded = sorted(
        [(*member, member[2].BoundingBox()) for member in members],
        key=lambda item: item[3].xmin,
    )
    active: list[tuple[str, str, Any, Any]] = []
    diagnostics: list[Diagnostic] = []
    checked_pairs = 0
    for current in bounded:
        current_id, current_ref, current_shape, current_box = current
        active = [item for item in active if item[3].xmax >= current_box.xmin]
        for other_id, other_ref, other_shape, other_box in active:
            if (
                other_box.ymax < current_box.ymin
                or current_box.ymax < other_box.ymin
                or other_box.zmax < current_box.zmin
                or current_box.zmax < other_box.zmin
            ):
                continue
            checked_pairs += 1
            try:
                overlap = cq.Workplane(obj=other_shape).intersect(cq.Workplane(obj=current_shape))
                overlap_value = overlap.val()
                overlap_volume = float(overlap_value.Volume()) if overlap_value else 0.0
            except Exception:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_INTERFERENCE_CHECK_FAILED",
                        severity="error",
                        message=(
                            f"组件 {other_ref} 与 {current_ref} 的 OCCT 干涉检查失败；"
                            "没有把近似包围盒当作权威结果。"
                        ),
                        target_id=f"{other_id}|{current_id}",
                    )
                )
                continue
            if overlap_volume > tolerance_mm3:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_INTERFERENCE_DETECTED",
                        severity="warning",
                        message=(
                            f"组件 {other_ref} 与 {current_ref} 存在 "
                            f"{overlap_volume:.6g} mm^3 的实体干涉。"
                        ),
                        target_id=f"{other_id}|{current_id}",
                    )
                )
        active.append(current)

    if not any(
        diagnostic.code == "ASSEMBLY_INTERFERENCE_DETECTED" for diagnostic in diagnostics
    ) and not any(diagnostic.severity == "error" for diagnostic in diagnostics):
        diagnostics.append(
            Diagnostic(
                code="ASSEMBLY_NO_INTERFERENCE",
                severity="info",
                message=f"OCCT 实体干涉检查通过（候选组件对 {checked_pairs} 组）。",
            )
        )
    return diagnostics


def _protocol_parameter_values(document: dict[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    parameters = document.get("parameters", [])
    if isinstance(parameters, dict):
        for key, raw_value in parameters.items():
            if isinstance(raw_value, dict):
                raw_value = raw_value.get("value")
            if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                values[str(key)] = float(raw_value)
        return values
    if not isinstance(parameters, list):
        return values
    for parameter in parameters:
        if not isinstance(parameter, dict):
            continue
        value = parameter.get("value")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values[str(parameter.get("id"))] = float(value)
            values[str(parameter.get("semanticRef"))] = float(value)
    return values


def _protocol_parameter_records(
    document: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    raw_parameters = document.get("parameters", [])
    if not isinstance(raw_parameters, list):
        raise ValueError("strict protocol parameters must be an array")
    records: dict[str, dict[str, Any]] = {}
    expected_units = {
        "length": "mm",
        "angle": "deg",
        "integer": "count",
        "scalar": "ratio",
    }
    for index, parameter in enumerate(raw_parameters):
        if not isinstance(parameter, dict):
            raise ValueError(f"parameter {index + 1} must be an object")
        parameter_type = parameter.get("parameterType")
        unit = parameter.get("unit")
        if parameter_type not in expected_units or unit != expected_units[parameter_type]:
            raise ValueError(
                f"parameter {parameter.get('semanticRef') or parameter.get('id') or index + 1} "
                "has an invalid parameterType/unit pair"
            )
        value = parameter.get("value")
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
        ):
            raise ValueError("protocol parameter values must be finite numbers")
        if parameter_type == "integer" and not float(value).is_integer():
            raise ValueError("integer/count parameters require an exact integer value")
        minimum = parameter.get("minimum")
        maximum = parameter.get("maximum")
        if minimum is not None and float(value) < float(minimum):
            raise ValueError("protocol parameter value is below its minimum")
        if maximum is not None and float(value) > float(maximum):
            raise ValueError("protocol parameter value is above its maximum")
        if minimum is not None and maximum is not None and float(minimum) > float(maximum):
            raise ValueError("protocol parameter minimum exceeds maximum")
        for key in (parameter.get("id"), parameter.get("semanticRef")):
            if not isinstance(key, str) or not key:
                raise ValueError("protocol parameters require id and semanticRef")
            existing = records.get(key)
            if existing is not None and existing is not parameter:
                raise ValueError(f"duplicate protocol parameter reference: {key}")
            records[key] = parameter
    return records


def _validate_protocol_parameter_contract(document: dict[str, Any]) -> None:
    if document.get("version") != PROTOCOL_VERSION:
        return
    records = _protocol_parameter_records(document)

    def require(
        reference: Any,
        parameter_type: str,
        unit: str,
        label: str,
        *,
        positive: bool = False,
        nonnegative: bool = False,
        integer_minimum: int | None = None,
    ) -> float:
        key = _ref_key(reference)
        try:
            parameter = records[key]
        except KeyError as exc:
            raise ValueError(f"{label} references an unknown parameter: {key}") from exc
        if parameter.get("parameterType") != parameter_type or parameter.get("unit") != unit:
            raise ValueError(
                f"{label} requires {parameter_type}/{unit}, got "
                f"{parameter.get('parameterType')}/{parameter.get('unit')}"
            )
        value = float(parameter["value"])
        if positive and value <= 0:
            raise ValueError(f"{label} must be greater than zero")
        if nonnegative and value < 0:
            raise ValueError(f"{label} must be nonnegative")
        if integer_minimum is not None and (not value.is_integer() or value < integer_minimum):
            raise ValueError(f"{label} must be an exact integer >= {integer_minimum}")
        return value

    sketches = document.get("sketches", [])
    if not isinstance(sketches, list):
        raise ValueError("strict protocol sketches must be an array")
    for sketch in sketches:
        if not isinstance(sketch, dict) or sketch.get("suppressed") is True:
            continue
        for entity in sketch.get("entities", []):
            if not isinstance(entity, dict):
                continue
            kind = entity.get("entityKind")
            if kind == "rectangle":
                require(
                    entity.get("widthParameterRef"),
                    "length",
                    "mm",
                    "rectangle width",
                    positive=True,
                )
                require(
                    entity.get("heightParameterRef"),
                    "length",
                    "mm",
                    "rectangle height",
                    positive=True,
                )
            elif kind == "circle":
                require(
                    entity.get("diameterParameterRef"),
                    "length",
                    "mm",
                    "circle diameter",
                    positive=True,
                )
            elif kind == "slot":
                require(
                    entity.get("widthParameterRef"),
                    "length",
                    "mm",
                    "slot width",
                    positive=True,
                )
        for constraint in sketch.get("constraints", []):
            if not isinstance(constraint, dict) or constraint.get("status") == "suppressed":
                continue
            kind = constraint.get("constraintKind")
            if kind in {"distance", "radius", "diameter"}:
                require(
                    constraint.get("parameterRef"),
                    "length",
                    "mm",
                    f"{kind} constraint",
                    nonnegative=kind == "distance",
                    positive=kind in {"radius", "diameter"},
                )
            elif kind == "angle":
                require(
                    constraint.get("parameterRef"),
                    "angle",
                    "deg",
                    "angle constraint",
                )

    features = document.get("features", [])
    if not isinstance(features, list):
        raise ValueError("strict protocol features must be an array")
    for feature in features:
        if not isinstance(feature, dict) or feature.get("suppressed") is True:
            continue
        kind = feature.get("featureKind")
        if kind == "extrude":
            require(
                feature.get("distanceParameterRef"),
                "length",
                "mm",
                "extrude distance",
                positive=True,
            )
        elif kind == "revolve":
            angle = require(
                feature.get("angleParameterRef"),
                "angle",
                "deg",
                "revolve angle",
            )
            if abs(angle) <= 1e-12 or abs(angle) > 360:
                raise ValueError("revolve angle must be nonzero and no greater than 360 degrees")
        elif kind == "circular_pattern":
            count = require(
                feature.get("countParameterRef"),
                "integer",
                "count",
                "circular pattern count",
                integer_minimum=1,
            )
            if count > 100:
                raise ValueError("circular pattern count cannot exceed 100")
            if (
                _norm(_finite_vector3(feature.get("axisDirection"), "pattern axisDirection"))
                <= 1e-12
            ):
                raise ValueError("circular pattern axisDirection cannot be zero")
        elif kind == "linear_pattern":
            count = require(
                feature.get("countParameterRef"),
                "integer",
                "count",
                "linear pattern count",
                integer_minimum=1,
            )
            if count > 100:
                raise ValueError("linear pattern count cannot exceed 100")
            require(
                feature.get("spacingParameterRef"),
                "length",
                "mm",
                "linear pattern spacing",
                positive=True,
            )
            if (
                _norm(_finite_vector3(feature.get("directionVector"), "pattern directionVector"))
                <= 1e-12
            ):
                raise ValueError("linear pattern directionVector cannot be zero")
        elif kind == "port":
            if feature.get("role") not in {"inlet", "outlet"}:
                raise ValueError("port role must be inlet or outlet")
            if feature.get("operation") != "cut":
                raise ValueError("V1 port operation must be cut")
            center_angle = feature.get("centerAngleDegrees")
            if (
                not isinstance(center_angle, (int, float))
                or isinstance(center_angle, bool)
                or not math.isfinite(float(center_angle))
            ):
                raise ValueError("port centerAngleDegrees must be finite")
            for reference, label in (
                (feature.get("widthParameterRef"), "port width"),
                (feature.get("axialWidthParameterRef"), "port axial width"),
            ):
                require(reference, "length", "mm", label, positive=True)
        elif kind == "hole":
            require(
                feature.get("diameterParameterRef"),
                "length",
                "mm",
                "hole diameter",
                positive=True,
            )
            depth_ref = feature.get("depthParameterRef")
            termination = feature.get("termination")
            if termination == "blind":
                if depth_ref is None:
                    raise ValueError("blind holes require a depth parameter")
                require(depth_ref, "length", "mm", "hole depth", positive=True)
            elif termination == "through_all" and depth_ref is not None:
                raise ValueError("through-all holes cannot include an unused depth parameter")
        elif kind == "fillet":
            require(
                feature.get("radiusParameterRef"),
                "length",
                "mm",
                "fillet radius",
                positive=True,
            )
        elif kind == "chamfer":
            require(
                feature.get("distanceParameterRef"),
                "length",
                "mm",
                "chamfer distance",
                positive=True,
            )

    constraints = document.get("assemblyConstraints", [])
    if not isinstance(constraints, list):
        raise ValueError("strict protocol assemblyConstraints must be an array")
    for constraint in constraints:
        if not isinstance(constraint, dict) or constraint.get("status") == "suppressed":
            continue
        if constraint.get("constraintKind") == "distance":
            require(
                constraint.get("parameterRef"),
                "length",
                "mm",
                "assembly distance",
                nonnegative=True,
            )
        elif constraint.get("constraintKind") == "angle":
            require(
                constraint.get("parameterRef"),
                "angle",
                "deg",
                "assembly angle",
            )


def _authoritative_protocol_sketch_diagnostics(
    document: dict[str, Any], parameters: dict[str, float]
) -> list[Diagnostic]:
    return _solve_protocol_sketches(document, parameters)[0]


def _solve_protocol_sketches(
    document: dict[str, Any], parameters: dict[str, float]
) -> tuple[list[Diagnostic], dict[str, dict[str, Any]]]:
    """Solve every active strict-protocol sketch before any B-Rep is built.

    The strict document's ``solveStatus`` and per-constraint ``status`` fields
    are client assertions, not kernel evidence. Only an explicitly suppressed
    constraint is skipped. Successful solver coordinates are returned for the
    B-Rep builder; submitted coordinates are only deterministic seed geometry.
    """

    if document.get("version") != PROTOCOL_VERSION or document.get("unitSystem") != "mm-deg":
        return [], {}
    sketches = document.get("sketches", [])
    if not isinstance(sketches, list):
        return (
            [
                Diagnostic(
                    code="SKETCH_COLLECTION_INVALID",
                    severity="error",
                    message="严格建模文档的 sketches 必须是数组。",
                )
            ],
            {},
        )

    diagnostics: list[Diagnostic] = []
    solved_geometry: dict[str, dict[str, Any]] = {}
    for sketch_index, sketch in enumerate(sketches):
        if not isinstance(sketch, dict):
            diagnostics.append(
                Diagnostic(
                    code="SKETCH_INVALID",
                    severity="error",
                    message=f"第 {sketch_index + 1} 个草图不是对象。",
                )
            )
            continue
        if sketch.get("suppressed") is True:
            continue
        target = str(sketch.get("semanticRef") or sketch.get("id") or "") or None
        try:
            payload, entity_labels, constraint_labels, suppressed_count = (
                _protocol_sketch_solver_payload(sketch, parameters)
            )
        except (KeyError, TypeError, ValueError) as exc:
            diagnostics.append(
                Diagnostic(
                    code="SKETCH_PROTOCOL_MAPPING_UNSUPPORTED",
                    severity="error",
                    message=(f"草图无法无损映射到权威求解器，已在 B-Rep 构建前失败：{exc}"),
                    target_id=target,
                )
            )
            continue

        try:
            result = solve_sketch_payload(payload)
        except Exception as exc:  # solver/runtime failure must fail closed
            diagnostics.append(
                Diagnostic(
                    code="SKETCH_SOLVER_UNAVAILABLE",
                    severity="error",
                    message=f"权威草图求解器不可用或拒绝输入：{exc}",
                    target_id=target,
                )
            )
            continue

        client_status = str(sketch.get("solveStatus", "unspecified"))
        conflicts = [
            constraint_labels.get(identifier, identifier)
            for identifier in result.conflict_constraint_ids
        ]
        conflict_text = f"；冲突约束：{', '.join(conflicts)}" if conflicts else ""
        if result.status not in {"solved", "underconstrained"} or (
            result.status == "solved" and result.dof != 0
        ):
            diagnostics.append(
                Diagnostic(
                    code={
                        "underconstrained": "SKETCH_UNDERCONSTRAINED",
                        "redundant": "SKETCH_REDUNDANT_CONSTRAINTS",
                        "inconsistent": "SKETCH_CONSTRAINTS_INCONSISTENT",
                        "nonconvergent": "SKETCH_SOLVE_NONCONVERGENT",
                        "invalid_input": "SKETCH_SOLVER_INPUT_INVALID",
                        "timeout": "SKETCH_SOLVE_TIMEOUT",
                    }.get(result.status, "SKETCH_SOLVE_FAILED"),
                    severity="error",
                    message=(
                        f"权威求解状态为 {result.status}（DOF={result.dof}），"
                        f"客户端 solveStatus={client_status} 未被信任。"
                        f"{result.diagnostic or ''}{conflict_text}"
                    ),
                    target_id=target,
                )
            )
            continue

        moved_entities = _solver_geometry_drift(payload, result.entities)
        solved_by_id = {entity.id: entity.geometry for entity in result.entities}
        raw_entities = sketch.get("entities", [])
        if isinstance(raw_entities, list):
            for entity_index, raw_entity in enumerate(raw_entities):
                if not isinstance(raw_entity, dict):
                    continue
                geometry = solved_by_id.get(f"e{entity_index}")
                if geometry is None:
                    continue
                for key in (raw_entity.get("id"), raw_entity.get("semanticRef")):
                    if isinstance(key, str) and key:
                        solved_geometry[key] = geometry
        if moved_entities:
            moved_labels = [entity_labels.get(item, item) for item in moved_entities]
            diagnostics.append(
                Diagnostic(
                    code=(
                        "SKETCH_UNDERCONSTRAINED"
                        if result.status == "underconstrained"
                        else "SKETCH_SOLVED_GEOMETRY_UPDATED"
                    ),
                    severity=("warning" if result.status == "underconstrained" else "info"),
                    message=(
                        "SolveSpace 已按参数/约束更新派生几何，B-Rep 将使用求解后坐标："
                        f"{', '.join(moved_labels)}。"
                        + (
                            f"草图仍有 {result.dof} 个自由度；"
                            if result.status == "underconstrained"
                            else "草图完全约束；"
                        )
                        + f"客户端 solveStatus={client_status} 未作为证据。"
                    ),
                    target_id=target,
                )
            )
            continue

        if result.status == "underconstrained":
            diagnostics.append(
                Diagnostic(
                    code="SKETCH_UNDERCONSTRAINED",
                    severity="warning",
                    message=(
                        f"SolveSpace 权威求解确认草图仍有 {result.dof} 个自由度；"
                        "提交坐标未漂移，因此可确定性重建，但后续参数编辑可能移动几何。"
                        f"客户端 solveStatus={client_status} 未作为证据。"
                        + (
                            f"另有 {suppressed_count} 个明确 suppressed 约束未执行。"
                            if suppressed_count
                            else ""
                        )
                    ),
                    target_id=target,
                )
            )
            continue

        diagnostics.append(
            Diagnostic(
                code="SKETCH_SOLVED_AUTHORITATIVE",
                severity="info",
                message=(
                    "SolveSpace 权威求解确认草图完全约束且提交坐标未漂移；"
                    f"客户端 solveStatus={client_status} 未作为证据。"
                    + (
                        f"另有 {suppressed_count} 个明确 suppressed 约束未执行。"
                        if suppressed_count
                        else ""
                    )
                ),
                target_id=target,
            )
        )
    return diagnostics, solved_geometry


def _fail_on_sketch_errors(diagnostics: list[Diagnostic]) -> None:
    errors = [item for item in diagnostics if item.severity == "error"]
    if errors:
        raise ValueError(
            "authoritative sketch validation failed before B-Rep build: "
            + "; ".join(f"{item.code}: {item.message}" for item in errors)
        )


def _protocol_sketch_solver_payload(
    sketch: dict[str, Any], parameters: dict[str, float]
) -> tuple[dict[str, Any], dict[str, str], dict[str, str], int]:
    raw_entities = sketch.get("entities", [])
    raw_constraints = sketch.get("constraints", [])
    if not isinstance(raw_entities, list) or not raw_entities:
        raise ValueError("未抑制草图必须包含至少一个实体")
    if len(raw_entities) > 100:
        raise ValueError("openvac.modeling.v1 每个草图最多包含 100 个实体")
    if not isinstance(raw_constraints, list):
        raise ValueError("草图 constraints 必须是数组")
    if len(raw_constraints) > 200:
        raise ValueError("openvac.modeling.v1 每个草图最多包含 200 个用户约束")

    entity_by_key: dict[str, dict[str, Any]] = {}
    solver_id_by_object: dict[int, str] = {}
    entity_labels: dict[str, str] = {}
    for index, entity in enumerate(raw_entities):
        if not isinstance(entity, dict):
            raise ValueError(f"草图实体 {index + 1} 不是对象")
        solver_id = f"e{index}"
        solver_id_by_object[id(entity)] = solver_id
        entity_labels[solver_id] = str(entity.get("semanticRef") or entity.get("id") or solver_id)
        keys = [entity.get("id"), entity.get("semanticRef")]
        for key in keys:
            if not isinstance(key, str) or not key:
                continue
            existing = entity_by_key.get(key)
            if existing is not None and existing is not entity:
                raise ValueError(f"草图实体引用重复：{key}")
            entity_by_key[key] = entity

    def resolve(reference: Any) -> tuple[dict[str, Any], str]:
        key = _ref_key(reference)
        try:
            entity = entity_by_key[key]
        except KeyError as exc:
            raise ValueError(f"草图约束引用未知或跨草图实体：{key}") from exc
        return entity, solver_id_by_object[id(entity)]

    def point(reference: Any) -> tuple[dict[str, Any], str, tuple[float, float]]:
        entity, solver_id = resolve(reference)
        if entity.get("entityKind") != "point":
            raise ValueError(f"引用 {_ref_key(reference)} 必须指向点")
        coordinates = (float(entity.get("x")), float(entity.get("y")))
        if not all(math.isfinite(value) for value in coordinates):
            raise ValueError(f"点 {_ref_key(reference)} 坐标必须为有限值")
        return entity, solver_id, coordinates

    solver_entities: list[dict[str, Any]] = []
    solver_constraints: list[dict[str, Any]] = []
    constraint_labels: dict[str, str] = {}

    def add_binding(refs: list[str], label: str) -> None:
        identifier = f"binding-{len(solver_constraints)}"
        solver_constraints.append({"id": identifier, "kind": "coincident", "refs": refs})
        constraint_labels[identifier] = label

    for entity in raw_entities:
        solver_id = solver_id_by_object[id(entity)]
        kind = str(entity.get("entityKind", ""))
        converted: dict[str, Any] = {
            "id": solver_id,
            "kind": kind,
            "construction": bool(entity.get("construction", False)),
        }
        if kind == "point":
            converted.update(x=float(entity.get("x")), y=float(entity.get("y")))
        elif kind == "line":
            _, start_id, start = point(entity.get("startPointRef"))
            _, end_id, end = point(entity.get("endPointRef"))
            converted.update(start=start, end=end)
            add_binding([f"{solver_id}:start", start_id], f"{solver_id}.start binding")
            add_binding([f"{solver_id}:end", end_id], f"{solver_id}.end binding")
        elif kind == "polyline":
            point_refs = entity.get("pointRefs", [])
            if not isinstance(point_refs, list):
                raise ValueError(f"折线 {entity_labels[solver_id]} pointRefs 必须是数组")
            resolved_points = [point(reference) for reference in point_refs]
            converted.update(
                points=[item[2] for item in resolved_points],
                closed=bool(entity.get("closed", False)),
            )
            for index, (_, point_id, _) in enumerate(resolved_points):
                add_binding(
                    [f"{solver_id}:point:{index}", point_id],
                    f"{solver_id}.point.{index} binding",
                )
        elif kind == "rectangle":
            _, _, center = point(entity.get("centerPointRef"))
            converted.update(
                center=center,
                width=_parameter_value(entity.get("widthParameterRef"), parameters),
                height=_parameter_value(entity.get("heightParameterRef"), parameters),
                angle_degrees=float(entity.get("rotationDegrees", 0)),
            )
        elif kind == "circle":
            _, center_id, center = point(entity.get("centerPointRef"))
            diameter = _parameter_value(entity.get("diameterParameterRef"), parameters)
            converted.update(center=center, radius=diameter / 2)
            add_binding([f"{solver_id}:center", center_id], f"{solver_id}.center binding")
        elif kind == "arc":
            _, center_id, center = point(entity.get("centerPointRef"))
            _, start_id, start = point(entity.get("startPointRef"))
            _, end_id, end = point(entity.get("endPointRef"))
            converted.update(
                center=center,
                start=start,
                end=end,
                clockwise=bool(entity.get("clockwise", False)),
            )
            for suffix, point_id in (
                ("center", center_id),
                ("start", start_id),
                ("end", end_id),
            ):
                add_binding(
                    [f"{solver_id}:{suffix}", point_id],
                    f"{solver_id}.{suffix} binding",
                )
        elif kind == "slot":
            _, start_id, start = point(entity.get("startPointRef"))
            _, end_id, end = point(entity.get("endPointRef"))
            converted.update(
                start=start,
                end=end,
                width=_parameter_value(entity.get("widthParameterRef"), parameters),
            )
            add_binding(
                [f"{solver_id}:center:start", start_id],
                f"{solver_id}.start-center binding",
            )
            add_binding(
                [f"{solver_id}:center:end", end_id],
                f"{solver_id}.end-center binding",
            )
        else:
            raise ValueError(f"不支持的协议草图实体：{kind or '<missing>'}")
        solver_entities.append(converted)

    def fixed_refs(entity: dict[str, Any], solver_id: str) -> list[str]:
        kind = str(entity.get("entityKind", ""))
        if kind == "point":
            return [solver_id]
        if kind == "line":
            return [f"{solver_id}:start", f"{solver_id}:end"]
        if kind in {"polyline", "rectangle"}:
            count = len(entity.get("pointRefs", [])) if kind == "polyline" else 4
            return [f"{solver_id}:point:{index}" for index in range(count)]
        if kind == "circle":
            return [f"{solver_id}:center"]
        if kind == "arc":
            return [
                f"{solver_id}:center",
                f"{solver_id}:start",
                f"{solver_id}:end",
            ]
        if kind == "slot":
            return [
                *[f"{solver_id}:point:{index}" for index in range(4)],
                f"{solver_id}:center:start",
                f"{solver_id}:center:end",
            ]
        raise ValueError(f"fixed 尚不支持实体类型 {kind}")

    suppressed_count = 0
    for index, constraint in enumerate(raw_constraints):
        if not isinstance(constraint, dict):
            raise ValueError(f"草图约束 {index + 1} 不是对象")
        if constraint.get("status") == "suppressed":
            suppressed_count += 1
            continue
        kind = str(constraint.get("constraintKind", ""))
        target_refs = constraint.get("targetRefs", [])
        if not isinstance(target_refs, list) or not target_refs:
            raise ValueError(f"{kind or '草图'} 约束缺少 targetRefs")
        resolved = [resolve(reference) for reference in target_refs]
        identifier = f"constraint-{index}"
        constraint_labels[identifier] = str(
            constraint.get("semanticRef") or constraint.get("id") or identifier
        )
        value = None
        if kind in {"distance", "radius", "diameter", "angle"}:
            value = _parameter_value(constraint.get("parameterRef"), parameters)

        refs: list[str]
        solver_kind = kind
        if kind == "fixed":
            refs = [
                reference
                for entity, solver_id in resolved
                for reference in fixed_refs(entity, solver_id)
            ]
        elif kind in {"horizontal", "vertical"}:
            if len(resolved) == 1 and resolved[0][0].get("entityKind") == "line":
                refs = [resolved[0][1]]
            elif len(resolved) == 2 and all(
                entity.get("entityKind") == "point" for entity, _ in resolved
            ):
                refs = [solver_id for _, solver_id in resolved]
            else:
                raise ValueError(f"{kind} 仅支持一条线或两个点")
        elif kind == "coincident":
            if len(resolved) != 2 or not all(
                entity.get("entityKind") == "point" for entity, _ in resolved
            ):
                raise ValueError("coincident 在 V1 仅支持两个显式点")
            refs = [solver_id for _, solver_id in resolved]
        elif kind == "concentric":
            if len(resolved) != 2 or not all(
                entity.get("entityKind") in {"circle", "arc"} for entity, _ in resolved
            ):
                raise ValueError("concentric 仅支持两个圆或圆弧的圆心")
            solver_kind = "coincident"
            refs = [f"{solver_id}:center" for _, solver_id in resolved]
        elif kind == "distance":
            if len(resolved) == 2 and all(
                entity.get("entityKind") == "point" for entity, _ in resolved
            ):
                refs = [solver_id for _, solver_id in resolved]
            elif len(resolved) == 1 and resolved[0][0].get("entityKind") == "line":
                refs = [f"{resolved[0][1]}:start", f"{resolved[0][1]}:end"]
            else:
                raise ValueError("distance 仅支持两个点或一条线的长度")
        elif kind in {"radius", "diameter"}:
            if len(resolved) != 1 or resolved[0][0].get("entityKind") not in {
                "circle",
                "arc",
            }:
                raise ValueError(f"{kind} 必须引用一个圆或圆弧")
            refs = [resolved[0][1]]
        elif kind in {"parallel", "perpendicular", "angle"}:
            if len(resolved) != 2 or not all(
                entity.get("entityKind") == "line" for entity, _ in resolved
            ):
                raise ValueError(f"{kind} 必须引用两条线")
            refs = [solver_id for _, solver_id in resolved]
        elif kind == "tangent":
            if len(resolved) != 2 or not all(
                entity.get("entityKind") in {"line", "circle", "arc"} for entity, _ in resolved
            ):
                raise ValueError("tangent 必须引用两条可相切曲线")
            refs = [solver_id for _, solver_id in resolved]
        elif kind == "equal":
            if len(resolved) != 2:
                raise ValueError("equal 必须引用两个实体")
            refs = [solver_id for _, solver_id in resolved]
        elif kind == "midpoint":
            points = [item for item in resolved if item[0].get("entityKind") == "point"]
            lines = [item for item in resolved if item[0].get("entityKind") == "line"]
            if len(points) != 1 or len(lines) != 1:
                raise ValueError("midpoint 必须引用一个点和一条线")
            refs = [points[0][1], lines[0][1]]
        elif kind == "symmetric":
            points = [item for item in resolved if item[0].get("entityKind") == "point"]
            lines = [item for item in resolved if item[0].get("entityKind") == "line"]
            if len(points) != 2 or len(lines) != 1:
                raise ValueError("symmetric 必须引用两个点和一条对称轴")
            refs = [points[0][1], points[1][1], lines[0][1]]
        else:
            raise ValueError(f"不支持的草图约束 {kind or '<missing>'}，未静默忽略")

        converted_constraint: dict[str, Any] = {
            "id": identifier,
            "kind": solver_kind,
            "refs": refs,
        }
        if value is not None:
            converted_constraint["value"] = value
        solver_constraints.append(converted_constraint)

    return (
        {
            "version": PROTOCOL_VERSION,
            "entities": solver_entities,
            "constraints": solver_constraints,
        },
        entity_labels,
        constraint_labels,
        suppressed_count,
    )


def _solver_geometry_drift(payload: dict[str, Any], solved_entities: list[Any]) -> list[str]:
    solved_by_id = {entity.id: entity.geometry for entity in solved_entities}
    moved: list[str] = []
    for entity in payload.get("entities", []):
        identifier = str(entity.get("id"))
        solved = solved_by_id.get(identifier)
        if solved is None or not _solver_entity_matches_input(entity, solved):
            moved.append(identifier)
    return moved


def _solver_entity_matches_input(entity: dict[str, Any], solved: dict[str, Any]) -> bool:
    tolerance = 1e-6

    def point_matches(actual: Any, expected: Any) -> bool:
        if not isinstance(actual, dict) or not isinstance(expected, (list, tuple)):
            return False
        return (
            abs(float(actual.get("x")) - float(expected[0])) <= tolerance
            and abs(float(actual.get("y")) - float(expected[1])) <= tolerance
        )

    kind = entity.get("kind")
    if kind == "point":
        return point_matches(solved, (entity.get("x"), entity.get("y")))
    if kind == "line":
        return point_matches(solved.get("start"), entity.get("start")) and point_matches(
            solved.get("end"), entity.get("end")
        )
    if kind == "polyline":
        expected = entity.get("points", [])
        actual = solved.get("points", [])
        return len(actual) == len(expected) and all(
            point_matches(actual_point, expected_point)
            for actual_point, expected_point in zip(actual, expected)
        )
    if kind == "rectangle":
        center = entity.get("center")
        width = float(entity.get("width"))
        height = float(entity.get("height"))
        angle = math.radians(float(entity.get("angle_degrees", 0)))
        cosine, sine = math.cos(angle), math.sin(angle)
        expected = [
            (
                center[0] + x * cosine - y * sine,
                center[1] + x * sine + y * cosine,
            )
            for x, y in (
                (-width / 2, -height / 2),
                (width / 2, -height / 2),
                (width / 2, height / 2),
                (-width / 2, height / 2),
            )
        ]
        actual = solved.get("points", [])
        return len(actual) == 4 and all(
            point_matches(actual_point, expected_point)
            for actual_point, expected_point in zip(actual, expected)
        )
    if kind == "circle":
        return (
            point_matches(solved.get("center"), entity.get("center"))
            and abs(float(solved.get("radius")) - float(entity.get("radius"))) <= tolerance
        )
    if kind == "arc":
        return all(
            point_matches(solved.get(key), entity.get(key)) for key in ("center", "start", "end")
        )
    if kind == "slot":
        return point_matches(solved.get("startCenter"), entity.get("start")) and point_matches(
            solved.get("endCenter"), entity.get("end")
        )
    return False


def _finite_vector3(value: Any, field: str) -> tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{field} must be a finite 3-vector")
    vector = tuple(float(coordinate) for coordinate in value)
    if not all(math.isfinite(coordinate) for coordinate in vector):
        raise ValueError(f"{field} must be a finite 3-vector")
    return vector


def _component_frames(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    frames: dict[str, dict[str, Any]] = {}
    components = document.get("components", [])
    if not isinstance(components, list):
        return frames
    for component in components:
        if not isinstance(component, dict) or component.get("suppressed") is True:
            continue
        transform = component.get("transform", {})
        if not isinstance(transform, dict):
            raise ValueError("component transform must be an object")
        frame = {
            "translation": _finite_vector3(
                transform.get("translationMm", [0, 0, 0]),
                "component.transform.translationMm",
            ),
            "rotation": _finite_vector3(
                transform.get("rotationDegrees", [0, 0, 0]),
                "component.transform.rotationDegrees",
            ),
        }
        for key in (component.get("id"), component.get("semanticRef")):
            if isinstance(key, str) and key:
                if key in frames:
                    raise ValueError(f"duplicate component assembly reference: {key}")
                frames[key] = frame
    return frames


def _rotated_local_z(rotation_degrees: tuple[float, float, float]) -> tuple[float, float, float]:
    x_angle, y_angle, z_angle = (math.radians(value) for value in rotation_degrees)
    vector = (0.0, -math.sin(x_angle), math.cos(x_angle))
    vector = (
        vector[0] * math.cos(y_angle) + vector[2] * math.sin(y_angle),
        vector[1],
        -vector[0] * math.sin(y_angle) + vector[2] * math.cos(y_angle),
    )
    return (
        vector[0] * math.cos(z_angle) - vector[1] * math.sin(z_angle),
        vector[0] * math.sin(z_angle) + vector[1] * math.cos(z_angle),
        vector[2],
    )


def _cross(
    left: tuple[float, float, float], right: tuple[float, float, float]
) -> tuple[float, float, float]:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _norm(vector: tuple[float, float, float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


def _solve_document_assembly_constraints(
    document: dict[str, Any], parameters: dict[str, float]
) -> tuple[dict[str, dict[str, Any]], list[Diagnostic]]:
    """Solve the V1 origin/axis datum mates into one authoritative frame set.

    Fixed components retain their submitted finite frame. For each remaining
    binary mate, the first component is the anchor and the second is moved;
    when only the second is fixed, that direction is reversed. Constraints are
    applied in document order and the full set is validated afterward, so
    conflicting cycles fail instead of being silently accepted.
    """

    frames = _component_frames(document)
    constraints = document.get("assemblyConstraints", [])
    if not isinstance(constraints, list):
        return frames, []
    fixed_frames: set[int] = set()
    diagnostics: list[Diagnostic] = []

    def resolve(reference: Any) -> dict[str, Any] | None:
        try:
            return frames[_ref_key(reference)]
        except (KeyError, ValueError):
            return None

    for constraint in constraints:
        if (
            not isinstance(constraint, dict)
            or constraint.get("status") == "suppressed"
            or constraint.get("constraintKind") != "fixed"
        ):
            continue
        references = constraint.get("componentRefs", [])
        if isinstance(references, list) and len(references) == 1:
            frame = resolve(references[0])
            if frame is not None:
                fixed_frames.add(id(frame))

    for constraint in constraints:
        if not isinstance(constraint, dict) or constraint.get("status") == "suppressed":
            continue
        kind = str(constraint.get("constraintKind", ""))
        if kind == "fixed":
            continue
        if kind not in {"distance", "coincident", "concentric"}:
            continue
        references = constraint.get("componentRefs", [])
        if not isinstance(references, list) or len(references) != 2:
            continue
        first = resolve(references[0])
        second = resolve(references[1])
        if first is None or second is None:
            continue
        first_fixed = id(first) in fixed_frames
        second_fixed = id(second) in fixed_frames
        if first_fixed and second_fixed:
            continue
        anchor, moving = (second, first) if second_fixed and not first_fixed else (first, second)
        target = str(constraint.get("semanticRef") or constraint.get("id") or "") or None
        before_translation = moving["translation"]
        before_rotation = moving["rotation"]

        if kind == "coincident":
            moving["translation"] = tuple(anchor["translation"])
        elif kind == "distance":
            try:
                distance = _parameter_value(constraint.get("parameterRef"), parameters)
            except ValueError:
                continue
            if not math.isfinite(distance) or distance < 0:
                continue
            delta = tuple(
                current - origin
                for origin, current in zip(anchor["translation"], moving["translation"])
            )
            length = _norm(delta)
            direction = (
                tuple(value / length for value in delta) if length > 1e-12 else (1.0, 0.0, 0.0)
            )
            moving["translation"] = tuple(
                origin + axis_value * distance
                for origin, axis_value in zip(anchor["translation"], direction)
            )
        else:  # concentric local-Z datum mate
            axis = _rotated_local_z(anchor["rotation"])
            axis_length = _norm(axis)
            if axis_length <= 1e-12:
                continue
            axis = tuple(value / axis_length for value in axis)
            delta = tuple(
                current - origin
                for origin, current in zip(anchor["translation"], moving["translation"])
            )
            axial_offset = sum(value * axis_value for value, axis_value in zip(delta, axis))
            moving["translation"] = tuple(
                origin + axis_value * axial_offset
                for origin, axis_value in zip(anchor["translation"], axis)
            )
            moving_axis = _rotated_local_z(moving["rotation"])
            if _norm(_cross(axis, moving_axis)) > 1e-10:
                clamped_z = max(-1.0, min(1.0, axis[2]))
                pitch = math.degrees(math.acos(clamped_z))
                yaw = (
                    math.degrees(math.atan2(axis[1], axis[0]))
                    if abs(axis[0]) > 1e-12 or abs(axis[1]) > 1e-12
                    else 0.0
                )
                moving["rotation"] = (0.0, pitch, yaw)

        if moving["translation"] != before_translation or moving["rotation"] != before_rotation:
            diagnostics.append(
                Diagnostic(
                    code="ASSEMBLY_DATUM_MATE_SOLVED",
                    severity="info",
                    message=(
                        f"{kind} 基准约束已确定性求解，并将求解帧用于 B-Rep、GLB、测量和干涉检查。"
                    ),
                    target_id=target,
                )
            )
    return frames, diagnostics


def _validate_document_assembly_constraints(
    document: dict[str, Any],
    parameters: dict[str, float],
    *,
    component_frames: dict[str, dict[str, Any]] | None = None,
) -> list[Diagnostic]:
    """Validate component datum constraints; never infer unexpressed B-Rep faces."""

    constraints = document.get("assemblyConstraints", [])
    if constraints is None:
        return []
    if not isinstance(constraints, list):
        return [
            Diagnostic(
                code="ASSEMBLY_CONSTRAINTS_INVALID",
                severity="error",
                message="assemblyConstraints 必须是约束数组。",
            )
        ]
    frames = component_frames or _component_frames(document)
    diagnostics: list[Diagnostic] = []
    linear_tolerance = 1e-6
    angular_tolerance = 1e-8

    for constraint in constraints:
        if not isinstance(constraint, dict):
            diagnostics.append(
                Diagnostic(
                    code="ASSEMBLY_CONSTRAINT_INVALID",
                    severity="error",
                    message="装配约束必须是对象。",
                )
            )
            continue
        target = str(constraint.get("semanticRef") or constraint.get("id") or "") or None
        kind = str(constraint.get("constraintKind", ""))
        if constraint.get("status") == "suppressed":
            diagnostics.append(
                Diagnostic(
                    code="ASSEMBLY_CONSTRAINT_SUPPRESSED",
                    severity="info",
                    message="装配约束已明确抑制，内核未执行该约束。",
                    target_id=target,
                )
            )
            continue

        references = constraint.get("componentRefs", [])
        if not isinstance(references, list):
            references = []
        resolved: list[dict[str, Any]] = []
        unknown_reference = False
        for reference in references:
            try:
                frame = frames[_ref_key(reference)]
            except (KeyError, ValueError):
                unknown_reference = True
                break
            resolved.append(frame)
        if unknown_reference:
            diagnostics.append(
                Diagnostic(
                    code="ASSEMBLY_COMPONENT_REFERENCE_UNKNOWN",
                    severity="error",
                    message="装配约束引用了不存在或已抑制的组件。",
                    target_id=target,
                )
            )
            continue

        if kind == "fixed":
            if len(resolved) != 1:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_FIXED_INVALID",
                        severity="error",
                        message="fixed 约束必须且只能引用一个组件。",
                        target_id=target,
                    )
                )
            else:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_FIXED_SATISFIED",
                        severity="info",
                        message="组件有限变换已作为确定性固定基准验证。",
                        target_id=target,
                    )
                )
            continue

        if kind in {"distance", "coincident", "concentric"} and len(resolved) != 2:
            diagnostics.append(
                Diagnostic(
                    code="ASSEMBLY_CONSTRAINT_CARDINALITY_INVALID",
                    severity="error",
                    message=f"{kind} 约束必须引用两个组件。",
                    target_id=target,
                )
            )
            continue

        if kind == "distance":
            parameter_ref = constraint.get("parameterRef")
            try:
                expected = _parameter_value(parameter_ref, parameters)
            except ValueError:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_DISTANCE_PARAMETER_INVALID",
                        severity="error",
                        message="distance mate 必须引用可解析的距离参数。",
                        target_id=target,
                    )
                )
                continue
            actual = math.dist(resolved[0]["translation"], resolved[1]["translation"])
            tolerance = max(linear_tolerance, abs(expected) * 1e-7)
            if abs(actual - expected) <= tolerance:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_DISTANCE_SATISFIED",
                        severity="info",
                        message=(
                            "组件基准原点 distance mate 已验证；"
                            f"实际 {actual:.9g} mm，目标 {expected:.9g} mm。"
                        ),
                        target_id=target,
                    )
                )
            else:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_DISTANCE_MISMATCH",
                        severity="error",
                        message=(
                            "组件基准原点距离不满足 mate；"
                            f"实际 {actual:.9g} mm，目标 {expected:.9g} mm。"
                        ),
                        target_id=target,
                    )
                )
            continue

        if kind == "coincident":
            separation = math.dist(resolved[0]["translation"], resolved[1]["translation"])
            if separation <= linear_tolerance:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_ORIGIN_MATE_SATISFIED",
                        severity="info",
                        message=(
                            "组件基准原点贴合已验证；协议未指定 B-Rep 面，"
                            "因此没有推断任意表面 mate。"
                        ),
                        target_id=target,
                    )
                )
            else:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_ORIGIN_MATE_MISMATCH",
                        severity="error",
                        message=f"组件基准原点相距 {separation:.9g} mm，未贴合。",
                        target_id=target,
                    )
                )
            continue

        if kind == "concentric":
            first_axis = _rotated_local_z(resolved[0]["rotation"])
            second_axis = _rotated_local_z(resolved[1]["rotation"])
            parallel_error = _norm(_cross(first_axis, second_axis))
            offset = tuple(
                right - left
                for left, right in zip(resolved[0]["translation"], resolved[1]["translation"])
            )
            axis_distance = _norm(_cross(offset, first_axis))
            if parallel_error <= angular_tolerance and axis_distance <= linear_tolerance:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_CONCENTRIC_SATISFIED",
                        severity="info",
                        message="组件局部 Z 基准轴共线，concentric 约束已验证。",
                        target_id=target,
                    )
                )
            else:
                diagnostics.append(
                    Diagnostic(
                        code="ASSEMBLY_CONCENTRIC_MISMATCH",
                        severity="error",
                        message=(f"组件局部 Z 基准轴不共线；轴距 {axis_distance:.9g} mm。"),
                        target_id=target,
                    )
                )
            continue

        diagnostics.append(
            Diagnostic(
                code="ASSEMBLY_CONSTRAINT_UNSUPPORTED",
                severity="error",
                message=(
                    f"内核尚不支持 {kind or '<missing>'} 装配约束；该约束已明确失败，未被静默忽略。"
                ),
                target_id=target,
            )
        )
    return diagnostics


def _protocol_profile(
    cq: Any,
    references: list[Any],
    entities: dict[str, dict[str, Any]],
    sketches: dict[str, dict[str, Any]],
    parameters: dict[str, float],
    solved_geometry: dict[str, dict[str, Any]] | None = None,
):
    if not references:
        raise ValueError("feature profileRefs cannot be empty")
    resolved = [_entity_for_ref(reference, entities) for reference in references]
    profile_sketches = [sketches[_ref_key(reference)] for reference in references]
    first_sketch = profile_sketches[0]
    if any(sketch is not first_sketch for sketch in profile_sketches[1:]):
        raise ValueError("all profileRefs must belong to the same sketch")
    if any(entity.get("construction") is True for entity in resolved):
        raise ValueError("construction geometry cannot define a solid profile")
    plane_name = str(first_sketch.get("plane", "xy")).upper()
    workplane = cq.Workplane(plane_name)
    solved_geometry = solved_geometry or {}
    if all(entity.get("entityKind") == "circle" for entity in resolved):
        for entity in resolved:
            solved = _solved_geometry_for_entity(entity, solved_geometry)
            center = (
                _geometry_point(solved.get("center"), "solved circle center")
                if solved
                else _point_for_ref(entity.get("centerPointRef"), entities, solved_geometry)
            )
            radius = (
                float(solved.get("radius"))
                if solved and isinstance(solved.get("radius"), (int, float))
                else _parameter_value(entity.get("diameterParameterRef"), parameters) / 2
            )
            if not math.isfinite(radius) or radius <= 0:
                raise ValueError("circle profile radius must be positive and finite")
            workplane = workplane.center(*center).circle(radius).center(-center[0], -center[1])
        return workplane
    if len(resolved) == 1 and resolved[0].get("entityKind") == "rectangle":
        entity = resolved[0]
        solved = _solved_geometry_for_entity(entity, solved_geometry)
        if solved:
            points = _geometry_points(solved.get("points"), "solved rectangle")
            if len(points) != 4:
                raise ValueError("solved rectangle must contain four points")
            return workplane.polyline(points).close()
        center = _point_for_ref(entity.get("centerPointRef"), entities, solved_geometry)
        width = _parameter_value(entity.get("widthParameterRef"), parameters)
        height = _parameter_value(entity.get("heightParameterRef"), parameters)
        profile = workplane.center(center[0], center[1]).rect(width, height)
        rotation = float(entity.get("rotationDegrees", 0))
        return profile.rotate((0, 0, 0), (0, 0, 1), rotation) if rotation else profile
    if len(resolved) == 1 and resolved[0].get("entityKind") == "polyline":
        entity = resolved[0]
        solved = _solved_geometry_for_entity(entity, solved_geometry)
        points = (
            _geometry_points(solved.get("points"), "solved polyline")
            if solved
            else [
                _point_for_ref(reference, entities, solved_geometry)
                for reference in entity.get("pointRefs", [])
            ]
        )
        if len(points) < 3 or entity.get("closed") is not True:
            raise ValueError("solid profiles require a closed polyline with at least three points")
        return workplane.polyline(points).close()
    if len(resolved) == 1 and resolved[0].get("entityKind") == "slot":
        entity = resolved[0]
        solved = _solved_geometry_for_entity(entity, solved_geometry)
        start = (
            _geometry_point(solved.get("startCenter"), "solved slot start")
            if solved
            else _point_for_ref(entity.get("startPointRef"), entities, solved_geometry)
        )
        end = (
            _geometry_point(solved.get("endCenter"), "solved slot end")
            if solved
            else _point_for_ref(entity.get("endPointRef"), entities, solved_geometry)
        )
        centerline_length = math.dist(start, end)
        width = _parameter_value(entity.get("widthParameterRef"), parameters)
        if centerline_length <= 1e-9:
            raise ValueError("slot centerline cannot be zero length")
        midpoint = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
        angle = math.degrees(math.atan2(end[1] - start[1], end[0] - start[0]))
        return workplane.center(*midpoint).slot2D(centerline_length + width, width, angle)
    if all(entity.get("entityKind") in {"line", "arc"} for entity in resolved):
        segments = [_profile_segment(entity, entities, solved_geometry) for entity in resolved]
        oriented = _orient_profile_segments(segments)
        path = workplane.moveTo(*oriented[0]["start"])
        for segment in oriented:
            if segment["kind"] == "line":
                path = path.lineTo(*segment["end"])
                continue
            midpoint = _arc_midpoint(
                segment["center"],
                segment["start"],
                segment["end"],
                bool(segment["clockwise"]),
            )
            path = path.threePointArc(midpoint, segment["end"])
        return path.close()
    raise ValueError(
        "profileRefs must resolve to circles, a rectangle, closed polyline, slot, or one ordered line/arc loop"
    )


def _entity_for_ref(reference: Any, entities: dict[str, dict[str, Any]]) -> dict[str, Any]:
    key = _ref_key(reference)
    try:
        return entities[key]
    except KeyError as exc:
        raise ValueError(f"unknown semantic sketch reference: {key}") from exc


def _point_for_ref(
    reference: Any,
    entities: dict[str, dict[str, Any]],
    solved_geometry: dict[str, dict[str, Any]] | None = None,
) -> tuple[float, float]:
    entity = _entity_for_ref(reference, entities)
    if entity.get("entityKind") != "point":
        raise ValueError("reference must target a sketch point")
    solved = _solved_geometry_for_entity(entity, solved_geometry or {})
    if solved:
        return _geometry_point(solved, "solved point")
    return float(entity.get("x", 0)), float(entity.get("y", 0))


def _solved_geometry_for_entity(
    entity: dict[str, Any], solved_geometry: dict[str, dict[str, Any]]
) -> dict[str, Any] | None:
    for key in (entity.get("semanticRef"), entity.get("id")):
        if isinstance(key, str) and key in solved_geometry:
            return solved_geometry[key]
    return None


def _geometry_point(value: Any, label: str) -> tuple[float, float]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a point")
    point = (float(value.get("x")), float(value.get("y")))
    if not all(math.isfinite(item) for item in point):
        raise ValueError(f"{label} must contain finite coordinates")
    return point


def _geometry_points(value: Any, label: str) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must contain a point list")
    return [_geometry_point(point, label) for point in value]


def _profile_segment(
    entity: dict[str, Any],
    entities: dict[str, dict[str, Any]],
    solved_geometry: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    kind = str(entity.get("entityKind"))
    solved = _solved_geometry_for_entity(entity, solved_geometry)
    if kind == "line":
        return {
            "kind": "line",
            "start": (
                _geometry_point(solved.get("start"), "solved line start")
                if solved
                else _point_for_ref(entity.get("startPointRef"), entities, solved_geometry)
            ),
            "end": (
                _geometry_point(solved.get("end"), "solved line end")
                if solved
                else _point_for_ref(entity.get("endPointRef"), entities, solved_geometry)
            ),
        }
    if kind == "arc":
        return {
            "kind": "arc",
            "center": (
                _geometry_point(solved.get("center"), "solved arc center")
                if solved
                else _point_for_ref(entity.get("centerPointRef"), entities, solved_geometry)
            ),
            "start": (
                _geometry_point(solved.get("start"), "solved arc start")
                if solved
                else _point_for_ref(entity.get("startPointRef"), entities, solved_geometry)
            ),
            "end": (
                _geometry_point(solved.get("end"), "solved arc end")
                if solved
                else _point_for_ref(entity.get("endPointRef"), entities, solved_geometry)
            ),
            "clockwise": bool(entity.get("clockwise", False)),
        }
    raise ValueError("profile segment must be a line or arc")


def _orient_profile_segments(
    segments: list[dict[str, Any]], tolerance: float = 1e-6
) -> list[dict[str, Any]]:
    if len(segments) < 2:
        raise ValueError("a line/arc profile loop requires at least two segments")

    def reversed_segment(segment: dict[str, Any]) -> dict[str, Any]:
        return {
            **segment,
            "start": segment["end"],
            "end": segment["start"],
            **({"clockwise": not bool(segment["clockwise"])} if segment["kind"] == "arc" else {}),
        }

    def attempt(first: dict[str, Any]) -> list[dict[str, Any]] | None:
        oriented = [first]
        for segment in segments[1:]:
            previous_end = oriented[-1]["end"]
            if math.dist(previous_end, segment["start"]) <= tolerance:
                oriented.append(segment)
            elif math.dist(previous_end, segment["end"]) <= tolerance:
                oriented.append(reversed_segment(segment))
            else:
                return None
        if math.dist(oriented[-1]["end"], oriented[0]["start"]) > tolerance:
            return None
        return oriented

    oriented = attempt(segments[0]) or attempt(reversed_segment(segments[0]))
    if oriented is None:
        raise ValueError(
            "profile line/arc references must form one continuous closed loop in order"
        )
    return oriented


def _arc_midpoint(
    center: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
    clockwise: bool,
) -> tuple[float, float]:
    start_radius = math.dist(center, start)
    end_radius = math.dist(center, end)
    if start_radius <= 1e-9 or abs(start_radius - end_radius) > max(1e-6, start_radius * 1e-6):
        raise ValueError("arc profile endpoints must share one positive radius")
    start_angle = math.atan2(start[1] - center[1], start[0] - center[0])
    end_angle = math.atan2(end[1] - center[1], end[0] - center[0])
    if clockwise:
        sweep = -((start_angle - end_angle) % (2 * math.pi))
    else:
        sweep = (end_angle - start_angle) % (2 * math.pi)
    if abs(sweep) <= 1e-10 or abs(abs(sweep) - 2 * math.pi) <= 1e-10:
        raise ValueError("a profile arc cannot have coincident start and end points")
    midpoint_angle = start_angle + sweep / 2
    return (
        center[0] + start_radius * math.cos(midpoint_angle),
        center[1] + start_radius * math.sin(midpoint_angle),
    )


def _shape_for_ref(reference: Any, shapes: dict[str, Any]) -> Any:
    key = _ref_key(reference)
    try:
        return shapes[key]
    except KeyError as exc:
        raise ValueError(f"unknown semantic feature reference: {key}") from exc


def _parameter_value(reference: Any, parameters: dict[str, float]) -> float:
    key = _ref_key(reference)
    try:
        return parameters[key]
    except KeyError as exc:
        raise ValueError(f"unknown semantic parameter reference: {key}") from exc


def _optional_parameter_value(reference: Any, parameters: dict[str, float]) -> float | None:
    return None if reference is None else _parameter_value(reference, parameters)


def _ref_key(reference: Any) -> str:
    if not isinstance(reference, dict):
        raise ValueError("semantic reference must be an object")
    semantic = reference.get("semanticRef")
    identifier = reference.get("id")
    if isinstance(semantic, str) and semantic:
        return semantic
    if isinstance(identifier, str) and identifier:
        return identifier
    raise ValueError("semantic reference is missing id and semanticRef")


def _bounding_extents(shape: Any) -> tuple[float, float, float]:
    bounds = shape.BoundingBox()
    return (float(bounds.xlen), float(bounds.ylen), float(bounds.zlen))


def _assert_artifact_scale(
    artifact_format: str,
    actual_extents: Iterable[float],
    expected_extents: Iterable[float],
    *,
    axes_may_be_permuted: bool = False,
) -> None:
    actual = tuple(float(item) for item in actual_extents)
    expected = tuple(float(item) for item in expected_extents)
    if axes_may_be_permuted:
        actual = tuple(sorted(actual))
        expected = tuple(sorted(expected))
    if len(actual) != 3 or not all(math.isfinite(item) and item >= 0 for item in actual):
        raise ValueError(f"{artifact_format.upper()} read-back returned invalid bounds")
    for actual_length, expected_length in zip(actual, expected):
        tolerance = max(0.05, abs(expected_length) * 0.0005)
        if abs(actual_length - expected_length) > tolerance:
            raise ValueError(
                f"{artifact_format.upper()} read-back bounding envelope differs by "
                f"{abs(actual_length - expected_length):.6g} mm; tolerance is "
                f"{tolerance:.6g} mm"
            )


def _validate_export_readback(
    cq: Any,
    artifact_format: str,
    path: Path,
    source_shape: Any,
) -> Diagnostic:
    expected_extents = _bounding_extents(source_shape)
    if artifact_format == "step":
        imported = cq.importers.importStep(str(path))
        solids = [solid for item in imported.vals() for solid in item.Solids()]
        if not solids or any(
            not solid.isValid() or float(solid.Volume()) <= 1e-9 for solid in solids
        ):
            raise ValueError("STEP export read-back did not contain valid closed solids")
        round_trip = cq.Compound.makeCompound(solids)
        _assert_artifact_scale("step", _bounding_extents(round_trip), expected_extents)
        expected_volume = float(source_shape.Volume())
        actual_volume = float(round_trip.Volume())
        if expected_volume <= 1e-9:
            raise ValueError("STEP export source has no measurable solid volume")
        relative_error = abs(actual_volume - expected_volume) / expected_volume
        if relative_error > 0.001:
            raise ValueError(
                f"STEP export read-back volume relative error {relative_error:.6%} exceeds 0.1%"
            )
        return Diagnostic(
            code="STEP_EXPORT_READBACK_VALID",
            severity="info",
            message=(
                "STEP 已由 OCCT 重新导入；包络偏差不超过 "
                "max(0.05 mm, 0.05%)，体积相对偏差不超过 0.1%。"
            ),
        )

    content = path.read_bytes()
    if artifact_format == "glb" and (
        len(content) < 12
        or content[:4] != b"glTF"
        or int.from_bytes(content[4:8], "little") != 2
        or int.from_bytes(content[8:12], "little") != len(content)
    ):
        raise ValueError("GLB export failed binary header read-back validation")
    if artifact_format == "stl" and len(content) < 84:
        raise ValueError("STL export is empty")

    import vtk

    if artifact_format == "stl":
        reader = vtk.vtkSTLReader()
        reader.SetFileName(str(path))
        reader.Update()
        mesh = reader.GetOutput()
        axes_may_be_permuted = False
    elif artifact_format == "glb":
        reader = vtk.vtkGLTFReader()
        reader.SetFileName(str(path))
        reader.Update()
        geometry = vtk.vtkCompositeDataGeometryFilter()
        geometry.SetInputDataObject(reader.GetOutput())
        geometry.Update()
        mesh = geometry.GetOutput()
        axes_may_be_permuted = True
    else:  # pragma: no cover - caller validates the format
        raise ValueError(f"unsupported read-back format: {artifact_format}")
    if mesh.GetNumberOfPoints() <= 0 or mesh.GetNumberOfCells() <= 0:
        raise ValueError(f"{artifact_format.upper()} export read-back contains no loadable mesh")
    bounds = mesh.GetBounds()
    actual_extents = tuple(float(bounds[index + 1] - bounds[index]) for index in (0, 2, 4))
    _assert_artifact_scale(
        artifact_format,
        actual_extents,
        expected_extents,
        axes_may_be_permuted=axes_may_be_permuted,
    )
    return Diagnostic(
        code=f"{artifact_format.upper()}_EXPORT_READBACK_VALID",
        severity="info",
        message=(f"{artifact_format.upper()} 已完成加载、单位、尺度和包络读回校验。"),
    )


def _document_mass(
    document: dict[str, Any], volume_mm3: float
) -> tuple[float | None, Literal["computed_from_user_density", "unavailable_density_required"]]:
    """Return mass only when the document carries an explicit user density.

    A missing material is a normal, visible state. The deterministic engine
    must never substitute a presumed aluminium, steel, oil, or vendor value.
    """

    metadata = document.get("metadata")
    material = metadata.get("material") if isinstance(metadata, dict) else None
    if material is None:
        return None, "unavailable_density_required"
    if not isinstance(material, dict):
        raise ValueError("metadata.material must be an object")
    if material.get("densitySource") != "user":
        raise ValueError("material density must be explicitly supplied by the user")
    density = material.get("densityKgM3")
    if (
        not isinstance(density, (int, float))
        or isinstance(density, bool)
        or not math.isfinite(float(density))
        or float(density) <= 0
    ):
        raise ValueError("material density must be a positive finite kg/m3 value")
    # 1 mm3 = 1e-9 m3. Keep this a geometry-derived value, not a claim about
    # manufacturing tolerances, porosity, coatings, fasteners, or fluids.
    return float(volume_mm3) * float(density) * 1e-9, "computed_from_user_density"


def build_to_artifacts(
    job_id: str,
    document: dict[str, Any],
    formats: Iterable[str],
    artifact_root: Path,
    validate_pump: bool,
    imported_sources: dict[str, str] | None = None,
) -> BuildResponse:
    started = time.perf_counter()
    cq = _cadquery()
    built = build_model(
        document,
        validate_pump=validate_pump,
        imported_sources=imported_sources,
    )
    shape = built.shape
    if not shape.isValid():
        built.diagnostics.append(
            Diagnostic(
                code="BREP_INVALID",
                severity="error",
                message="OCCT B-Rep 有效性检查失败。",
            )
        )

    artifact_root = artifact_root.resolve()
    job_dir = (artifact_root / job_id).resolve()
    if artifact_root not in job_dir.parents:
        raise ValueError("invalid job artifact path")
    job_dir.mkdir(parents=True, exist_ok=True)

    artifact_descriptors: list[ArtifactDescriptor] = []
    for artifact_format in formats:
        extension = "glb" if artifact_format == "glb" else artifact_format
        path = job_dir / f"model.{extension}"
        if artifact_format == "step":
            built.assembly.save(str(path), exportType=cq.exporters.ExportTypes.STEP)
        elif artifact_format == "glb":
            # Assembly GLTF is supported by Assembly.save but is intentionally
            # not part of the solid-only exporters.ExportTypes enum.
            built.assembly.save(str(path), exportType="GLTF")
        elif artifact_format == "stl":
            cq.exporters.export(shape, str(path), tolerance=0.02, angularTolerance=0.1)
        else:  # pragma: no cover - validated by Pydantic
            raise ValueError(f"unsupported artifact format: {artifact_format}")
        built.diagnostics.append(_validate_export_readback(cq, artifact_format, path, shape))
        content = path.read_bytes()
        artifact_descriptors.append(
            ArtifactDescriptor(
                kind=artifact_format,
                file_name=path.name,
                content_type={
                    "step": "model/step",
                    "stl": "model/stl",
                    "glb": "model/gltf-binary",
                }[artifact_format],
                size_bytes=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
                download_path=f"/v1/artifacts/{job_id}/{path.name}",
            )
        )

    bounds = shape.BoundingBox()
    center = shape.Center()
    mass_kg, mass_status = _document_mass(document, float(shape.Volume()))
    metrics = BuildMetrics(
        solid_count=len(shape.Solids()),
        volume_mm3=float(shape.Volume()),
        surface_area_mm2=float(shape.Area()),
        bounding_box_mm=(float(bounds.xlen), float(bounds.ylen), float(bounds.zlen)),
        center_of_mass_mm=(float(center.x), float(center.y), float(center.z)),
        mass_kg=mass_kg,
        mass_status=mass_status,
    )
    valid = shape.isValid() and not any(item.severity == "error" for item in built.diagnostics)
    return BuildResponse(
        job_id=job_id,
        model_hash=model_hash(document),
        kernel_version=_kernel_version(cq),
        solver_version="slvs-3.2",
        valid=valid,
        diagnostics=built.diagnostics,
        metrics=metrics,
        artifacts=artifact_descriptors,
        duration_ms=(time.perf_counter() - started) * 1000,
    )


def validate_document(
    job_id: str,
    document: dict[str, Any],
    artifact_root: Path,
    validate_pump: bool,
    imported_sources: dict[str, str] | None = None,
) -> BuildResponse:
    """Validate an editable document even when it intentionally has no solid.

    Sketch-first CAD workflows need an immutable revision before the first
    extrusion exists. In that state SolveSpace is still authoritative, while
    B-Rep metrics and export artifacts are correctly absent. Build/export
    endpoints continue to require at least one unsuppressed solid.
    """

    features = document.get("features")
    components = document.get("components")
    is_protocol_document = (
        document.get("version") == PROTOCOL_VERSION
        and document.get("unitSystem") == "mm-deg"
        and isinstance(features, list)
        and isinstance(components, list)
    )
    if is_protocol_document:
        _validate_protocol_parameter_contract(document)
    has_active_feature = isinstance(features, list) and any(
        isinstance(feature, dict) and feature.get("suppressed") is not True for feature in features
    )
    has_active_component = isinstance(components, list) and any(
        isinstance(component, dict) and component.get("suppressed") is not True
        for component in components
    )
    if not is_protocol_document or has_active_feature or has_active_component:
        return build_to_artifacts(
            job_id,
            document,
            [],
            artifact_root,
            validate_pump,
            imported_sources,
        )

    started = time.perf_counter()
    diagnostics = _authoritative_protocol_sketch_diagnostics(
        document, _protocol_parameter_values(document)
    )
    _fail_on_sketch_errors(diagnostics)
    diagnostics.append(
        Diagnostic(
            code="MODEL_DOCUMENT_NO_SOLID",
            severity="info",
            message="草图/空白文档已通过权威校验；当前尚无可导出的 B-Rep 实体。",
        )
    )
    return BuildResponse(
        job_id=job_id,
        model_hash=model_hash(document),
        kernel_version=_kernel_version(_cadquery()),
        solver_version="slvs-3.2",
        valid=True,
        diagnostics=diagnostics,
        metrics=None,
        artifacts=[],
        duration_ms=(time.perf_counter() - started) * 1000,
    )


def import_step_to_artifacts(
    job_id: str,
    source_path: Path,
    artifact_root: Path,
    formats: Iterable[str] = ("glb",),
) -> StepImportResponse:
    """Import one opaque STEP source as a base entity and produce a GLB preview.

    The source remains a single imported_step feature. Body references are
    geometry fingerprints; no OCCT face or transient array index is exposed as
    editable history.
    """

    started = time.perf_counter()
    cq = _cadquery()
    artifact_root = artifact_root.resolve()
    job_dir = (artifact_root / job_id).resolve()
    source = source_path.resolve()
    if artifact_root not in job_dir.parents or source.parent != job_dir:
        raise ValueError("invalid STEP import path")
    if not source.is_file():
        raise ValueError("STEP import source does not exist")

    source_size = source.stat().st_size
    if source_size <= 0:
        raise ValueError("STEP import source is empty")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    source_sha256 = digest.hexdigest()

    imported = cq.importers.importStep(str(source))
    imported_shapes = list(imported.vals())
    solids = [solid for shape in imported_shapes for solid in shape.Solids()]
    if not solids:
        raise ValueError("STEP source does not contain a closed solid")
    if any(not shape.isValid() for shape in imported_shapes) or any(
        not solid.isValid() or float(solid.Volume()) <= 1e-9 for solid in solids
    ):
        raise ValueError("STEP source contains an invalid or non-volumetric B-Rep")

    fingerprinted = sorted(
        ((_solid_fingerprint(solid), solid) for solid in solids),
        key=lambda item: item[0],
    )
    body_semantic_refs = [
        f"import.body.{source_sha256[:12]}.{fingerprint[:12]}.{ordinal}"
        for ordinal, (fingerprint, _) in enumerate(fingerprinted, start=1)
    ]
    assembly = cq.Assembly(name="Imported STEP")
    for semantic_ref, (_, solid) in zip(body_semantic_refs, fingerprinted):
        assembly.add(solid, name=semantic_ref, color=cq.Color(0.64, 0.67, 0.68))
    compound = cq.Compound.makeCompound([solid for _, solid in fingerprinted])
    if not compound.isValid():
        raise ValueError("STEP compound failed OCCT validity checking")

    requested_formats = list(dict.fromkeys(formats))
    if not requested_formats or any(
        artifact_format not in {"stl", "glb"} for artifact_format in requested_formats
    ):
        raise ValueError("STEP conversion formats must be STL or GLB")
    artifact_descriptors: list[ArtifactDescriptor] = []
    for artifact_format in requested_formats:
        output_path = job_dir / f"model.{artifact_format}"
        if artifact_format == "glb":
            assembly.save(str(output_path), exportType="GLTF")
        else:
            cq.exporters.export(
                compound,
                str(output_path),
                tolerance=0.02,
                angularTolerance=0.1,
            )
        content = output_path.read_bytes()
        if artifact_format == "glb" and (
            len(content) < 12
            or content[:4] != b"glTF"
            or int.from_bytes(content[4:8], "little") != 2
            or int.from_bytes(content[8:12], "little") != len(content)
        ):
            raise ValueError("STEP import GLB preview failed read-back validation")
        if artifact_format == "stl" and len(content) < 84:
            raise ValueError("STEP import STL conversion is empty")
        artifact_descriptors.append(
            ArtifactDescriptor(
                kind=artifact_format,
                file_name=output_path.name,
                content_type={
                    "stl": "model/stl",
                    "glb": "model/gltf-binary",
                }[artifact_format],
                size_bytes=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
                download_path=f"/v1/artifacts/{job_id}/{output_path.name}",
            )
        )

    bounds = compound.BoundingBox()
    center = compound.Center()
    metrics = BuildMetrics(
        solid_count=len(solids),
        volume_mm3=float(compound.Volume()),
        surface_area_mm2=float(compound.Area()),
        bounding_box_mm=(float(bounds.xlen), float(bounds.ylen), float(bounds.zlen)),
        center_of_mass_mm=(float(center.x), float(center.y), float(center.z)),
        mass_kg=None,
        mass_status="unavailable_density_required",
    )
    return StepImportResponse(
        job_id=job_id,
        source_sha256=source_sha256,
        source_size_bytes=source_size,
        kernel_version=_kernel_version(cq),
        valid=True,
        diagnostics=[
            Diagnostic(
                code="STEP_IMPORT_VALID",
                severity="info",
                message=f"STEP 导入形成 {len(solids)} 个有效闭合实体。",
            )
        ],
        metrics=metrics,
        body_semantic_refs=body_semantic_refs,
        artifacts=artifact_descriptors,
        duration_ms=(time.perf_counter() - started) * 1000,
    )


def _solid_fingerprint(solid: Any) -> str:
    bounds = solid.BoundingBox()
    center = solid.Center()
    payload = {
        "volume": round(float(solid.Volume()), 9),
        "area": round(float(solid.Area()), 9),
        "bounds": [
            round(float(bounds.xmin), 9),
            round(float(bounds.ymin), 9),
            round(float(bounds.zmin), 9),
            round(float(bounds.xmax), 9),
            round(float(bounds.ymax), 9),
            round(float(bounds.zmax), 9),
        ],
        "center": [
            round(float(center.x), 9),
            round(float(center.y), 9),
            round(float(center.z), 9),
        ],
    }
    return hashlib.sha256(canonical_json(payload).encode()).hexdigest()


def _profile_workplane(cq: Any, profile: dict[str, Any]):
    kind = str(profile.get("kind", ""))
    if kind == "rectangle":
        return cq.Workplane("XY").rect(_number(profile, "width"), _number(profile, "height"))
    if kind == "circle":
        return cq.Workplane("XY").circle(_number(profile, "diameter") / 2)
    if kind == "ring":
        outer = _number(profile, "outerDiameter") / 2
        inner = _number(profile, "innerDiameter") / 2
        if inner >= outer:
            raise ValueError("ring innerDiameter must be smaller than outerDiameter")
        return cq.Workplane("XY").circle(outer).circle(inner)
    if kind == "polygon":
        points = profile.get("points")
        if not isinstance(points, list) or len(points) < 3:
            raise ValueError("polygon profile requires at least three points")
        return cq.Workplane("XY").polyline([tuple(point) for point in points]).close()
    raise ValueError(f"unsupported profile kind: {kind}")


def _combine(current: Any | None, shape: Any, operation: str):
    if current is None or operation in {"new", "replace"}:
        return shape
    if operation in {"join", "union", "add"}:
        return current.union(shape)
    if operation in {"cut", "subtract"}:
        return current.cut(shape)
    if operation in {"intersect", "common"}:
        return current.intersect(shape)
    raise ValueError(f"unsupported feature operation: {operation}")


def _union_shapes(shapes: list[Any]) -> Any:
    if not shapes:
        raise ValueError("feature source references cannot be empty")
    result = shapes[0]
    for shape in shapes[1:]:
        result = result.union(shape)
    return result


def _number(values: dict[str, Any], key: str) -> float:
    value = values.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{key} must be a finite number")
    if value <= 0:
        raise ValueError(f"{key} must be positive")
    return float(value)


def _positive_int(values: dict[str, Any], key: str, maximum: int) -> int:
    value = values.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum:
        raise ValueError(f"{key} must be an integer between 1 and {maximum}")
    return value


def _edge_selector(value: str) -> str | None:
    return {
        "all": None,
        "vertical": "|Z",
        "top": ">Z",
        "bottom": "<Z",
        "parallel_x": "|X",
        "parallel_y": "|Y",
        "parallel_z": "|Z",
    }.get(value)


def _face_selector(value: str) -> str:
    selector = {"top": ">Z", "bottom": "<Z", "front": "<Y", "back": ">Y"}.get(value)
    if selector is None:
        raise ValueError("face selector must be a semantic name")
    return selector
