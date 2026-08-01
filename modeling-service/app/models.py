from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PROTOCOL_VERSION = "openvac.modeling.v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SketchEntity(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    kind: Literal[
        "point",
        "line",
        "polyline",
        "rectangle",
        "circle",
        "arc",
        "slot",
    ]
    construction: bool = False
    x: float | None = None
    y: float | None = None
    start: tuple[float, float] | None = None
    end: tuple[float, float] | None = None
    center: tuple[float, float] | None = None
    clockwise: bool | None = None
    radius: float | None = Field(default=None, gt=0)
    points: list[tuple[float, float]] | None = Field(default=None, min_length=2, max_length=100)
    closed: bool = False
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    angle_degrees: float = Field(default=0, ge=-360, le=360)


class SketchConstraint(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    kind: Literal[
        "fixed",
        "coincident",
        "horizontal",
        "vertical",
        "parallel",
        "perpendicular",
        "tangent",
        "equal",
        "midpoint",
        "symmetric",
        "distance",
        "angle",
        "radius",
        "diameter",
    ]
    refs: list[str] = Field(min_length=1, max_length=4)
    value: float | None = None


class SketchSolveRequest(StrictModel):
    version: Literal["openvac.modeling.v1"] = PROTOCOL_VERSION
    entities: list[SketchEntity] = Field(max_length=100)
    # Protocol documents allow 200 user constraints. The strict adapter adds
    # stable coincidence bindings for composite entities before invoking this
    # internal solver port, so its transport ceiling must include both sets.
    constraints: list[SketchConstraint] = Field(max_length=1_000)


class SolvedEntity(StrictModel):
    id: str
    kind: Literal["point", "line", "polyline", "rectangle", "circle", "arc", "slot"]
    geometry: dict[str, Any]


class SketchSolveResult(StrictModel):
    status: Literal[
        "solved",
        "underconstrained",
        "redundant",
        "inconsistent",
        "nonconvergent",
        "invalid_input",
        "timeout",
    ]
    dof: int | None = None
    entities: list[SolvedEntity] = Field(default_factory=list)
    conflict_constraint_ids: list[str] = Field(default_factory=list)
    duration_ms: float = 0
    diagnostic: str | None = None


class BuildRequest(StrictModel):
    version: Literal["openvac.modeling.v1"] = PROTOCOL_VERSION
    job_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,120}$")
    document: dict[str, Any]
    formats: list[Literal["step", "stl", "glb"]] = Field(
        default_factory=lambda: ["glb"], max_length=3
    )
    validate_pump: bool = False

    @field_validator("formats")
    @classmethod
    def unique_formats(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("at least one artifact format is required")
        return list(dict.fromkeys(value))


class ValidationRequest(StrictModel):
    version: Literal["openvac.modeling.v1"] = PROTOCOL_VERSION
    job_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,120}$")
    document: dict[str, Any]
    validate_pump: bool = False


class ArtifactDescriptor(StrictModel):
    kind: Literal["step", "stl", "glb"]
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str
    download_path: str


class Diagnostic(StrictModel):
    code: str
    severity: Literal["info", "warning", "error"]
    message: str
    target_id: str | None = None


class BuildMetrics(StrictModel):
    solid_count: int
    volume_mm3: float
    surface_area_mm2: float
    bounding_box_mm: tuple[float, float, float]
    center_of_mass_mm: tuple[float, float, float]
    mass_kg: float | None
    mass_status: Literal[
        "computed_from_user_density",
        "unavailable_density_required",
    ]


class BuildResponse(StrictModel):
    version: Literal["openvac.modeling.v1"] = PROTOCOL_VERSION
    job_id: str
    model_hash: str
    kernel_version: str
    solver_version: str
    valid: bool
    diagnostics: list[Diagnostic]
    metrics: BuildMetrics | None = None
    artifacts: list[ArtifactDescriptor] = Field(default_factory=list)
    duration_ms: float


class StepImportResponse(StrictModel):
    version: Literal["openvac.modeling.v1"] = PROTOCOL_VERSION
    job_id: str
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_size_bytes: int = Field(gt=0)
    kernel_version: str
    valid: bool
    diagnostics: list[Diagnostic]
    metrics: BuildMetrics
    body_semantic_refs: list[str] = Field(min_length=1, max_length=1_000)
    artifacts: list[ArtifactDescriptor]
    duration_ms: float


class PumpParameters(StrictModel):
    chamber_diameter: float = Field(gt=0)
    rotor_diameter: float = Field(gt=0)
    eccentricity: float = Field(ge=0)
    axial_width: float = Field(gt=0)
    vane_count: int = Field(ge=2, le=8)
    vane_thickness: float = Field(gt=0)
    vane_height: float = Field(gt=0)
    shaft_diameter: float = Field(gt=0)
    inlet_width: float = Field(gt=0)
    outlet_width: float = Field(gt=0)
    tip_clearance: float = Field(default=0.15, ge=0)
    # Protocol templates materialize these as non-editable derived parameters.
    # They remain optional at the service boundary for legacy benchmark payloads;
    # the deterministic kernel derives the same values when they are omitted.
    cover_outer_diameter: float | None = Field(default=None, gt=0)
    cover_thickness: float | None = Field(default=None, gt=0)
    cover_bore_diameter: float | None = Field(default=None, gt=0)


class PumpValidationResult(StrictModel):
    valid: bool
    diagnostics: list[Diagnostic]
    analysis_method: Literal["deterministic_analytic_geometry_with_occt_brep"]
    cavity_volume_method: Literal["deterministic_polar_quadrature"]
    brep_checked: Literal[True] = True
    brep_sampling_step_degrees: float
    brep_samples: int
    brep_collision_boundary_angles_degrees: list[float] = Field(default_factory=list)
    brep_rotor_housing_clearance_min_mm: float
    brep_vane_housing_clearance_min_mm: float
    brep_vane_shaft_clearance_min_mm: float
    brep_rotating_group_interference_max_mm3: float
    inlet_passage_connected: bool
    outlet_passage_connected: bool
    inlet_passage_removed_volume_mm3: float
    outlet_passage_removed_volume_mm3: float
    radial_clearance_min_mm: float
    radial_clearance_max_mm: float
    vane_extension_min_mm: float
    vane_extension_max_mm: float
    vane_tip_gap_min_mm: float
    vane_tip_gap_max_mm: float
    vane_engagement_min_mm: float
    vane_engagement_max_mm: float
    cavity_volume_min_mm3: float
    cavity_volume_max_mm3: float
    cavity_volume_delta_mm3: float
    geometric_void_volume_mm3: float
    swept_volume_estimate_mm3: float
    inlet_open_samples: int
    outlet_open_samples: int
    port_same_chamber_samples: int
    port_isolation_margin_degrees: float
    sampling_step_degrees: float
    collision_boundary_angles_degrees: list[float] = Field(default_factory=list)
    samples: int
