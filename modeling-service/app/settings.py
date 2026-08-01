from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    artifact_root: Path
    service_token: str | None
    require_service_token: bool
    interactive_timeout_seconds: float
    build_timeout_seconds: float
    sketch_timeout_seconds: float
    max_step_bytes: int


def load_settings() -> Settings:
    # Containers set MODELING_ARTIFACT_ROOT to the mounted private volume.
    # Local development must remain runnable without requiring root access.
    default_root = Path(tempfile.gettempdir()) / "openvac-modeling" / "artifacts"
    root = Path(os.getenv("MODELING_ARTIFACT_ROOT", str(default_root)))
    root.mkdir(parents=True, exist_ok=True)
    return Settings(
        artifact_root=root.resolve(),
        service_token=os.getenv("MODELING_SERVICE_TOKEN") or None,
        require_service_token=os.getenv("MODELING_REQUIRE_SERVICE_TOKEN", "false").strip().lower()
        in {"1", "true", "yes", "on"},
        interactive_timeout_seconds=float(os.getenv("MODELING_INTERACTIVE_TIMEOUT_SECONDS", "30")),
        build_timeout_seconds=float(os.getenv("MODELING_BUILD_TIMEOUT_SECONDS", "180")),
        sketch_timeout_seconds=float(os.getenv("MODELING_SKETCH_TIMEOUT_SECONDS", "2")),
        max_step_bytes=int(os.getenv("MODELING_MAX_STEP_BYTES", str(50 * 1024 * 1024))),
    )


settings = load_settings()
