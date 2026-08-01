from app.sketch_solver import solve_sketch_payload


def _rectangle_payload() -> dict:
    return {
        "version": "openvac.modeling.v1",
        "entities": [
            {"id": "bottom", "kind": "line", "start": [0, 0], "end": [20, 0]},
            {"id": "right", "kind": "line", "start": [20, 0], "end": [20, 10]},
            {"id": "top", "kind": "line", "start": [20, 10], "end": [0, 10]},
            {"id": "left", "kind": "line", "start": [0, 10], "end": [0, 0]},
        ],
        "constraints": [
            {"id": "horizontal-bottom", "kind": "horizontal", "refs": ["bottom"]},
            {"id": "vertical-right", "kind": "vertical", "refs": ["right"]},
            {"id": "horizontal-top", "kind": "horizontal", "refs": ["top"]},
            {"id": "vertical-left", "kind": "vertical", "refs": ["left"]},
            {"id": "corner-1", "kind": "coincident", "refs": ["bottom:end", "right:start"]},
            {"id": "corner-2", "kind": "coincident", "refs": ["right:end", "top:start"]},
            {"id": "corner-3", "kind": "coincident", "refs": ["top:end", "left:start"]},
            {"id": "corner-4", "kind": "coincident", "refs": ["left:end", "bottom:start"]},
            {"id": "origin", "kind": "fixed", "refs": ["bottom:start"]},
            {
                "id": "width",
                "kind": "distance",
                "refs": ["bottom:start", "bottom:end"],
                "value": 20,
            },
            {"id": "height", "kind": "distance", "refs": ["right:start", "right:end"], "value": 10},
        ],
    }


def test_rectangle_is_fully_constrained() -> None:
    result = solve_sketch_payload(_rectangle_payload())

    assert result.status == "solved"
    assert result.dof == 0
    assert len(result.entities) == 4


def test_circle_reports_remaining_degrees_of_freedom() -> None:
    result = solve_sketch_payload(
        {
            "version": "openvac.modeling.v1",
            "entities": [{"id": "ring", "kind": "circle", "center": [0, 0], "radius": 10}],
            "constraints": [],
        }
    )

    assert result.status == "underconstrained"
    assert result.dof == 3


def test_conflicting_dimensions_are_reported_without_mutating_geometry() -> None:
    result = solve_sketch_payload(
        {
            "version": "openvac.modeling.v1",
            "entities": [{"id": "edge", "kind": "line", "start": [0, 0], "end": [10, 0]}],
            "constraints": [
                {"id": "origin", "kind": "fixed", "refs": ["edge:start"]},
                {"id": "horizontal", "kind": "horizontal", "refs": ["edge"]},
                {
                    "id": "length-10",
                    "kind": "distance",
                    "refs": ["edge:start", "edge:end"],
                    "value": 10,
                },
                {
                    "id": "length-20",
                    "kind": "distance",
                    "refs": ["edge:start", "edge:end"],
                    "value": 20,
                },
            ],
        }
    )

    assert result.status == "inconsistent"
    assert {"length-10", "length-20"}.issubset(result.conflict_constraint_ids)


def test_zero_length_line_is_rejected_before_solver_entry() -> None:
    result = solve_sketch_payload(
        {
            "version": "openvac.modeling.v1",
            "entities": [{"id": "zero", "kind": "line", "start": [1, 1], "end": [1, 1]}],
            "constraints": [],
        }
    )

    assert result.status == "invalid_input"
    assert "零长度" in (result.diagnostic or "")


def test_polyline_rectangle_and_slot_expand_to_solvable_primitives() -> None:
    result = solve_sketch_payload(
        {
            "version": "openvac.modeling.v1",
            "entities": [
                {
                    "id": "outline",
                    "kind": "polyline",
                    "points": [[-20, -10], [-5, -10], [-5, 10], [-20, 10]],
                    "closed": True,
                    "construction": True,
                },
                {
                    "id": "plate",
                    "kind": "rectangle",
                    "center": [10, 0],
                    "width": 20,
                    "height": 12,
                },
                {
                    "id": "mount-slot",
                    "kind": "slot",
                    "start": [25, 0],
                    "end": [45, 0],
                    "width": 6,
                },
            ],
            "constraints": [],
        }
    )

    assert result.status == "underconstrained"
    assert {entity.kind for entity in result.entities} == {
        "polyline",
        "rectangle",
        "slot",
    }


def test_self_intersecting_profile_is_rejected() -> None:
    result = solve_sketch_payload(
        {
            "version": "openvac.modeling.v1",
            "entities": [
                {
                    "id": "bow-tie",
                    "kind": "polyline",
                    "points": [[0, 0], [10, 10], [0, 10], [10, 0]],
                    "closed": True,
                }
            ],
            "constraints": [],
        }
    )

    assert result.status == "invalid_input"
    assert "自交" in (result.diagnostic or "")
