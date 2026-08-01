import json
from pathlib import Path
from uuid import UUID

from app.benchmark import (
    PROTOCOL_VERSION,
    feature_benchmark_document,
    percentile_nearest_rank,
    pump_benchmark_document,
    pump_benchmark_fixture_path,
    sketch_benchmark_payload,
)
from app.engine import build_to_artifacts
from app.sketch_solver import solve_sketch_payload


FIXTURE = Path(__file__).parent / "fixtures" / "rotary_vane_pump_v1.json"


def test_acceptance_sketch_has_exact_target_size() -> None:
    payload = sketch_benchmark_payload()
    assert len(payload["entities"]) == 100
    assert len(payload["constraints"]) == 200


def test_acceptance_sketch_capacity_runs_the_real_solver() -> None:
    payload = sketch_benchmark_payload()

    result = solve_sketch_payload(payload)

    assert result.status == "underconstrained"
    assert result.dof == 200
    assert len(result.entities) == 100
    assert result.conflict_constraint_ids == []


def test_common_feature_benchmark_is_a_real_versioned_document() -> None:
    document = feature_benchmark_document()

    assert document["version"] == PROTOCOL_VERSION
    assert document["unitSystem"] == "mm-deg"
    assert [feature["semanticRef"] for feature in document["features"]] == [
        "benchmark.feature.base-extrude",
        "benchmark.feature.center-hole",
        "benchmark.feature.outer-fillet",
    ]
    assert [feature["featureKind"] for feature in document["features"]] == [
        "extrude",
        "hole",
        "fillet",
    ]
    assert document["features"][0]["profileRefs"][0]["semanticRef"] == (
        "benchmark.sketch.base.profile"
    )
    for collection in (document["parameters"], document["sketches"], document["features"]):
        for item in collection:
            UUID(item["id"])
            assert item["semanticRef"]


def test_common_feature_benchmark_builds_the_protocol_feature_chain(tmp_path: Path) -> None:
    response = build_to_artifacts(
        "common-feature-test",
        feature_benchmark_document(),
        [],
        tmp_path,
        False,
    )

    assert response.valid is True
    assert response.metrics is not None
    assert response.metrics.solid_count == 1
    assert response.metrics.volume_mm3 < 80 * 50 * 12


def test_pump_benchmark_loads_the_canonical_versioned_fixture() -> None:
    pump = pump_benchmark_document()

    assert pump_benchmark_fixture_path().resolve() == FIXTURE.resolve()
    assert pump == json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert pump["version"] == PROTOCOL_VERSION
    assert pump["metadata"]["template"]["templateId"] == (
        "template.rotary-vane-pump.single-stage-double-vane"
    )
    assert [feature["semanticRef"] for feature in pump["features"]] == [
        "pump.feature.chamber-volume",
        "pump.feature.rotor",
        "pump.feature.shaft",
        "pump.feature.vane",
        "pump.feature.vane-pattern",
        "pump.feature.inlet-port",
        "pump.feature.outlet-port",
        "pump.feature.front-cover",
        "pump.feature.rear-cover",
    ]


def test_nearest_rank_p95_is_deterministic() -> None:
    assert percentile_nearest_rank([5, 1, 3, 2, 4], 0.5) == 3
    assert percentile_nearest_rank(list(range(1, 101)), 0.95) == 95
