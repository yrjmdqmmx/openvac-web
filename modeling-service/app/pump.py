from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .models import Diagnostic, PumpParameters, PumpValidationResult
from .pump_geometry import PumpBrepValidation, resolved_cover_dimensions, validate_pump_brep


DEFAULT_PUMP_PARAMETERS = PumpParameters(
    chamber_diameter=100,
    rotor_diameter=80,
    eccentricity=6,
    axial_width=60,
    vane_count=2,
    vane_thickness=4,
    vane_height=26,
    shaft_diameter=20,
    inlet_width=18,
    outlet_width=16,
    tip_clearance=0.15,
)


_PARAMETER_ALIASES = {
    "chamberDiameter": "chamber_diameter",
    "rotorDiameter": "rotor_diameter",
    "eccentricity": "eccentricity",
    "axialWidth": "axial_width",
    "vaneCount": "vane_count",
    "vaneThickness": "vane_thickness",
    "vaneHeight": "vane_height",
    "shaftDiameter": "shaft_diameter",
    "inletWidth": "inlet_width",
    "outletWidth": "outlet_width",
    "tipClearance": "tip_clearance",
    "coverOuterDiameter": "cover_outer_diameter",
    "coverThickness": "cover_thickness",
    "coverBoreDiameter": "cover_bore_diameter",
}

_BOUNDARY_TOLERANCE_DEGREES = 1e-7
_GEOMETRY_TOLERANCE_MM = 1e-8
_PORT_CENTERS_DEGREES = {"inlet": 225.0, "outlet": 45.0}


@dataclass(frozen=True)
class PumpSample:
    angle_degrees: float
    wall_distance_mm: float
    radial_clearance_mm: float
    vane_extension_mm: float
    vane_tip_gap_mm: float
    vane_engagement_mm: float
    collision_margin_mm: float
    collision_boundary: bool = False


@dataclass(frozen=True)
class _RotationMetrics:
    samples: list[PumpSample]
    sampling_step_degrees: float
    collision_boundaries_degrees: list[float]
    cavity_volume_min_mm3: float
    cavity_volume_max_mm3: float
    geometric_void_volume_mm3: float
    inlet_open_samples: int
    outlet_open_samples: int
    port_same_chamber_samples: int
    port_isolation_margin_degrees: float


@lru_cache(maxsize=64)
def _cached_brep_validation(parameters_json: str, full_rotation: bool) -> PumpBrepValidation:
    return validate_pump_brep(
        PumpParameters.model_validate_json(parameters_json),
        full_rotation=full_rotation,
    )


def parameters_from_document(document: dict[str, Any]) -> PumpParameters:
    values = DEFAULT_PUMP_PARAMETERS.model_dump()
    raw_parameters = document.get("parameters", {})
    if isinstance(raw_parameters, list):
        raw_parameters = {
            str(item.get("key") or item.get("name") or item.get("id")): item.get("value")
            for item in raw_parameters
            if isinstance(item, dict)
        }
    if not isinstance(raw_parameters, dict):
        raise ValueError("document.parameters must be an object or parameter list")

    for raw_key, raw_value in raw_parameters.items():
        key = _PARAMETER_ALIASES.get(str(raw_key), str(raw_key))
        if key in values and isinstance(raw_value, dict):
            raw_value = raw_value.get("value")
        if (
            key in values
            and isinstance(raw_value, (int, float))
            and not isinstance(raw_value, bool)
        ):
            values[key] = raw_value
    return PumpParameters.model_validate(values)


def _wall_distance(parameters: PumpParameters, angle_degrees: float) -> float:
    chamber_radius = parameters.chamber_diameter / 2
    radians = math.radians(angle_degrees)
    discriminant = chamber_radius**2 - (parameters.eccentricity * math.sin(radians)) ** 2
    if discriminant < -_GEOMETRY_TOLERANCE_MM:
        return float("nan")
    return -parameters.eccentricity * math.cos(radians) + math.sqrt(max(0.0, discriminant))


def _required_embedded_length(parameters: PumpParameters) -> float:
    return max(2.0, parameters.rotor_diameter * 0.1)


def _sample_at_angle(
    parameters: PumpParameters,
    angle_degrees: float,
    *,
    collision_boundary: bool = False,
) -> PumpSample:
    rotor_radius = parameters.rotor_diameter / 2
    wall_distance = _wall_distance(parameters, angle_degrees)
    radial_clearance = wall_distance - rotor_radius
    required_extension = radial_clearance - parameters.tip_clearance
    maximum_extension = max(0.0, parameters.vane_height - _required_embedded_length(parameters))
    actual_extension = min(maximum_extension, max(0.0, required_extension))
    tip_gap = radial_clearance - actual_extension
    engagement = parameters.vane_height - required_extension
    return PumpSample(
        angle_degrees=angle_degrees % 360.0,
        wall_distance_mm=wall_distance,
        radial_clearance_mm=radial_clearance,
        vane_extension_mm=required_extension,
        vane_tip_gap_mm=tip_gap,
        vane_engagement_mm=engagement,
        collision_margin_mm=radial_clearance - parameters.tip_clearance,
        collision_boundary=collision_boundary,
    )


def _bisect_collision_boundary(
    parameters: PumpParameters,
    low_degrees: float,
    high_degrees: float,
) -> float:
    low_margin = _sample_at_angle(parameters, low_degrees).collision_margin_mm
    high_margin = _sample_at_angle(parameters, high_degrees).collision_margin_mm
    if low_margin == 0:
        return low_degrees % 360.0
    if high_margin == 0:
        return high_degrees % 360.0
    if low_margin * high_margin > 0:
        raise ValueError("collision boundary refinement requires a bracketed sign change")

    low = low_degrees
    high = high_degrees
    for _iteration in range(80):
        midpoint = (low + high) / 2
        midpoint_margin = _sample_at_angle(parameters, midpoint).collision_margin_mm
        if (
            abs(midpoint_margin) <= _GEOMETRY_TOLERANCE_MM
            or high - low <= _BOUNDARY_TOLERANCE_DEGREES
        ):
            return midpoint % 360.0
        if low_margin * midpoint_margin <= 0:
            high = midpoint
            high_margin = midpoint_margin
        else:
            low = midpoint
            low_margin = midpoint_margin
    return ((low + high) / 2) % 360.0


def sample_rotor_clearance(
    parameters: PumpParameters, step_degrees: float = 1.0
) -> list[PumpSample]:
    """Sample a complete rotation and refine every bracketed collision boundary.

    The uniform grid is normalized so its circular maximum step never exceeds
    ``step_degrees``. A sign change of rotor-clearance minus required tip gap is
    refined by bisection and inserted as an additional marked sample.
    """

    if step_degrees <= 0 or step_degrees > 1:
        raise ValueError("step_degrees must be in (0, 1]")
    grid_count = math.ceil(360.0 / step_degrees)
    actual_step = 360.0 / grid_count
    grid = [_sample_at_angle(parameters, index * actual_step) for index in range(grid_count)]
    boundaries: list[float] = []
    for index, left in enumerate(grid):
        right_angle = grid[index + 1].angle_degrees if index + 1 < len(grid) else 360.0
        right_margin = _sample_at_angle(parameters, right_angle).collision_margin_mm
        if abs(left.collision_margin_mm) <= _GEOMETRY_TOLERANCE_MM:
            boundaries.append(left.angle_degrees)
        elif left.collision_margin_mm * right_margin < 0:
            boundaries.append(
                _bisect_collision_boundary(parameters, left.angle_degrees, right_angle)
            )

    unique_boundaries: list[float] = []
    for angle in sorted(boundaries):
        if not unique_boundaries or abs(angle - unique_boundaries[-1]) > 1e-6:
            unique_boundaries.append(angle)

    by_angle = {round(sample.angle_degrees, 9): sample for sample in grid}
    for angle in unique_boundaries:
        by_angle[round(angle, 9)] = _sample_at_angle(parameters, angle, collision_boundary=True)
    return [by_angle[key] for key in sorted(by_angle)]


def _cavity_cross_section_area(parameters: PumpParameters, start_angle_degrees: float) -> float:
    """Deterministic polar quadrature for one inter-vane chamber area."""

    rotor_radius = parameters.rotor_diameter / 2
    span_degrees = 360.0 / parameters.vane_count
    subdivisions = max(2, math.ceil(span_degrees / 0.25))
    if subdivisions % 2:
        subdivisions += 1
    step = math.radians(span_degrees / subdivisions)

    def density(index: int) -> float:
        angle = start_angle_degrees + index * span_degrees / subdivisions
        wall = _wall_distance(parameters, angle)
        return max(0.0, 0.5 * (wall**2 - rotor_radius**2))

    total = density(0) + density(subdivisions)
    total += 4 * sum(density(index) for index in range(1, subdivisions, 2))
    total += 2 * sum(density(index) for index in range(2, subdivisions, 2))
    return total * step / 3


def _angular_distance_degrees(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def _port_is_open(
    parameters: PumpParameters,
    rotor_angle_degrees: float,
    port_center_degrees: float,
    port_width_mm: float,
) -> bool:
    chamber_radius = parameters.chamber_diameter / 2
    rotor_radius = parameters.rotor_diameter / 2
    port_half_span = math.degrees(port_width_mm / chamber_radius) / 2
    vane_half_span = math.degrees(
        math.asin(min(1.0, parameters.vane_thickness / (2 * rotor_radius)))
    )
    return all(
        _angular_distance_degrees(
            port_center_degrees,
            rotor_angle_degrees + index * 360.0 / parameters.vane_count,
        )
        > port_half_span + vane_half_span
        for index in range(parameters.vane_count)
    )


def _port_cell(
    parameters: PumpParameters, rotor_angle_degrees: float, port_angle_degrees: float
) -> int:
    span = 360.0 / parameters.vane_count
    return int(((port_angle_degrees - rotor_angle_degrees) % 360.0) // span)


def _analyze_rotation(parameters: PumpParameters, step_degrees: float = 1.0) -> _RotationMetrics:
    samples = sample_rotor_clearance(parameters, step_degrees=step_degrees)
    grid_count = math.ceil(360.0 / step_degrees)
    actual_step = 360.0 / grid_count
    grid_angles = [index * actual_step for index in range(grid_count)]
    cavity_volumes = [
        _cavity_cross_section_area(parameters, angle) * parameters.axial_width
        for angle in grid_angles
    ]
    chamber_radius = parameters.chamber_diameter / 2
    rotor_radius = parameters.rotor_diameter / 2
    geometric_void = math.pi * (chamber_radius**2 - rotor_radius**2) * parameters.axial_width

    inlet_open = 0
    outlet_open = 0
    same_chamber = 0
    for angle in grid_angles:
        inlet_is_open = _port_is_open(
            parameters,
            angle,
            _PORT_CENTERS_DEGREES["inlet"],
            parameters.inlet_width,
        )
        outlet_is_open = _port_is_open(
            parameters,
            angle,
            _PORT_CENTERS_DEGREES["outlet"],
            parameters.outlet_width,
        )
        inlet_open += int(inlet_is_open)
        outlet_open += int(outlet_is_open)
        if (
            inlet_is_open
            and outlet_is_open
            and _port_cell(parameters, angle, _PORT_CENTERS_DEGREES["inlet"])
            == _port_cell(parameters, angle, _PORT_CENTERS_DEGREES["outlet"])
        ):
            same_chamber += 1

    inlet_half_span = math.degrees(parameters.inlet_width / chamber_radius) / 2
    outlet_half_span = math.degrees(parameters.outlet_width / chamber_radius) / 2
    vane_half_span = math.degrees(
        math.asin(min(1.0, parameters.vane_thickness / (2 * rotor_radius)))
    )
    center_separation = _angular_distance_degrees(
        _PORT_CENTERS_DEGREES["inlet"], _PORT_CENTERS_DEGREES["outlet"]
    )
    isolation_margin = center_separation - inlet_half_span - outlet_half_span - 2 * vane_half_span
    return _RotationMetrics(
        samples=samples,
        sampling_step_degrees=actual_step,
        collision_boundaries_degrees=[
            sample.angle_degrees for sample in samples if sample.collision_boundary
        ],
        cavity_volume_min_mm3=min(cavity_volumes, default=float("nan")),
        cavity_volume_max_mm3=max(cavity_volumes, default=float("nan")),
        geometric_void_volume_mm3=geometric_void,
        inlet_open_samples=inlet_open,
        outlet_open_samples=outlet_open,
        port_same_chamber_samples=same_chamber,
        port_isolation_margin_degrees=isolation_margin,
    )


def validate_rotary_vane_pump(parameters: PumpParameters) -> PumpValidationResult:
    diagnostics: list[Diagnostic] = []
    chamber_radius = parameters.chamber_diameter / 2
    rotor_radius = parameters.rotor_diameter / 2
    shaft_radius = parameters.shaft_diameter / 2
    minimum_clearance = chamber_radius - parameters.eccentricity - rotor_radius
    maximum_clearance = chamber_radius + parameters.eccentricity - rotor_radius

    if parameters.vane_count != 2:
        diagnostics.append(
            Diagnostic(
                code="PUMP_REQUIRES_DOUBLE_VANE",
                severity="error",
                message="OpenVac V1 原创模板只验证双滑片结构。",
                target_id="vaneCount",
            )
        )
    if parameters.eccentricity <= 0:
        diagnostics.append(
            Diagnostic(
                code="PUMP_ZERO_ECCENTRICITY",
                severity="error",
                message="偏心量必须大于零，否则腔体容积不会发生周期变化。",
                target_id="eccentricity",
            )
        )
    if parameters.rotor_diameter >= parameters.chamber_diameter:
        diagnostics.append(
            Diagnostic(
                code="PUMP_ROTOR_NOT_SMALLER_THAN_CHAMBER",
                severity="error",
                message="转子直径必须小于泵腔直径。",
                target_id="rotorDiameter",
            )
        )
    if minimum_clearance <= parameters.tip_clearance:
        diagnostics.append(
            Diagnostic(
                code="PUMP_ROTOR_CHAMBER_INTERFERENCE",
                severity="error",
                message="偏心转子包络侵入滑片端部的最小设计间隙。",
                target_id="eccentricity",
            )
        )
    if parameters.shaft_diameter >= parameters.rotor_diameter:
        diagnostics.append(
            Diagnostic(
                code="PUMP_SHAFT_TOO_LARGE",
                severity="error",
                message="主轴直径必须小于转子直径。",
                target_id="shaftDiameter",
            )
        )
    if parameters.vane_thickness >= rotor_radius / 3:
        diagnostics.append(
            Diagnostic(
                code="PUMP_VANE_TOO_THICK",
                severity="error",
                message="滑片厚度相对转子半径过大。",
                target_id="vaneThickness",
            )
        )

    cover_dimensions = resolved_cover_dimensions(parameters)
    if cover_dimensions.cover_outer_radius_mm <= chamber_radius:
        diagnostics.append(
            Diagnostic(
                code="PUMP_COVER_TOO_SMALL",
                severity="error",
                message="端盖外径必须覆盖泵腔及壳体密封面。",
                target_id="coverOuterDiameter",
            )
        )
    if cover_dimensions.cover_bore_radius_mm <= shaft_radius:
        diagnostics.append(
            Diagnostic(
                code="PUMP_COVER_BORE_TOO_SMALL",
                severity="error",
                message="端盖偏心轴孔必须为主轴保留正间隙。",
                target_id="coverBoreDiameter",
            )
        )
    if (
        parameters.eccentricity + cover_dimensions.cover_bore_radius_mm
        >= cover_dimensions.cover_outer_radius_mm
    ):
        diagnostics.append(
            Diagnostic(
                code="PUMP_COVER_BORE_BREAKS_OUT",
                severity="error",
                message="端盖偏心轴孔超出端盖外圆。",
                target_id="coverBoreDiameter",
            )
        )

    rotation = _analyze_rotation(parameters)
    finite_samples = [
        sample for sample in rotation.samples if math.isfinite(sample.vane_extension_mm)
    ]
    vane_min = min(
        (sample.vane_extension_mm for sample in finite_samples),
        default=float("nan"),
    )
    vane_max = max(
        (sample.vane_extension_mm for sample in finite_samples),
        default=float("nan"),
    )
    tip_gap_min = min(
        (sample.vane_tip_gap_mm for sample in finite_samples),
        default=float("nan"),
    )
    tip_gap_max = max(
        (sample.vane_tip_gap_mm for sample in finite_samples),
        default=float("nan"),
    )
    engagement_min = min(
        (sample.vane_engagement_mm for sample in finite_samples),
        default=float("nan"),
    )
    engagement_max = max(
        (sample.vane_engagement_mm for sample in finite_samples),
        default=float("nan"),
    )
    required_engagement = _required_embedded_length(parameters)
    available_slot_depth = rotor_radius - shaft_radius

    if not finite_samples:
        diagnostics.append(
            Diagnostic(
                code="PUMP_CLEARANCE_UNSOLVABLE",
                severity="error",
                message="无法计算滑片与泵腔的整周交点。",
            )
        )
    else:
        if engagement_min < required_engagement - _GEOMETRY_TOLERANCE_MM:
            diagnostics.append(
                Diagnostic(
                    code="PUMP_VANE_ENGAGEMENT_INSUFFICIENT",
                    severity="error",
                    message="滑片高度不足，最大伸出位置无法保持规定的槽内啮合。",
                    target_id="vaneHeight",
                )
            )
        if engagement_max > available_slot_depth + _GEOMETRY_TOLERANCE_MM:
            diagnostics.append(
                Diagnostic(
                    code="PUMP_VANE_ROOT_SHAFT_INTERFERENCE",
                    severity="error",
                    message="滑片最大回缩量超过转子槽深并侵入主轴包络。",
                    target_id="vaneHeight",
                )
            )
        if tip_gap_max > parameters.tip_clearance + _GEOMETRY_TOLERANCE_MM:
            diagnostics.append(
                Diagnostic(
                    code="PUMP_VANE_CONTACT_LOST",
                    severity="error",
                    message="至少一个整周角度无法维持规定的滑片端部间隙。",
                    target_id="vaneHeight",
                )
            )

    if rotation.collision_boundaries_degrees:
        diagnostics.append(
            Diagnostic(
                code="PUMP_COLLISION_BOUNDARY_REFINED",
                severity="error",
                message=("检测到转子间隙符号变化，并已通过二分法细化碰撞边界角度。"),
                target_id="eccentricity",
            )
        )

    if rotation.port_isolation_margin_degrees <= 0:
        diagnostics.append(
            Diagnostic(
                code="PUMP_PORTS_NOT_ISOLATED",
                severity="error",
                message="进排气口与滑片扫掠宽度未保留独立密封弧。",
                target_id="inletWidth",
            )
        )
    elif rotation.port_same_chamber_samples > 0:
        diagnostics.append(
            Diagnostic(
                code="PUMP_PORTS_SHARE_CHAMBER",
                severity="error",
                message="整周采样发现进排气口同时连通同一工作腔。",
            )
        )
    elif rotation.inlet_open_samples == 0 or rotation.outlet_open_samples == 0:
        diagnostics.append(
            Diagnostic(
                code="PUMP_PORT_NEVER_OPENS",
                severity="error",
                message="进气口或排气口在整周运动中没有有效连通窗口。",
            )
        )
    else:
        diagnostics.append(
            Diagnostic(
                code="PUMP_ANALYTIC_PORT_TIMING_VALID",
                severity="info",
                message="固定端口角度的解析密封弧预检通过，最终连通性由 OCCT 实体检查判定。",
            )
        )

    cavity_delta = rotation.cavity_volume_max_mm3 - rotation.cavity_volume_min_mm3
    if cavity_delta <= max(1e-6, rotation.geometric_void_volume_mm3 * 1e-9):
        diagnostics.append(
            Diagnostic(
                code="PUMP_NO_CAVITY_VOLUME_CHANGE",
                severity="error",
                message="工作腔容积在整周内没有可辨识的周期变化。",
                target_id="eccentricity",
            )
        )
    else:
        diagnostics.append(
            Diagnostic(
                code="PUMP_CAVITY_VOLUME_VARIATION_VALID",
                severity="info",
                message=("工作腔容积变化由确定性极坐标几何积分得到；该值不是流量或 CFD。"),
            )
        )

    swept_volume = cavity_delta * parameters.vane_count
    brep: PumpBrepValidation | None = None
    try:
        brep = _cached_brep_validation(
            parameters.model_dump_json(),
            not any(item.severity == "error" for item in diagnostics),
        )
        diagnostics.extend(brep.diagnostics)
    except Exception as exc:  # noqa: BLE001 - convert native kernel failure to a diagnostic
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_CHECK_FAILED",
                severity="error",
                message=f"OCCT B-Rep 校验未完成：{type(exc).__name__}。",
            )
        )

    if (
        brep is not None
        and brep.inlet_passage_connected
        and brep.outlet_passage_connected
        and brep.inlet_open_samples > 0
        and brep.outlet_open_samples > 0
        and brep.port_same_chamber_samples == 0
    ):
        diagnostics.append(
            Diagnostic(
                code="PUMP_PORT_CONNECTIVITY_VALID",
                severity="info",
                message=(
                    "OCCT 实体求交确认进排气通道均从外壳贯穿至泵腔，且整周开闭未直通同一工作腔。"
                ),
            )
        )

    if not any(item.severity == "error" for item in diagnostics):
        diagnostics.append(
            Diagnostic(
                code="PUMP_GEOMETRY_VALID",
                severity="info",
                message=("解析几何与逐角度 OCCT B-Rep 360° 检查通过；结果是几何校验，不是 CFD。"),
            )
        )

    analytic_boundaries = rotation.collision_boundaries_degrees
    brep_boundaries = list(brep.collision_boundary_angles_degrees) if brep is not None else []
    collision_boundaries = sorted(
        {round(angle % 360.0, 7) for angle in [*analytic_boundaries, *brep_boundaries]}
    )

    return PumpValidationResult(
        valid=not any(item.severity == "error" for item in diagnostics),
        diagnostics=diagnostics,
        analysis_method="deterministic_analytic_geometry_with_occt_brep",
        cavity_volume_method="deterministic_polar_quadrature",
        brep_sampling_step_degrees=(brep.sampling_step_degrees if brep is not None else 1.0),
        brep_samples=brep.samples if brep is not None else 0,
        brep_collision_boundary_angles_degrees=brep_boundaries,
        brep_rotor_housing_clearance_min_mm=(
            brep.rotor_housing_clearance_min_mm if brep is not None else 0.0
        ),
        brep_vane_housing_clearance_min_mm=(
            brep.vane_housing_clearance_min_mm if brep is not None else 0.0
        ),
        brep_vane_shaft_clearance_min_mm=(
            brep.vane_shaft_clearance_min_mm if brep is not None else 0.0
        ),
        brep_rotating_group_interference_max_mm3=(
            brep.rotating_group_interference_max_mm3 if brep is not None else 0.0
        ),
        inlet_passage_connected=(brep.inlet_passage_connected if brep else False),
        outlet_passage_connected=(brep.outlet_passage_connected if brep else False),
        inlet_passage_removed_volume_mm3=(
            brep.inlet_passage_removed_volume_mm3 if brep is not None else 0.0
        ),
        outlet_passage_removed_volume_mm3=(
            brep.outlet_passage_removed_volume_mm3 if brep is not None else 0.0
        ),
        radial_clearance_min_mm=minimum_clearance,
        radial_clearance_max_mm=maximum_clearance,
        vane_extension_min_mm=vane_min,
        vane_extension_max_mm=vane_max,
        vane_tip_gap_min_mm=tip_gap_min,
        vane_tip_gap_max_mm=tip_gap_max,
        vane_engagement_min_mm=engagement_min,
        vane_engagement_max_mm=engagement_max,
        cavity_volume_min_mm3=rotation.cavity_volume_min_mm3,
        cavity_volume_max_mm3=rotation.cavity_volume_max_mm3,
        cavity_volume_delta_mm3=cavity_delta,
        geometric_void_volume_mm3=rotation.geometric_void_volume_mm3,
        swept_volume_estimate_mm3=swept_volume,
        inlet_open_samples=(brep.inlet_open_samples if brep else 0),
        outlet_open_samples=(brep.outlet_open_samples if brep else 0),
        port_same_chamber_samples=(brep.port_same_chamber_samples if brep else 0),
        port_isolation_margin_degrees=rotation.port_isolation_margin_degrees,
        sampling_step_degrees=rotation.sampling_step_degrees,
        collision_boundary_angles_degrees=collision_boundaries,
        samples=len(rotation.samples),
    )
