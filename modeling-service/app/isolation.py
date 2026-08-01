from __future__ import annotations

import asyncio
import importlib
import multiprocessing as mp
import time
import traceback
from multiprocessing.connection import Connection
from typing import Any


class IsolatedExecutionError(RuntimeError):
    def __init__(
        self,
        child_type: str,
        child_message: str,
        child_traceback: str = "",
    ) -> None:
        self.child_type = child_type
        self.child_message = child_message
        self.child_traceback = child_traceback
        super().__init__(
            f"{child_type}: {child_message}" + (f"\n{child_traceback}" if child_traceback else "")
        )

    @property
    def public_message(self) -> str:
        # The deterministic ValueError text identifies the failed feature or
        # constraint. Tracebacks and filesystem paths remain internal.
        message = " ".join(self.child_message.split())[:500]
        return message or "确定性 CAD 内核拒绝了该规格。"


class IsolatedExecutionTimeout(TimeoutError):
    pass


def _child_entry(
    connection: Connection,
    module_name: str,
    function_name: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> None:
    try:
        module = importlib.import_module(module_name)
        function = getattr(module, function_name)
        result = function(*args, **kwargs)
        if hasattr(result, "model_dump"):
            result = result.model_dump(mode="json")
        connection.send(("ok", result))
    except BaseException as exc:  # noqa: BLE001 - process boundary must capture kernel crashes
        connection.send(
            (
                "error",
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=20),
                },
            )
        )
    finally:
        connection.close()


def run_isolated(
    module_name: str,
    function_name: str,
    *args: Any,
    timeout_seconds: float,
    **kwargs: Any,
) -> Any:
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    process, parent_connection = _start_process(module_name, function_name, args, kwargs)
    try:
        if not parent_connection.poll(timeout_seconds):
            _stop_process(process)
            raise IsolatedExecutionTimeout(
                f"{module_name}.{function_name} exceeded {timeout_seconds:.3f}s"
            )
        response = parent_connection.recv()
        process.join(timeout=2)
        return _decode_response(response)
    finally:
        parent_connection.close()
        if process.is_alive():
            _stop_process(process)


async def run_isolated_async(
    module_name: str,
    function_name: str,
    *args: Any,
    timeout_seconds: float,
    **kwargs: Any,
) -> Any:
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    process, parent_connection = _start_process(module_name, function_name, args, kwargs)
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            if parent_connection.poll(0):
                response = parent_connection.recv()
                process.join(timeout=2)
                return _decode_response(response)
            if not process.is_alive():
                process.join(timeout=2)
                if parent_connection.poll(0):
                    return _decode_response(parent_connection.recv())
                raise IsolatedExecutionError(
                    "ProcessExit",
                    f"{module_name}.{function_name} exited without a result "
                    f"(exit code {process.exitcode}).",
                )
            if time.monotonic() >= deadline:
                _stop_process(process)
                raise IsolatedExecutionTimeout(
                    f"{module_name}.{function_name} exceeded {timeout_seconds:.3f}s"
                )
            await asyncio.sleep(0.02)
    except asyncio.CancelledError:
        # A cancelled worker request must release native-kernel CPU and memory;
        # leaving the to_thread child alive would make API cancellation cosmetic.
        _stop_process(process)
        raise
    finally:
        parent_connection.close()
        if process.is_alive():
            _stop_process(process)


def _start_process(
    module_name: str,
    function_name: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> tuple[mp.Process, Connection]:
    context = mp.get_context("spawn")
    parent_connection, child_connection = context.Pipe(duplex=False)
    process = context.Process(
        target=_child_entry,
        args=(child_connection, module_name, function_name, args, kwargs),
        daemon=True,
    )
    process.start()
    child_connection.close()
    return process, parent_connection


def _stop_process(process: mp.Process) -> None:
    if not process.is_alive():
        process.join(timeout=2)
        return
    process.terminate()
    process.join(timeout=2)
    if process.is_alive():
        process.kill()
        process.join(timeout=2)


def _decode_response(response: tuple[str, Any]) -> Any:
    status, payload = response
    if status == "error":
        raise IsolatedExecutionError(
            str(payload.get("type", "KernelError")),
            str(payload.get("message", "deterministic kernel failed")),
            str(payload.get("traceback", "")),
        )
    if status != "ok":
        raise IsolatedExecutionError("ProtocolError", "isolated process returned an unknown status")
    return payload
