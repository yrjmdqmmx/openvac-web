from __future__ import annotations

import argparse
import json
import math
import sysconfig
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from .isolation import run_isolated


PROTOCOL_VERSION = "openvac.modeling.v1"
PUMP_FIXTURE_NAME = "rotary_vane_pump_v1.json"


def _stable_id(semantic_ref: str) -> str:
    """Return a reproducible UUID without weakening the semantic reference."""

    return str(uuid5(NAMESPACE_URL, f"https://openvac.cn/modeling/benchmark/{semantic_ref}"))


def _ref(semantic_ref: str) -> dict[str, str]:
    return {"id": _stable_id(semantic_ref), "semanticRef": semantic_ref}


def _parameter(
    semantic_ref: str,
    name: str,
    label: str,
    value: float,
) -> dict[str, Any]:
    return {
        **_ref(semantic_ref),
        "name": name,
        "label": label,
        "parameterType": "length",
        "unit": "mm",
        "value": value,
        "minimum": 0.001,
        "maximum": 100_000,
        "source": "template",
        "editable": True,
    }


def percentile_nearest_rank(values: list[float], percentile: float) -> float:
    if not values:
        raise ValueError("at least one duration is required")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[min(rank - 1, len(ordered) - 1)]


def sketch_benchmark_payload() -> dict[str, Any]:
    entities = [
        {
            "id": f"edge-{index}",
            "kind": "line",
            "start": [float(index), 0.0],
            "end": [float(index) + 0.75, 0.0],
        }
        for index in range(100)
    ]
    # Exactly 100 entities / 200 constraints. Each segment has a horizontal
    # and dimensional constraint while its origin remains free, so this times
    # a real underconstrained solve instead of a fast redundant-constraint exit.
    constraints = [
        {
            "id": f"horizontal-{index}",
            "kind": "horizontal",
            "refs": [f"edge-{index}"],
        }
        for index in range(100)
    ] + [
        {
            "id": f"length-{index}",
            "kind": "distance",
            "refs": [f"edge-{index}:start", f"edge-{index}:end"],
            "value": 0.75,
        }
        for index in range(100)
    ]
    return {
        "version": "openvac.modeling.v1",
        "entities": entities,
        "constraints": constraints,
    }


def feature_benchmark_document() -> dict[str, Any]:
    center_ref = "benchmark.sketch.base.center"
    profile_ref = "benchmark.sketch.base.profile"
    width_ref = "benchmark.parameter.width"
    height_ref = "benchmark.parameter.height"
    depth_ref = "benchmark.parameter.depth"
    hole_diameter_ref = "benchmark.parameter.hole-diameter"
    fillet_radius_ref = "benchmark.parameter.fillet-radius"
    base_ref = "benchmark.feature.base-extrude"
    hole_ref = "benchmark.feature.center-hole"
    fillet_ref = "benchmark.feature.outer-fillet"

    return {
        "version": PROTOCOL_VERSION,
        "id": _stable_id("benchmark.document.common-feature"),
        "revision": 0,
        "revisionId": _stable_id("benchmark.revision.common-feature"),
        "name": "OpenVac common feature benchmark",
        "unitSystem": "mm-deg",
        "parameters": [
            _parameter(width_ref, "width", "Base width", 80),
            _parameter(height_ref, "height", "Base height", 50),
            _parameter(depth_ref, "depth", "Extrusion depth", 12),
            _parameter(hole_diameter_ref, "holeDiameter", "Center hole diameter", 8),
            _parameter(fillet_radius_ref, "filletRadius", "Outer fillet radius", 1.5),
        ],
        "sketches": [
            {
                **_ref("benchmark.sketch.base"),
                "name": "Base rectangle",
                "plane": "xy",
                "suppressed": False,
                "entities": [
                    {
                        **_ref(center_ref),
                        "entityKind": "point",
                        "construction": True,
                        "x": 0,
                        "y": 0,
                    },
                    {
                        **_ref(profile_ref),
                        "entityKind": "rectangle",
                        "construction": False,
                        "centerPointRef": _ref(center_ref),
                        "widthParameterRef": _ref(width_ref),
                        "heightParameterRef": _ref(height_ref),
                        "rotationDegrees": 0,
                    },
                ],
                "constraints": [
                    {
                        **_ref("benchmark.constraint.base-center-fixed"),
                        "name": "Fix base center",
                        "constraintKind": "fixed",
                        "targetRefs": [_ref(center_ref)],
                        "status": "satisfied",
                    }
                ],
            }
        ],
        "features": [
            {
                **_ref(base_ref),
                "featureKind": "extrude",
                "profileRefs": [_ref(profile_ref)],
                "distanceParameterRef": _ref(depth_ref),
                "direction": "normal",
                "operation": "new_body",
                "suppressed": False,
            },
            {
                **_ref(hole_ref),
                "featureKind": "hole",
                "placement": {
                    "placementKind": "semantic_face",
                    "sourceFeatureRef": _ref(base_ref),
                    "faceSelector": "top",
                },
                "diameterParameterRef": _ref(hole_diameter_ref),
                "termination": "through_all",
                "operation": "cut",
                "suppressed": False,
            },
            {
                **_ref(fillet_ref),
                "featureKind": "fillet",
                "sourceFeatureRefs": [_ref(hole_ref)],
                "edgeSelector": "vertical",
                "radiusParameterRef": _ref(fillet_radius_ref),
                "suppressed": False,
            },
        ],
        "components": [],
        "assemblyConstraints": [],
    }


def pump_benchmark_document() -> dict[str, Any]:
    fixture_path = pump_benchmark_fixture_path()
    with fixture_path.open(encoding="utf-8") as stream:
        document = json.load(stream)
    if not isinstance(document, dict) or document.get("version") != PROTOCOL_VERSION:
        raise ValueError(
            f"pump benchmark fixture must be a {PROTOCOL_VERSION} document: {fixture_path}"
        )
    return document


def pump_benchmark_fixture_path() -> Path:
    """Find the one canonical pump fixture in source, Docker, or an installed wheel."""

    source_fixture = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / PUMP_FIXTURE_NAME
    installed_fixture = (
        Path(sysconfig.get_path("data"))
        / "share"
        / "openvac-modeling"
        / "fixtures"
        / PUMP_FIXTURE_NAME
    )
    for candidate in (source_fixture, installed_fixture):
        if candidate.is_file():
            return candidate
    checked = ", ".join(str(item) for item in (source_fixture, installed_fixture))
    raise FileNotFoundError(f"pump benchmark fixture was not packaged; checked: {checked}")


def _measure(iterations: int, operation: Callable[[int], Any]) -> list[float]:
    durations: list[float] = []
    for index in range(iterations):
        started = time.perf_counter()
        operation(index)
        durations.append((time.perf_counter() - started) * 1000)
    return durations


def run_benchmarks(
    case: str,
    iterations: int,
    artifact_root: Path,
) -> dict[str, Any]:
    if iterations < 1:
        raise ValueError("iterations must be positive")
    results: dict[str, Any] = {}

    if case in {"all", "sketch"}:
        durations = _measure(
            iterations,
            lambda _index: run_isolated(
                "app.sketch_solver",
                "solve_sketch_payload",
                sketch_benchmark_payload(),
                timeout_seconds=2,
            ),
        )
        results["sketch_100_entities_200_constraints"] = _summary(durations, 250)

    if case in {"all", "feature"}:
        durations = _measure(
            iterations,
            lambda index: run_isolated(
                "app.engine",
                "build_to_artifacts",
                f"feature-benchmark-{index}",
                feature_benchmark_document(),
                [],
                artifact_root,
                False,
                timeout_seconds=30,
            ),
        )
        results["common_feature_rebuild"] = _summary(durations, 5_000)

    if case in {"all", "pump"}:
        durations = _measure(
            iterations,
            lambda index: run_isolated(
                "app.engine",
                "build_to_artifacts",
                f"pump-benchmark-{index}",
                pump_benchmark_document(),
                [],
                artifact_root,
                True,
                timeout_seconds=180,
            ),
        )
        results["complete_original_pump"] = _summary(durations, 60_000)

    return {
        "iterations": iterations,
        "includes_process_isolation": True,
        "results": results,
        "passed": all(item["passed"] for item in results.values()),
    }


def _summary(durations_ms: list[float], target_p95_ms: float) -> dict[str, Any]:
    p95 = percentile_nearest_rank(durations_ms, 0.95)
    return {
        "minimum_ms": round(min(durations_ms), 3),
        "median_ms": round(percentile_nearest_rank(durations_ms, 0.5), 3),
        "p95_ms": round(p95, 3),
        "maximum_ms": round(max(durations_ms), 3),
        "target_p95_ms": target_p95_ms,
        "passed": p95 <= target_p95_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run isolated deterministic CAD acceptance benchmarks."
    )
    parser.add_argument("--case", choices=("all", "sketch", "feature", "pump"), default="all")
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--artifact-root", type=Path)
    args = parser.parse_args()
    root = args.artifact_root or Path(tempfile.mkdtemp(prefix="openvac-cad-benchmark-"))
    root.mkdir(parents=True, exist_ok=True)
    report = run_benchmarks(args.case, args.iterations, root.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
