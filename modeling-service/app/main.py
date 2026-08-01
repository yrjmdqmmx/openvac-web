from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Path as ApiPath,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse

from .isolation import (
    IsolatedExecutionError,
    IsolatedExecutionTimeout,
    run_isolated_async,
)
from .models import (
    BuildRequest,
    BuildResponse,
    PumpParameters,
    PumpValidationResult,
    SketchSolveRequest,
    SketchSolveResult,
    StepImportResponse,
    ValidationRequest,
)
from .settings import settings

app = FastAPI(
    title="OpenVac Modeling Service",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# CadQuery/OCP and SolveSpace are intentionally single-flight in this service.
# The container is pinned to one Uvicorn worker, so this semaphore covers every
# sketch/build/validation/import request in the process, including direct
# interactive validation calls that bypass the background worker's DB lock.
_kernel_semaphore = asyncio.Semaphore(1)


async def _run_kernel_single_flight(
    module_name: str,
    function_name: str,
    *args: object,
    timeout_seconds: float,
) -> object:
    """Count semaphore wait and child execution against one total deadline."""

    try:
        async with asyncio.timeout(timeout_seconds):
            async with _kernel_semaphore:
                return await run_isolated_async(
                    module_name,
                    function_name,
                    *args,
                    timeout_seconds=timeout_seconds,
                )
    except IsolatedExecutionTimeout:
        raise
    except TimeoutError as exc:
        raise IsolatedExecutionTimeout(
            f"{module_name}.{function_name} exceeded total queue + execution "
            f"deadline of {timeout_seconds:.3f}s"
        ) from exc


def require_service_token(
    x_openvac_service_token: Annotated[str | None, Header()] = None,
) -> None:
    if settings.require_service_token and not settings.service_token:
        raise HTTPException(status_code=503, detail="service token is not configured")
    if settings.service_token and x_openvac_service_token != settings.service_token:
        raise HTTPException(status_code=401, detail="invalid service token")


ServiceAuth = Annotated[None, Depends(require_service_token)]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "openvac-modeling"}


@app.get("/ready")
def ready(_: ServiceAuth) -> dict[str, str]:
    try:
        cadquery_version = importlib.metadata.version("cadquery")
        ocp_version = importlib.metadata.version("cadquery-ocp")
        slvs_version = importlib.metadata.version("slvs")
    except importlib.metadata.PackageNotFoundError as exc:
        raise HTTPException(
            status_code=503, detail=f"missing runtime dependency: {exc.name}"
        ) from exc
    return {
        "status": "ready",
        "cadquery": cadquery_version,
        "ocp": ocp_version,
        "slvs": slvs_version,
    }


@app.post("/v1/sketches/solve", response_model=SketchSolveResult)
async def solve_sketch(request: SketchSolveRequest, _: ServiceAuth) -> SketchSolveResult:
    try:
        result = await _run_kernel_single_flight(
            "app.sketch_solver",
            "solve_sketch_payload",
            request.model_dump(mode="json"),
            timeout_seconds=settings.sketch_timeout_seconds,
        )
        return SketchSolveResult.model_validate(result)
    except IsolatedExecutionTimeout:
        return SketchSolveResult(status="timeout", diagnostic="草图求解超过 2 秒限制。")
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc


@app.post("/v1/pumps/validate", response_model=PumpValidationResult)
async def validate_pump(parameters: PumpParameters, _: ServiceAuth) -> PumpValidationResult:
    try:
        result = await _run_kernel_single_flight(
            "app.pump",
            "validate_rotary_vane_pump",
            parameters,
            timeout_seconds=settings.build_timeout_seconds,
        )
        return PumpValidationResult.model_validate(result)
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="旋片泵完整校验超过内核时间限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc


@app.post("/v1/builds", response_model=BuildResponse)
async def build(request: BuildRequest, _: ServiceAuth) -> BuildResponse:
    try:
        result = await _run_kernel_single_flight(
            "app.engine",
            "build_to_artifacts",
            request.job_id,
            request.document,
            request.formats,
            settings.artifact_root,
            request.validate_pump,
            timeout_seconds=settings.build_timeout_seconds,
        )
        return BuildResponse.model_validate(result)
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="建模任务超过内核时间限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc


@app.post("/v1/validations", response_model=BuildResponse)
async def validate_build(request: ValidationRequest, _: ServiceAuth) -> BuildResponse:
    """Run authoritative B-Rep rebuild without producing downloadable artifacts."""
    try:
        result = await _run_kernel_single_flight(
            "app.engine",
            "validate_document",
            request.job_id,
            request.document,
            settings.artifact_root,
            request.validate_pump,
            timeout_seconds=settings.interactive_timeout_seconds,
        )
        return BuildResponse.model_validate(result)
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="交互式重建超过 30 秒限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc
    finally:
        # Synchronous validation has no downloadable artifact lifecycle. Keep
        # its native-kernel workspace request-scoped, including timeout/client
        # cancellation paths, so repeated manual edits cannot fill tmpfs.
        _remove_job_artifact_directory(request.job_id)


async def _receive_trusted_imported_step(
    *,
    job_id: str,
    artifact_id: str,
    expected_sha256: str,
    file: UploadFile,
) -> Path:
    if file.content_type not in {
        "application/step",
        "application/step-file",
        "model/step",
        "application/octet-stream",
    }:
        raise HTTPException(status_code=415, detail="仅支持受信任的 STEP 基础实体。")
    job_dir = (settings.artifact_root / job_id).resolve()
    if settings.artifact_root not in job_dir.parents:
        raise HTTPException(status_code=400, detail="invalid job id")
    job_dir.mkdir(parents=True, exist_ok=True)
    destination = job_dir / f"imported-{artifact_id}.step"
    size = 0
    digest = hashlib.sha256()
    with destination.open("wb") as output:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_step_bytes:
                output.close()
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="STEP 文件超过 50 MB 限制。")
            digest.update(chunk)
            output.write(chunk)
    if size == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="STEP 基础实体不能为空。")
    if digest.hexdigest() != expected_sha256:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="STEP 基础实体 SHA-256 校验失败。")
    return destination


def _parse_imported_document(value: str) -> dict[str, object]:
    if len(value.encode("utf-8")) > 4 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="建模文档超过 4 MB 限制。")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="建模文档 JSON 无效。") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail="建模文档必须是对象。")
    return parsed


@app.post("/v1/builds/imported-step", response_model=BuildResponse)
async def build_with_imported_step(
    _: ServiceAuth,
    job_id: Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{1,120}$")],
    artifact_id: Annotated[
        str,
        Query(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
    ],
    artifact_sha256: Annotated[str, Query(pattern=r"^[a-f0-9]{64}$")],
    document: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    formats: Annotated[
        str,
        Query(pattern=r"^(?:step|stl|glb)(?:,(?:step|stl|glb))*$"),
    ] = "glb",
    validate_pump: bool = False,
) -> BuildResponse:
    destination = await _receive_trusted_imported_step(
        job_id=job_id,
        artifact_id=artifact_id,
        expected_sha256=artifact_sha256,
        file=file,
    )
    try:
        result = await _run_kernel_single_flight(
            "app.engine",
            "build_to_artifacts",
            job_id,
            _parse_imported_document(document),
            list(dict.fromkeys(formats.split(","))),
            settings.artifact_root,
            validate_pump,
            {artifact_id: str(destination)},
            timeout_seconds=settings.build_timeout_seconds,
        )
        return BuildResponse.model_validate(result)
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="建模任务超过内核时间限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc


@app.post("/v1/validations/imported-step", response_model=BuildResponse)
async def validate_with_imported_step(
    _: ServiceAuth,
    job_id: Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{1,120}$")],
    artifact_id: Annotated[
        str,
        Query(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
    ],
    artifact_sha256: Annotated[str, Query(pattern=r"^[a-f0-9]{64}$")],
    document: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    validate_pump: bool = False,
) -> BuildResponse:
    try:
        destination = await _receive_trusted_imported_step(
            job_id=job_id,
            artifact_id=artifact_id,
            expected_sha256=artifact_sha256,
            file=file,
        )
        result = await _run_kernel_single_flight(
            "app.engine",
            "validate_document",
            job_id,
            _parse_imported_document(document),
            settings.artifact_root,
            validate_pump,
            {artifact_id: str(destination)},
            timeout_seconds=settings.interactive_timeout_seconds,
        )
        return BuildResponse.model_validate(result)
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="交互式重建超过 30 秒限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(status_code=422, detail=exc.public_message) from exc
    finally:
        _remove_job_artifact_directory(job_id)


@app.post("/v1/imports/step", response_model=StepImportResponse)
async def import_step(
    _: ServiceAuth,
    job_id: Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{1,120}$")],
    file: Annotated[UploadFile, File()],
    formats: Annotated[
        str,
        Query(pattern=r"^(?:glb|stl)(?:,(?:glb|stl))*$"),
    ] = "glb",
) -> StepImportResponse:
    if file.content_type not in {
        "application/step",
        "application/step-file",
        "model/step",
        "application/octet-stream",
    }:
        raise HTTPException(status_code=415, detail="仅支持 STEP 文件。")
    job_dir = (settings.artifact_root / job_id).resolve()
    if settings.artifact_root not in job_dir.parents:
        raise HTTPException(status_code=400, detail="invalid job id")
    job_dir.mkdir(parents=True, exist_ok=True)
    destination = job_dir / "import.step"
    size = 0
    digest = hashlib.sha256()
    with destination.open("wb") as output:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_step_bytes:
                output.close()
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="STEP 文件超过 50 MB 限制。")
            digest.update(chunk)
            output.write(chunk)
    if size == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="STEP 文件不能为空。")
    try:
        result = await _run_kernel_single_flight(
            "app.engine",
            "import_step_to_artifacts",
            job_id,
            destination,
            settings.artifact_root,
            formats.split(","),
            timeout_seconds=settings.build_timeout_seconds,
        )
        response = StepImportResponse.model_validate(result)
        if response.source_sha256 != digest.hexdigest() or response.source_size_bytes != size:
            raise HTTPException(status_code=422, detail="STEP 导入源校验结果不一致。")
        return response
    except IsolatedExecutionTimeout as exc:
        raise HTTPException(status_code=504, detail="STEP 导入超过 180 秒限制。") from exc
    except IsolatedExecutionError as exc:
        raise HTTPException(
            status_code=422,
            detail="STEP 文件解析失败或未形成有效闭合实体。",
        ) from exc


@app.get("/v1/artifacts/{job_id}/{file_name}")
def artifact(
    job_id: str,
    file_name: str,
    _: ServiceAuth,
) -> FileResponse:
    if not job_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=404)
    if file_name not in {"model.step", "model.stl", "model.glb", "import.step"}:
        raise HTTPException(status_code=404)
    requested = (settings.artifact_root / job_id / file_name).resolve()
    if settings.artifact_root not in requested.parents or not requested.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(
        path=requested,
        media_type={
            ".step": "model/step",
            ".stl": "model/stl",
            ".glb": "model/gltf-binary",
        }.get(Path(file_name).suffix, "application/octet-stream"),
        filename=file_name,
    )


@app.delete("/v1/artifacts/{job_id}")
def delete_artifacts(
    job_id: Annotated[str, ApiPath(pattern=r"^[A-Za-z0-9_-]{1,120}$")],
    _: ServiceAuth,
) -> dict[str, str]:
    """Idempotently remove one service-owned job artifact directory."""

    status = _remove_job_artifact_directory(job_id)
    return {"status": status, "job_id": job_id}


def _remove_job_artifact_directory(job_id: str) -> str:
    """Remove exactly one validated job directory without following links."""

    artifact_root = settings.artifact_root.resolve()
    raw_job_dir = artifact_root / job_id
    if raw_job_dir.is_symlink():
        raise HTTPException(status_code=409, detail="artifact job path is a symlink")
    job_dir = raw_job_dir.resolve()
    if job_dir.parent != artifact_root:
        raise HTTPException(status_code=400, detail="invalid artifact job path")
    if not job_dir.exists():
        return "absent"
    if not job_dir.is_dir():
        raise HTTPException(status_code=409, detail="artifact job path is not a directory")
    try:
        shutil.rmtree(job_dir)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="failed to remove artifact job directory",
        ) from exc
    return "deleted"
