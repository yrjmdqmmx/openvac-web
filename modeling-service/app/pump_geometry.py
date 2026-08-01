from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .models import Diagnostic, PumpParameters


_GEOMETRY_TOLERANCE_MM = 1e-7
_VOLUME_TOLERANCE_MM3 = 1e-7
_PORT_CENTERS_DEGREES = {"inlet": 225.0, "outlet": 45.0}


def _cadquery() -> Any:
    try:
        # Keep the same import order as the build engine. Importing CadQuery
        # first can enter an OCP/VTK loader cycle on macOS arm64.
        import vtk  # noqa: F401
        import cadquery as cq
    except ImportError as exc:  # pragma: no cover - readiness covers production
        raise RuntimeError("CadQuery/OCP is not installed in the modeling service") from exc
    return cq


@dataclass(frozen=True)
class PumpCoverDimensions:
    wall_thickness_mm: float
    housing_outer_radius_mm: float
    cover_outer_radius_mm: float
    cover_thickness_mm: float
    cover_bore_radius_mm: float


@dataclass(frozen=True)
class PumpPortBrep:
    role: str
    center_angle_degrees: float
    cutter: Any
    flow_probe: Any
    chamber_throat: Any
    removed_volume_mm3: float
    chamber_overlap_volume_mm3: float
    exterior_overlap_volume_mm3: float
    residual_blockage_volume_mm3: float

    @property
    def connected(self) -> bool:
        return (
            self.removed_volume_mm3 > _VOLUME_TOLERANCE_MM3
            and self.chamber_overlap_volume_mm3 > _VOLUME_TOLERANCE_MM3
            and self.exterior_overlap_volume_mm3 > _VOLUME_TOLERANCE_MM3
            and self.residual_blockage_volume_mm3 <= _VOLUME_TOLERANCE_MM3
        )


@dataclass(frozen=True)
class PumpBrepGeometry:
    raw_housing: Any
    chamber_wall: Any
    housing: Any
    rotor: Any
    shaft: Any
    front_cover: Any
    rear_cover: Any
    vanes: tuple[Any, ...]
    ports: tuple[PumpPortBrep, ...]
    cover_dimensions: PumpCoverDimensions


@dataclass(frozen=True)
class PumpBrepValidation:
    diagnostics: tuple[Diagnostic, ...]
    sampling_step_degrees: float
    samples: int
    collision_boundary_angles_degrees: tuple[float, ...]
    rotor_housing_clearance_min_mm: float
    vane_housing_clearance_min_mm: float
    vane_shaft_clearance_min_mm: float
    rotating_group_interference_max_mm3: float
    inlet_open_samples: int
    outlet_open_samples: int
    port_same_chamber_samples: int
    inlet_passage_connected: bool
    outlet_passage_connected: bool
    inlet_passage_removed_volume_mm3: float
    outlet_passage_removed_volume_mm3: float


def resolved_cover_dimensions(parameters: PumpParameters) -> PumpCoverDimensions:
    wall = max(6.0, parameters.chamber_diameter * 0.09)
    housing_outer_radius = parameters.chamber_diameter / 2 + wall
    derived_outer_diameter = housing_outer_radius * 2
    derived_thickness = max(5.0, wall * 0.75)
    derived_bore_diameter = parameters.shaft_diameter + 2.0
    return PumpCoverDimensions(
        wall_thickness_mm=wall,
        housing_outer_radius_mm=housing_outer_radius,
        cover_outer_radius_mm=(parameters.cover_outer_diameter or derived_outer_diameter) / 2,
        cover_thickness_mm=parameters.cover_thickness or derived_thickness,
        cover_bore_radius_mm=(parameters.cover_bore_diameter or derived_bore_diameter) / 2,
    )


def _shape(value: Any) -> Any:
    return value.val() if hasattr(value, "val") else value


def _volume(value: Any) -> float:
    return float(_shape(value).Volume())


def _intersection_volume(left: Any, right: Any) -> float:
    return _volume(left.intersect(right))


def _distance(left: Any, right: Any) -> float:
    return float(_shape(left).distance(_shape(right)))


def _radial_cylinder(
    cq: Any,
    *,
    angle_degrees: float,
    radius_mm: float,
    start_radius_mm: float,
    length_mm: float,
    axial_center_mm: float,
) -> Any:
    angle = math.radians(angle_degrees)
    direction = cq.Vector(math.cos(angle), math.sin(angle), 0)
    start = cq.Vector(
        direction.x * start_radius_mm,
        direction.y * start_radius_mm,
        axial_center_mm,
    )
    return cq.Workplane(obj=cq.Solid.makeCylinder(radius_mm, length_mm, start, direction))


def _build_port_cutters(
    cq: Any,
    parameters: PumpParameters,
    dimensions: PumpCoverDimensions,
) -> list[tuple[str, float, Any, Any, Any, Any]]:
    chamber_radius = parameters.chamber_diameter / 2
    axial_center = parameters.axial_width / 2
    exterior_radius = dimensions.housing_outer_radius_mm + dimensions.wall_thickness_mm
    ports: list[tuple[str, float, Any, Any, Any, Any]] = []
    for role, width in (
        ("inlet", parameters.inlet_width),
        ("outlet", parameters.outlet_width),
    ):
        angle = _PORT_CENTERS_DEGREES[role]
        port_radius = width / 2
        start_radius = chamber_radius - max(2.0, port_radius * 0.75)
        length = exterior_radius - start_radius
        cutter = _radial_cylinder(
            cq,
            angle_degrees=angle,
            radius_mm=port_radius,
            start_radius_mm=start_radius,
            length_mm=length,
            axial_center_mm=axial_center,
        )
        flow_probe = _radial_cylinder(
            cq,
            angle_degrees=angle,
            radius_mm=max(0.5, port_radius * 0.3),
            start_radius_mm=start_radius + 0.25,
            length_mm=max(0.5, length - 0.5),
            axial_center_mm=axial_center,
        )
        throat_start = chamber_radius - max(2.0, port_radius * 0.65)
        throat = _radial_cylinder(
            cq,
            angle_degrees=angle,
            radius_mm=max(0.5, min(port_radius * 0.55, parameters.axial_width * 0.1)),
            start_radius_mm=throat_start,
            length_mm=max(2.0, port_radius * 0.9),
            axial_center_mm=axial_center,
        )
        exterior_probe = _radial_cylinder(
            cq,
            angle_degrees=angle,
            radius_mm=max(0.5, port_radius * 0.3),
            start_radius_mm=dimensions.housing_outer_radius_mm + 0.25,
            length_mm=max(0.5, dimensions.wall_thickness_mm * 0.75),
            axial_center_mm=axial_center,
        )
        ports.append((role, angle, cutter, flow_probe, throat, exterior_probe))
    return ports


def _offset_wall_distance(
    parameters: PumpParameters,
    angle_degrees: float,
    tangential_offset_mm: float,
) -> float:
    """Ray distance from the eccentric rotor center at a tangential offset."""

    angle = math.radians(angle_degrees)
    radial = (math.cos(angle), math.sin(angle))
    tangent = (-radial[1], radial[0])
    origin = (
        parameters.eccentricity + tangent[0] * tangential_offset_mm,
        tangent[1] * tangential_offset_mm,
    )
    projection = origin[0] * radial[0] + origin[1] * radial[1]
    discriminant = (
        projection**2 + (parameters.chamber_diameter / 2) ** 2 - (origin[0] ** 2 + origin[1] ** 2)
    )
    if discriminant < -_GEOMETRY_TOLERANCE_MM:
        return float("nan")
    return -projection + math.sqrt(max(0.0, discriminant))


def _build_vanes(
    cq: Any, parameters: PumpParameters, rotor_angle_degrees: float
) -> tuple[Any, ...]:
    axial_height = max(0.001, parameters.axial_width - 2.0)
    half_thickness = parameters.vane_thickness / 2
    vanes: list[Any] = []
    for index in range(parameters.vane_count):
        angle = rotor_angle_degrees + index * 360.0 / parameters.vane_count
        corner_wall_distances = (
            _offset_wall_distance(parameters, angle, -half_thickness),
            _offset_wall_distance(parameters, angle, half_thickness),
        )
        finite_distances = [value for value in corner_wall_distances if math.isfinite(value)]
        tip_distance = (
            min(finite_distances) - parameters.tip_clearance
            if finite_distances
            else parameters.rotor_diameter / 2
        )
        vane_root = tip_distance - parameters.vane_height
        vane = (
            cq.Workplane(
                obj=cq.Solid.makeBox(
                    parameters.vane_height,
                    parameters.vane_thickness,
                    axial_height,
                    cq.Vector(vane_root, -half_thickness, 1.0),
                )
            )
            .rotate((0, 0, 0), (0, 0, 1), angle)
            .translate((parameters.eccentricity, 0, 0))
        )
        vanes.append(vane)
    return tuple(vanes)


def _build_rotor(cq: Any, parameters: PumpParameters, rotor_angle_degrees: float) -> Any:
    rotor_radius = parameters.rotor_diameter / 2
    rotor = (
        cq.Workplane("XY")
        .center(parameters.eccentricity, 0)
        .circle(rotor_radius)
        .extrude(parameters.axial_width)
    )
    slot_side_clearance = max(0.05, min(0.2, parameters.tip_clearance / 2 + 0.05))
    radial_root = max(parameters.shaft_diameter / 2 + 1.5, rotor_radius * 0.2)
    slot_length = max(0.001, rotor_radius - radial_root + 2.0)
    for index in range(parameters.vane_count):
        angle = rotor_angle_degrees + index * 360.0 / parameters.vane_count
        slot = (
            cq.Workplane("XY")
            .box(
                slot_length,
                parameters.vane_thickness + slot_side_clearance * 2,
                parameters.axial_width + 2,
                centered=True,
            )
            .translate((radial_root + slot_length / 2, 0, parameters.axial_width / 2))
            .rotate((0, 0, 0), (0, 0, 1), angle)
            .translate((parameters.eccentricity, 0, 0))
        )
        rotor = rotor.cut(slot)
    return rotor


def build_rotating_group(
    parameters: PumpParameters, rotor_angle_degrees: float = 0.0
) -> tuple[Any, Any, tuple[Any, ...]]:
    cq = _cadquery()
    dimensions = resolved_cover_dimensions(parameters)
    rotor = _build_rotor(cq, parameters, rotor_angle_degrees)
    shaft_length = (
        parameters.axial_width
        + dimensions.cover_thickness_mm * 2
        + dimensions.wall_thickness_mm * 2
    )
    shaft = (
        cq.Workplane("XY")
        .center(parameters.eccentricity, 0)
        .circle(parameters.shaft_diameter / 2)
        .extrude(shaft_length)
        .translate(
            (
                0,
                0,
                -dimensions.cover_thickness_mm - dimensions.wall_thickness_mm,
            )
        )
    )
    return rotor, shaft, _build_vanes(cq, parameters, rotor_angle_degrees)


def build_pump_brep_geometry(
    parameters: PumpParameters, rotor_angle_degrees: float = 0.0
) -> PumpBrepGeometry:
    cq = _cadquery()
    dimensions = resolved_cover_dimensions(parameters)
    chamber_radius = parameters.chamber_diameter / 2
    width = parameters.axial_width

    chamber_wall = (
        cq.Workplane("XY")
        .circle(dimensions.housing_outer_radius_mm)
        .circle(chamber_radius)
        .extrude(width)
    )
    foot_width = dimensions.housing_outer_radius_mm * 2.25
    foot_depth = max(12.0, dimensions.wall_thickness_mm * 1.5)
    foot = (
        cq.Workplane("XY")
        .box(
            foot_width,
            foot_depth,
            dimensions.wall_thickness_mm,
            centered=(True, True, False),
        )
        .translate(
            (
                0,
                -dimensions.housing_outer_radius_mm - foot_depth / 2 + dimensions.wall_thickness_mm,
                0,
            )
        )
    )
    raw_housing = chamber_wall.union(foot)
    chamber_void = cq.Workplane("XY").circle(chamber_radius).extrude(width)
    outer_envelope = cq.Workplane("XY").circle(dimensions.housing_outer_radius_mm).extrude(width)

    port_builders = _build_port_cutters(cq, parameters, dimensions)
    housing = raw_housing
    for _role, _angle, cutter, _flow_probe, _throat, _exterior_probe in port_builders:
        housing = housing.cut(cutter)

    ports: list[PumpPortBrep] = []
    for role, angle, cutter, flow_probe, throat, exterior_probe in port_builders:
        removed_volume = _intersection_volume(raw_housing, cutter)
        chamber_overlap = _intersection_volume(chamber_void, cutter)
        exterior_overlap = _intersection_volume(exterior_probe, cutter.cut(outer_envelope))
        residual_blockage = _intersection_volume(housing, flow_probe)
        ports.append(
            PumpPortBrep(
                role=role,
                center_angle_degrees=angle,
                cutter=cutter,
                flow_probe=flow_probe,
                chamber_throat=throat,
                removed_volume_mm3=removed_volume,
                chamber_overlap_volume_mm3=chamber_overlap,
                exterior_overlap_volume_mm3=exterior_overlap,
                residual_blockage_volume_mm3=residual_blockage,
            )
        )

    rotor, shaft, vanes = build_rotating_group(parameters, rotor_angle_degrees)
    front_cover = (
        cq.Workplane("XY")
        .circle(dimensions.cover_outer_radius_mm)
        .center(parameters.eccentricity, 0)
        .circle(dimensions.cover_bore_radius_mm)
        .extrude(dimensions.cover_thickness_mm)
        .translate((0, 0, -dimensions.cover_thickness_mm))
    )
    rear_cover = (
        cq.Workplane("XY")
        .circle(dimensions.cover_outer_radius_mm)
        .center(parameters.eccentricity, 0)
        .circle(dimensions.cover_bore_radius_mm)
        .extrude(dimensions.cover_thickness_mm)
        .translate((0, 0, width))
    )
    return PumpBrepGeometry(
        raw_housing=raw_housing,
        chamber_wall=chamber_wall,
        housing=housing,
        rotor=rotor,
        shaft=shaft,
        front_cover=front_cover,
        rear_cover=rear_cover,
        vanes=vanes,
        ports=tuple(ports),
        cover_dimensions=dimensions,
    )


def _signed_clearance(left: Any, right: Any) -> tuple[float, float]:
    distance = _distance(left, right)
    if distance > _GEOMETRY_TOLERANCE_MM:
        return distance, 0.0
    common_volume = _intersection_volume(left, right)
    if common_volume > _VOLUME_TOLERANCE_MM3:
        # Cube-root volume produces a stable length-like negative margin for
        # sign-change refinement without claiming a physical penetration depth.
        return -(common_volume ** (1 / 3)), common_volume
    return 0.0, 0.0


def _port_cell(parameters: PumpParameters, angle: float, port_angle: float) -> int:
    return int(((port_angle - angle) % 360.0) // (360.0 / parameters.vane_count))


def _unique_angles(values: list[float]) -> tuple[float, ...]:
    ordered: list[float] = []
    for value in sorted(item % 360.0 for item in values):
        if not ordered or abs(value - ordered[-1]) > 1e-6:
            ordered.append(value)
    return tuple(ordered)


def validate_pump_brep(
    parameters: PumpParameters,
    step_degrees: float = 1.0,
    *,
    full_rotation: bool = True,
) -> PumpBrepValidation:
    """Run an OCCT-backed rotating-group and real-port validation.

    Every uniform sample builds the actual slotted rotor and two vane solids.
    OCCT distance/common operations check the rotor, vanes, shaft and chamber.
    Port openness is taken from intersections with the real cut passage throats.
    The circular step is normalized to never exceed one degree.
    """

    if step_degrees <= 0 or step_degrees > 1:
        raise ValueError("step_degrees must be in (0, 1]")
    cq = _cadquery()
    geometry = build_pump_brep_geometry(parameters)
    diagnostics: list[Diagnostic] = []
    shape_map = {
        "housing": geometry.housing,
        "rotor": geometry.rotor,
        "shaft": geometry.shaft,
        "front-cover": geometry.front_cover,
        "rear-cover": geometry.rear_cover,
        **{f"vane-{index + 1}": vane for index, vane in enumerate(geometry.vanes)},
    }
    invalid_shapes = [name for name, shape in shape_map.items() if not _shape(shape).isValid()]
    if invalid_shapes:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_INVALID_SOLID",
                severity="error",
                message=f"OCCT 检测到无效实体：{', '.join(invalid_shapes)}。",
            )
        )

    ports = {port.role: port for port in geometry.ports}
    for role in ("inlet", "outlet"):
        port = ports[role]
        if port.connected:
            diagnostics.append(
                Diagnostic(
                    code=f"PUMP_BREP_{role.upper()}_PASSAGE_CONNECTED",
                    severity="info",
                    message=(
                        f"OCCT 实体交集确认{('进气' if role == 'inlet' else '排气')}通道"
                        "从外壳贯穿至泵腔，切除后无残余实体堵塞。"
                    ),
                    target_id=f"{role}Width",
                )
            )
        else:
            diagnostics.append(
                Diagnostic(
                    code=f"PUMP_BREP_{role.upper()}_PASSAGE_BLOCKED",
                    severity="error",
                    message=(
                        f"OCCT 无法证明{('进气' if role == 'inlet' else '排气')}通道"
                        "从外部连续贯穿至泵腔。"
                    ),
                    target_id=f"{role}Width",
                )
            )

    rotor_shaft_joint_volume = _intersection_volume(geometry.rotor, geometry.shaft)
    if rotor_shaft_joint_volume <= _VOLUME_TOLERANCE_MM3:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_ROTOR_SHAFT_DISCONNECTED",
                severity="error",
                message="OCCT 检查发现转子与主轴没有形成预期的固定连接体积。",
                target_id="shaftDiameter",
            )
        )

    for cover_name, cover in (
        ("front", geometry.front_cover),
        ("rear", geometry.rear_cover),
    ):
        _margin, shaft_overlap = _signed_clearance(cover, geometry.shaft)
        if shaft_overlap > _VOLUME_TOLERANCE_MM3:
            diagnostics.append(
                Diagnostic(
                    code=f"PUMP_BREP_{cover_name.upper()}_COVER_SHAFT_INTERFERENCE",
                    severity="error",
                    message="OCCT 检查发现端盖轴孔与主轴发生实体干涉。",
                    target_id="coverBoreDiameter",
                )
            )

    if not full_rotation:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_ROTATION_SKIPPED_INVALID_SPEC",
                severity="info",
                message=(
                    "OCCT 已检查实体有效性、端盖轴孔和真实端口切除；规格已有硬错误，"
                    "因此未继续执行无意义的 360° 运动验收。"
                ),
            )
        )
        return PumpBrepValidation(
            diagnostics=tuple(diagnostics),
            sampling_step_degrees=step_degrees,
            samples=0,
            collision_boundary_angles_degrees=(),
            rotor_housing_clearance_min_mm=0.0,
            vane_housing_clearance_min_mm=0.0,
            vane_shaft_clearance_min_mm=0.0,
            rotating_group_interference_max_mm3=0.0,
            inlet_open_samples=0,
            outlet_open_samples=0,
            port_same_chamber_samples=0,
            inlet_passage_connected=ports["inlet"].connected,
            outlet_passage_connected=ports["outlet"].connected,
            inlet_passage_removed_volume_mm3=ports["inlet"].removed_volume_mm3,
            outlet_passage_removed_volume_mm3=ports["outlet"].removed_volume_mm3,
        )

    grid_count = math.ceil(360.0 / step_degrees)
    actual_step = 360.0 / grid_count
    rotor_housing_clearances: list[float] = []
    vane_housing_clearances: list[float] = []
    vane_shaft_clearances: list[float] = []
    sample_margins: list[float] = []
    maximum_interference = 0.0
    inlet_open = 0
    outlet_open = 0
    same_chamber = 0

    def group_at(angle_degrees: float) -> tuple[Any, Any, tuple[Any, ...]]:
        # The rotor is rigid: build its boolean slot topology once and apply an
        # OCCT transform at each phase. Only vane radial extension changes.
        rotor = geometry.rotor.rotate(
            (parameters.eccentricity, 0, 0),
            (parameters.eccentricity, 0, 1),
            angle_degrees,
        )
        return rotor, geometry.shaft, _build_vanes(cq, parameters, angle_degrees)

    for index in range(grid_count):
        angle = index * actual_step
        rotor, shaft, vanes = group_at(angle)
        rotor_margin, rotor_overlap = _signed_clearance(rotor, geometry.chamber_wall)
        rotor_housing_clearances.append(max(0.0, rotor_margin))
        maximum_interference = max(maximum_interference, rotor_overlap)
        critical_margins = [rotor_margin]

        for vane in vanes:
            wall_margin, wall_overlap = _signed_clearance(vane, geometry.chamber_wall)
            shaft_margin, shaft_overlap = _signed_clearance(vane, shaft)
            rotor_slot_margin, rotor_slot_overlap = _signed_clearance(vane, rotor)
            vane_housing_clearances.append(max(0.0, wall_margin))
            vane_shaft_clearances.append(max(0.0, shaft_margin))
            maximum_interference = max(
                maximum_interference,
                wall_overlap,
                shaft_overlap,
                rotor_slot_overlap,
            )
            critical_margins.extend((wall_margin, shaft_margin, rotor_slot_margin))

        if len(vanes) > 1:
            for left_index, left in enumerate(vanes[:-1]):
                for right in vanes[left_index + 1 :]:
                    vane_margin, vane_overlap = _signed_clearance(left, right)
                    maximum_interference = max(maximum_interference, vane_overlap)
                    critical_margins.append(vane_margin)

        open_by_role: dict[str, bool] = {}
        for role, port in ports.items():
            blocked = False
            for vane in vanes:
                if _distance(vane, port.chamber_throat) <= _GEOMETRY_TOLERANCE_MM:
                    if _intersection_volume(vane, port.chamber_throat) > _VOLUME_TOLERANCE_MM3:
                        blocked = True
                        break
            open_by_role[role] = not blocked
        inlet_open += int(open_by_role["inlet"])
        outlet_open += int(open_by_role["outlet"])
        if (
            open_by_role["inlet"]
            and open_by_role["outlet"]
            and _port_cell(parameters, angle, ports["inlet"].center_angle_degrees)
            == _port_cell(parameters, angle, ports["outlet"].center_angle_degrees)
        ):
            same_chamber += 1
        sample_margins.append(min(critical_margins))

    boundary_angles: list[float] = []
    for index, left_margin in enumerate(sample_margins):
        right_margin = sample_margins[(index + 1) % grid_count]
        if left_margin < 0 <= right_margin or right_margin < 0 <= left_margin:
            low = index * actual_step
            high = (index + 1) * actual_step
            for _iteration in range(32):
                midpoint = (low + high) / 2
                rotor, shaft, vanes = group_at(midpoint)
                margins = [_signed_clearance(rotor, geometry.chamber_wall)[0]]
                for vane in vanes:
                    margins.extend(
                        (
                            _signed_clearance(vane, geometry.chamber_wall)[0],
                            _signed_clearance(vane, shaft)[0],
                            _signed_clearance(vane, rotor)[0],
                        )
                    )
                midpoint_margin = min(margins)
                if abs(midpoint_margin) <= _GEOMETRY_TOLERANCE_MM or high - low <= 1e-7:
                    low = high = midpoint
                    break
                if (left_margin < 0) == (midpoint_margin < 0):
                    low = midpoint
                    left_margin = midpoint_margin
                else:
                    high = midpoint
            boundary_angles.append(((low + high) / 2) % 360.0)

    if maximum_interference > _VOLUME_TOLERANCE_MM3:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_ROTATING_GROUP_INTERFERENCE",
                severity="error",
                message=("OCCT 逐角度实体求交发现旋转组、主轴或泵腔存在非零干涉体积。"),
            )
        )
    else:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_ROTATION_VALID",
                severity="info",
                message=(
                    f"OCCT 已按 {actual_step:g}° 步长完成 {grid_count} 个整周实体位置的"
                    "旋转组、滑片端隙、槽内啮合与主轴干涉检查。"
                ),
            )
        )

    if inlet_open == 0 or outlet_open == 0 or same_chamber > 0:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_PORT_TIMING_INVALID",
                severity="error",
                message="OCCT 通道喉口与滑片实体求交未通过整周开闭隔离检查。",
            )
        )
    else:
        diagnostics.append(
            Diagnostic(
                code="PUMP_BREP_PORT_TIMING_VALID",
                severity="info",
                message="OCCT 通道喉口与滑片实体求交确认整周存在开窗且未连通同一工作腔。",
            )
        )

    return PumpBrepValidation(
        diagnostics=tuple(diagnostics),
        sampling_step_degrees=actual_step,
        samples=grid_count,
        collision_boundary_angles_degrees=_unique_angles(boundary_angles),
        rotor_housing_clearance_min_mm=min(rotor_housing_clearances, default=float("nan")),
        vane_housing_clearance_min_mm=min(vane_housing_clearances, default=float("nan")),
        vane_shaft_clearance_min_mm=min(vane_shaft_clearances, default=float("nan")),
        rotating_group_interference_max_mm3=maximum_interference,
        inlet_open_samples=inlet_open,
        outlet_open_samples=outlet_open,
        port_same_chamber_samples=same_chamber,
        inlet_passage_connected=ports["inlet"].connected,
        outlet_passage_connected=ports["outlet"].connected,
        inlet_passage_removed_volume_mm3=ports["inlet"].removed_volume_mm3,
        outlet_passage_removed_volume_mm3=ports["outlet"].removed_volume_mm3,
    )
