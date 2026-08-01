from __future__ import annotations

import math
import time
from typing import Any

from .models import SketchSolveRequest, SketchSolveResult, SolvedEntity


def _slvs():
    try:
        import slvs
    except ImportError as exc:  # pragma: no cover - readiness covers the packaged runtime
        raise RuntimeError("SolveSpace slvs 3.2 is not installed") from exc
    return slvs


def solve_sketch_payload(payload: dict[str, Any]) -> SketchSolveResult:
    started = time.perf_counter()
    request = SketchSolveRequest.model_validate(payload)
    slvs = _slvs()
    slvs.clear_sketch()
    # SolveSpace reserves the reference workplane in group 1. Editable sketch
    # entities and constraints must live in a later group or the base plane's
    # own parameters are incorrectly counted as degrees of freedom.
    workplane = slvs.add_base_2d(1)
    group = 2
    # Circles/arcs require a 3D normal even when their points live in a 2D
    # workplane. Keep that orientation in the fixed reference group.
    normal = slvs.add_normal_3d(1, 1.0, 0.0, 0.0, 0.0)
    handles: dict[str, Any] = {}
    point_handles: dict[str, Any] = {}
    constraint_handles: dict[int, str] = {}
    composite_point_keys: dict[str, list[str]] = {}
    composite_segment_keys: dict[str, list[str]] = {}

    def add_point(key: str, coordinates: tuple[float, float]) -> Any:
        if key in point_handles:
            return point_handles[key]
        if not all(math.isfinite(value) and abs(value) <= 1_000_000 for value in coordinates):
            raise ValueError(f"点 {key} 坐标必须是有限值且绝对值不超过 1,000,000 mm。")
        point = slvs.add_point_2d(group, coordinates[0], coordinates[1], workplane)
        point_handles[key] = point
        handles[key] = point
        return point

    def add_line(key: str, start_key: str, end_key: str) -> Any:
        line = slvs.add_line_2d(
            group,
            point_handles[start_key],
            point_handles[end_key],
            workplane,
        )
        handles[key] = line
        return line

    if len({entity.id for entity in request.entities}) != len(request.entities):
        return _invalid(started, "草图对象 id 不能重复。")

    try:
        for entity in request.entities:
            if entity.kind == "point":
                if entity.x is None or entity.y is None:
                    return _invalid(started, f"点 {entity.id} 缺少 x/y 坐标。")
                handles[entity.id] = add_point(entity.id, (entity.x, entity.y))
            elif entity.kind == "line":
                if entity.start is None or entity.end is None:
                    return _invalid(started, f"直线 {entity.id} 缺少起点或终点。")
                if math.dist(entity.start, entity.end) <= 1e-9:
                    return _invalid(started, f"直线 {entity.id} 不能为零长度。")
                start_key = f"{entity.id}:start"
                end_key = f"{entity.id}:end"
                add_point(start_key, entity.start)
                add_point(end_key, entity.end)
                add_line(entity.id, start_key, end_key)
            elif entity.kind == "polyline":
                minimum_points = 3 if entity.closed else 2
                if entity.points is None or len(entity.points) < minimum_points:
                    return _invalid(started, f"折线 {entity.id} 的点数量不足。")
                if _polyline_self_intersects(entity.points, entity.closed):
                    return _invalid(started, f"折线 {entity.id} 存在自交。")
                point_keys: list[str] = []
                segment_keys: list[str] = []
                for index, coordinates in enumerate(entity.points):
                    point_key = f"{entity.id}:point:{index}"
                    add_point(point_key, coordinates)
                    point_keys.append(point_key)
                segment_count = len(point_keys) if entity.closed else len(point_keys) - 1
                for index in range(segment_count):
                    next_index = (index + 1) % len(point_keys)
                    if math.dist(entity.points[index], entity.points[next_index]) <= 1e-9:
                        return _invalid(started, f"折线 {entity.id} 包含零长度线段。")
                    segment_key = f"{entity.id}:segment:{index}"
                    add_line(segment_key, point_keys[index], point_keys[next_index])
                    segment_keys.append(segment_key)
                composite_point_keys[entity.id] = point_keys
                composite_segment_keys[entity.id] = segment_keys
            elif entity.kind == "rectangle":
                if entity.center is None or entity.width is None or entity.height is None:
                    return _invalid(started, f"矩形 {entity.id} 缺少中心、宽度或高度。")
                angle = math.radians(entity.angle_degrees)
                cosine, sine = math.cos(angle), math.sin(angle)
                offsets = [
                    (-entity.width / 2, -entity.height / 2),
                    (entity.width / 2, -entity.height / 2),
                    (entity.width / 2, entity.height / 2),
                    (-entity.width / 2, entity.height / 2),
                ]
                coordinates = [
                    (
                        entity.center[0] + x * cosine - y * sine,
                        entity.center[1] + x * sine + y * cosine,
                    )
                    for x, y in offsets
                ]
                point_keys = []
                segment_keys = []
                for index, point in enumerate(coordinates):
                    point_key = f"{entity.id}:point:{index}"
                    add_point(point_key, point)
                    point_keys.append(point_key)
                for index in range(4):
                    segment_key = f"{entity.id}:segment:{index}"
                    add_line(segment_key, point_keys[index], point_keys[(index + 1) % 4])
                    segment_keys.append(segment_key)
                composite_point_keys[entity.id] = point_keys
                composite_segment_keys[entity.id] = segment_keys
            elif entity.kind == "circle":
                if entity.center is None or entity.radius is None:
                    return _invalid(started, f"圆 {entity.id} 缺少圆心或半径。")
                center = add_point(f"{entity.id}:center", entity.center)
                radius = slvs.add_distance(group, entity.radius, workplane)
                handles[f"{entity.id}:radius"] = radius
                handles[entity.id] = slvs.add_circle(group, normal, center, radius, workplane)
            elif entity.kind == "arc":
                if entity.center is None or entity.start is None or entity.end is None:
                    return _invalid(started, f"圆弧 {entity.id} 缺少圆心、起点或终点。")
                start_radius = math.dist(entity.center, entity.start)
                end_radius = math.dist(entity.center, entity.end)
                if start_radius <= 1e-9 or end_radius <= 1e-9:
                    return _invalid(started, f"圆弧 {entity.id} 半径必须大于零。")
                if abs(start_radius - end_radius) > max(1e-6, start_radius * 1e-6):
                    return _invalid(started, f"圆弧 {entity.id} 起点与终点半径不一致。")
                center = add_point(f"{entity.id}:center", entity.center)
                arc_start = add_point(f"{entity.id}:start", entity.start)
                arc_end = add_point(f"{entity.id}:end", entity.end)
                handles[entity.id] = slvs.add_arc(
                    group, normal, center, arc_start, arc_end, workplane
                )
            elif entity.kind == "slot":
                if entity.start is None or entity.end is None or entity.width is None:
                    return _invalid(started, f"槽 {entity.id} 缺少中心线端点或宽度。")
                length = math.dist(entity.start, entity.end)
                if length <= 1e-9:
                    return _invalid(started, f"槽 {entity.id} 中心线不能为零长度。")
                dx = (entity.end[0] - entity.start[0]) / length
                dy = (entity.end[1] - entity.start[1]) / length
                offset_x, offset_y = -dy * entity.width / 2, dx * entity.width / 2
                coordinates = [
                    (entity.start[0] + offset_x, entity.start[1] + offset_y),
                    (entity.end[0] + offset_x, entity.end[1] + offset_y),
                    (entity.end[0] - offset_x, entity.end[1] - offset_y),
                    (entity.start[0] - offset_x, entity.start[1] - offset_y),
                ]
                point_keys = []
                for index, point in enumerate(coordinates):
                    point_key = f"{entity.id}:point:{index}"
                    add_point(point_key, point)
                    point_keys.append(point_key)
                start_center_key = f"{entity.id}:center:start"
                end_center_key = f"{entity.id}:center:end"
                add_point(start_center_key, entity.start)
                add_point(end_center_key, entity.end)
                first_line = f"{entity.id}:segment:0"
                second_line = f"{entity.id}:segment:1"
                add_line(first_line, point_keys[0], point_keys[1])
                add_line(second_line, point_keys[2], point_keys[3])
                handles[f"{entity.id}:arc:end"] = slvs.add_arc(
                    group,
                    normal,
                    point_handles[end_center_key],
                    point_handles[point_keys[1]],
                    point_handles[point_keys[2]],
                    workplane,
                )
                handles[f"{entity.id}:arc:start"] = slvs.add_arc(
                    group,
                    normal,
                    point_handles[start_center_key],
                    point_handles[point_keys[3]],
                    point_handles[point_keys[0]],
                    workplane,
                )
                composite_point_keys[entity.id] = point_keys
                composite_segment_keys[entity.id] = [first_line, second_line]
    except (TypeError, ValueError) as exc:
        return _invalid(started, str(exc))

    try:
        for constraint in request.constraints:
            refs = [_resolve_reference(handles, ref) for ref in constraint.refs]
            created = _add_constraint(
                slvs,
                group,
                workplane,
                constraint.kind,
                refs,
                constraint.value,
            )
            if created is not None:
                constraint_handles[int(created["h"])] = constraint.id
    except (KeyError, TypeError, ValueError) as exc:
        return _invalid(started, str(exc))

    raw_result = slvs.solve_sketch(group, True)
    # slvs 3.2 returns (result, failed_constraints) at runtime even though its
    # stub historically documented only the result mapping.
    if isinstance(raw_result, tuple):
        result, failed_constraints = raw_result
    else:  # pragma: no cover - compatibility with alternate slvs 3.2 builds
        result, failed_constraints = raw_result, []
    flag = int(result["result"])
    status = {
        int(slvs.ResultFlag.OKAY): "solved" if int(result["dof"]) == 0 else "underconstrained",
        int(slvs.ResultFlag.REDUNDANT_OKAY): "redundant",
        int(slvs.ResultFlag.INCONSISTENT): "inconsistent",
        int(slvs.ResultFlag.DIDNT_CONVERGE): "nonconvergent",
        int(slvs.ResultFlag.TOO_MANY_UNKNOWNS): "nonconvergent",
    }.get(flag, "nonconvergent")
    failed_handles = {
        int(item.get("h", 0))
        for item in failed_constraints
        if isinstance(item, dict) and item.get("h")
    }
    failed_handle = int(result.get("bad", 0))
    if failed_handle:
        failed_handles.add(failed_handle)
    conflicts = [
        constraint_handles[handle]
        for handle in sorted(failed_handles)
        if handle in constraint_handles
    ]
    if status in {"inconsistent", "redundant"} and not conflicts:
        conflicts = [constraint.id for constraint in request.constraints]

    solved: list[SolvedEntity] = []
    for entity in request.entities:
        if entity.kind == "point":
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind="point",
                    geometry=_point_geometry(slvs, handles[entity.id]),
                )
            )
        elif entity.kind == "line":
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind="line",
                    geometry={
                        "start": _point_geometry(slvs, handles[f"{entity.id}:start"]),
                        "end": _point_geometry(slvs, handles[f"{entity.id}:end"]),
                    },
                )
            )
        elif entity.kind in {"polyline", "rectangle"}:
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind=entity.kind,
                    geometry={
                        "points": [
                            _point_geometry(slvs, handles[key])
                            for key in composite_point_keys[entity.id]
                        ],
                        "segments": composite_segment_keys[entity.id],
                        "closed": entity.closed if entity.kind == "polyline" else True,
                    },
                )
            )
        elif entity.kind == "circle":
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind="circle",
                    geometry={
                        "center": _point_geometry(slvs, handles[f"{entity.id}:center"]),
                        "radius": slvs.get_param_value(handles[f"{entity.id}:radius"]["param"][0]),
                    },
                )
            )
        elif entity.kind == "arc":
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind="arc",
                    geometry={
                        "center": _point_geometry(slvs, handles[f"{entity.id}:center"]),
                        "start": _point_geometry(slvs, handles[f"{entity.id}:start"]),
                        "end": _point_geometry(slvs, handles[f"{entity.id}:end"]),
                    },
                )
            )
        else:
            solved.append(
                SolvedEntity(
                    id=entity.id,
                    kind="slot",
                    geometry={
                        "points": [
                            _point_geometry(slvs, handles[key])
                            for key in composite_point_keys[entity.id]
                        ],
                        "segments": composite_segment_keys[entity.id],
                        "startCenter": _point_geometry(slvs, handles[f"{entity.id}:center:start"]),
                        "endCenter": _point_geometry(slvs, handles[f"{entity.id}:center:end"]),
                    },
                )
            )

    return SketchSolveResult(
        status=status,
        dof=int(result["dof"]),
        entities=solved,
        conflict_constraint_ids=[item for item in conflicts if item],
        duration_ms=(time.perf_counter() - started) * 1000,
        diagnostic=_diagnostic_for_status(status),
    )


def _resolve_reference(handles: dict[str, Any], reference: str) -> Any:
    try:
        return handles[reference]
    except KeyError as exc:
        raise KeyError(f"约束引用了不存在的草图对象：{reference}") from exc


def _add_constraint(
    slvs: Any,
    group: int,
    workplane: Any,
    kind: str,
    refs: list[Any],
    value: float | None,
) -> Any:
    if kind == "fixed":
        created = None
        for ref in refs:
            if int(ref["type"]) != 50001:  # SolveSpace POINT_IN_2D
                raise ValueError("固定约束必须引用点；固定直线时请分别引用 line:start 与 line:end")
            else:
                created = slvs.dragged(group, ref, workplane)
        return created
    if kind == "coincident":
        _expect(refs, 2, kind)
        return slvs.coincident(group, refs[0], refs[1], workplane)
    if kind == "horizontal":
        if len(refs) == 1:
            return slvs.horizontal(group, refs[0], workplane)
        if len(refs) == 2 and all(int(ref["type"]) == 50001 for ref in refs):
            return slvs.horizontal(group, refs[0], workplane, refs[1])
        raise ValueError("horizontal 约束需要一条直线或两个点")
    if kind == "vertical":
        if len(refs) == 1:
            return slvs.vertical(group, refs[0], workplane)
        if len(refs) == 2 and all(int(ref["type"]) == 50001 for ref in refs):
            return slvs.vertical(group, refs[0], workplane, refs[1])
        raise ValueError("vertical 约束需要一条直线或两个点")
    if kind == "parallel":
        _expect(refs, 2, kind)
        return slvs.parallel(group, refs[0], refs[1], workplane)
    if kind == "perpendicular":
        _expect(refs, 2, kind)
        return slvs.perpendicular(group, refs[0], refs[1], workplane, False)
    if kind == "tangent":
        _expect(refs, 2, kind)
        return slvs.tangent(group, refs[0], refs[1], workplane)
    if kind == "equal":
        _expect(refs, 2, kind)
        return slvs.equal(group, refs[0], refs[1], workplane)
    if kind == "midpoint":
        _expect(refs, 2, kind)
        return slvs.midpoint(group, refs[0], refs[1], workplane)
    if kind == "symmetric":
        _expect(refs, 3, kind)
        return slvs.symmetric(group, refs[0], refs[1], refs[2], workplane)
    if kind == "distance":
        _expect_value(value, kind)
        if len(refs) == 1 and int(refs[0]["type"]) == 80001:  # LINE_SEGMENT
            raise ValueError("线长约束必须显式引用 line:start 与 line:end")
        _expect(refs, 2, kind)
        return slvs.distance(group, refs[0], refs[1], value, workplane)
    if kind == "angle":
        _expect(refs, 2, kind)
        _expect_value(value, kind)
        return slvs.angle(group, refs[0], refs[1], value, workplane, False)
    if kind in {"radius", "diameter"}:
        _expect(refs, 1, kind)
        _expect_value(value, kind)
        diameter = value * 2 if kind == "radius" else value
        return slvs.diameter(group, refs[0], diameter)
    raise ValueError(f"不支持的草图约束：{kind}")


def _point_geometry(slvs: Any, point: Any) -> dict[str, float]:
    return {
        "x": float(slvs.get_param_value(point["param"][0])),
        "y": float(slvs.get_param_value(point["param"][1])),
    }


def _expect(refs: list[Any], count: int, kind: str) -> None:
    if len(refs) != count:
        raise ValueError(f"{kind} 约束需要 {count} 个引用")


def _expect_value(value: float | None, kind: str) -> None:
    if value is None:
        raise ValueError(f"{kind} 约束缺少数值")


def _diagnostic_for_status(status: str) -> str:
    return {
        "solved": "草图已完全约束。",
        "underconstrained": "草图可求解但仍有自由度。",
        "redundant": "草图包含冗余约束。",
        "inconsistent": "草图约束互相冲突。",
        "nonconvergent": "草图求解未收敛。",
    }.get(status, "草图求解失败。")


def _polyline_self_intersects(points: list[tuple[float, float]], closed: bool) -> bool:
    segments = list(zip(points, points[1:]))
    if closed:
        segments.append((points[-1], points[0]))
    for first_index, first in enumerate(segments):
        for second_index in range(first_index + 1, len(segments)):
            if second_index == first_index + 1:
                continue
            if closed and first_index == 0 and second_index == len(segments) - 1:
                continue
            if _segments_intersect(first, segments[second_index]):
                return True
    return False


def _segments_intersect(
    first: tuple[tuple[float, float], tuple[float, float]],
    second: tuple[tuple[float, float], tuple[float, float]],
) -> bool:
    a, b = first
    c, d = second

    def orientation(
        left: tuple[float, float],
        middle: tuple[float, float],
        right: tuple[float, float],
    ) -> float:
        return (middle[0] - left[0]) * (right[1] - left[1]) - (middle[1] - left[1]) * (
            right[0] - left[0]
        )

    def on_segment(
        left: tuple[float, float],
        point: tuple[float, float],
        right: tuple[float, float],
    ) -> bool:
        return (
            min(left[0], right[0]) - 1e-9 <= point[0] <= max(left[0], right[0]) + 1e-9
            and min(left[1], right[1]) - 1e-9 <= point[1] <= max(left[1], right[1]) + 1e-9
        )

    values = (
        orientation(a, b, c),
        orientation(a, b, d),
        orientation(c, d, a),
        orientation(c, d, b),
    )
    if values[0] * values[1] < 0 and values[2] * values[3] < 0:
        return True
    return any(
        abs(value) <= 1e-9 and on_segment(left, point, right)
        for value, left, point, right in (
            (values[0], a, c, b),
            (values[1], a, d, b),
            (values[2], c, a, d),
            (values[3], c, b, d),
        )
    )


def _invalid(started: float, message: str) -> SketchSolveResult:
    return SketchSolveResult(
        status="invalid_input",
        duration_ms=(time.perf_counter() - started) * 1000,
        diagnostic=message,
    )
