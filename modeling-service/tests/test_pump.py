import pytest

from app.models import PumpParameters
from app.pump import DEFAULT_PUMP_PARAMETERS, sample_rotor_clearance, validate_rotary_vane_pump
from app.pump_geometry import build_pump_brep_geometry


def test_default_original_pump_passes_full_rotation_geometry() -> None:
    result = validate_rotary_vane_pump(DEFAULT_PUMP_PARAMETERS)

    assert result.valid is True
    assert result.samples == 360
    assert result.sampling_step_degrees <= 1
    assert result.radial_clearance_min_mm > DEFAULT_PUMP_PARAMETERS.tip_clearance
    assert result.vane_extension_max_mm > result.vane_extension_min_mm
    assert result.vane_tip_gap_min_mm == pytest.approx(
        DEFAULT_PUMP_PARAMETERS.tip_clearance, abs=1e-9
    )
    assert result.vane_tip_gap_max_mm == pytest.approx(
        DEFAULT_PUMP_PARAMETERS.tip_clearance, abs=1e-9
    )
    assert result.vane_engagement_min_mm >= DEFAULT_PUMP_PARAMETERS.rotor_diameter * 0.1
    assert result.cavity_volume_delta_mm3 > 0
    assert result.cavity_volume_min_mm3 + result.cavity_volume_max_mm3 == pytest.approx(
        result.geometric_void_volume_mm3, rel=1e-9
    )
    assert result.swept_volume_estimate_mm3 > 0
    assert result.inlet_open_samples > 0
    assert result.outlet_open_samples > 0
    assert result.port_same_chamber_samples == 0
    assert result.port_isolation_margin_degrees > 0
    assert result.analysis_method == "deterministic_analytic_geometry_with_occt_brep"
    assert result.cavity_volume_method == "deterministic_polar_quadrature"
    assert result.brep_checked is True
    assert result.brep_samples == 360
    assert result.brep_sampling_step_degrees <= 1
    assert result.brep_rotor_housing_clearance_min_mm > 0
    assert result.brep_vane_housing_clearance_min_mm > 0
    assert result.brep_vane_shaft_clearance_min_mm > 0
    assert result.brep_rotating_group_interference_max_mm3 == pytest.approx(0, abs=1e-7)
    assert result.inlet_passage_connected is True
    assert result.outlet_passage_connected is True
    assert result.inlet_passage_removed_volume_mm3 > 0
    assert result.outlet_passage_removed_volume_mm3 > 0
    assert any(item.code == "PUMP_BREP_ROTATION_VALID" for item in result.diagnostics)
    assert any(item.code == "PUMP_BREP_INLET_PASSAGE_CONNECTED" for item in result.diagnostics)
    assert any(item.code == "PUMP_BREP_OUTLET_PASSAGE_CONNECTED" for item in result.diagnostics)
    assert any(item.code == "PUMP_GEOMETRY_VALID" for item in result.diagnostics)


def test_port_features_are_actual_brep_cuts_connected_to_the_chamber() -> None:
    pytest.importorskip("vtk", exc_type=ImportError)
    pytest.importorskip("cadquery")
    geometry = build_pump_brep_geometry(DEFAULT_PUMP_PARAMETERS)

    assert geometry.raw_housing.val().Volume() > geometry.housing.val().Volume()
    assert {port.role for port in geometry.ports} == {"inlet", "outlet"}
    for port in geometry.ports:
        assert port.connected is True
        assert port.removed_volume_mm3 > 0
        assert port.chamber_overlap_volume_mm3 > 0
        assert port.exterior_overlap_volume_mm3 > 0
        assert port.residual_blockage_volume_mm3 == pytest.approx(0, abs=1e-7)


def test_interfering_rotor_is_rejected() -> None:
    parameters = DEFAULT_PUMP_PARAMETERS.model_copy(
        update={"rotor_diameter": 98, "eccentricity": 2}
    )
    result = validate_rotary_vane_pump(parameters)

    assert result.valid is False
    assert any(item.code == "PUMP_ROTOR_CHAMBER_INTERFERENCE" for item in result.diagnostics)


def test_insufficient_vane_engagement_is_rejected() -> None:
    parameters = DEFAULT_PUMP_PARAMETERS.model_copy(update={"vane_height": 10})
    result = validate_rotary_vane_pump(parameters)

    assert result.valid is False
    assert any(item.code == "PUMP_VANE_ENGAGEMENT_INSUFFICIENT" for item in result.diagnostics)


def test_excessive_vane_retraction_into_shaft_is_rejected() -> None:
    parameters = DEFAULT_PUMP_PARAMETERS.model_copy(update={"vane_height": 40})
    result = validate_rotary_vane_pump(parameters)

    assert result.valid is False
    assert any(item.code == "PUMP_VANE_ROOT_SHAFT_INTERFERENCE" for item in result.diagnostics)


def test_collision_boundaries_are_refined_inside_one_degree_grid() -> None:
    parameters = DEFAULT_PUMP_PARAMETERS.model_copy(
        update={"rotor_diameter": 98, "eccentricity": 2}
    )
    samples = sample_rotor_clearance(parameters)
    boundaries = [sample for sample in samples if sample.collision_boundary]
    angles = [sample.angle_degrees for sample in samples]
    circular_gaps = [
        (angles[(index + 1) % len(angles)] - angle) % 360 for index, angle in enumerate(angles)
    ]

    assert len(boundaries) == 2
    assert max(circular_gaps) <= 1 + 1e-9
    assert all(abs(sample.collision_margin_mm) <= 1e-7 for sample in boundaries)
    result = validate_rotary_vane_pump(parameters)
    assert result.collision_boundary_angles_degrees == pytest.approx(
        [sample.angle_degrees for sample in boundaries], abs=1e-7
    )
    assert any(item.code == "PUMP_COLLISION_BOUNDARY_REFINED" for item in result.diagnostics)


def test_sampling_rejects_steps_larger_than_one_degree() -> None:
    try:
        sample_rotor_clearance(DEFAULT_PUMP_PARAMETERS, step_degrees=2)
    except ValueError as exc:
        assert "(0, 1]" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected invalid step size")


def test_parameter_model_rejects_negative_dimensions() -> None:
    try:
        PumpParameters(**{**DEFAULT_PUMP_PARAMETERS.model_dump(), "chamber_diameter": -1})
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("negative dimensions must be rejected")
