from __future__ import annotations

import asyncio
import importlib
import multiprocessing as mp
import os
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


DEFAULT_KERNEL_PRELOAD_TARGETS = (
    ("app.sketch_solver", "preload_solver"),
    ("app.engine", "preload_cad_kernel"),
)


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


def _reusable_child_entry(
    connection: Connection,
    preload_targets: tuple[tuple[str, str], ...],
) -> None:
    """Serve serial kernel calls until the parent shuts down the sandbox.

    The modeling service has one global kernel slot. Keeping that slot in one
    independent process preserves the crash/timeout boundary without paying
    Python, VTK, CadQuery and SolveSpace import cost for every mouse-up edit.
    """

    try:
        for module_name, function_name in preload_targets:
            module = importlib.import_module(module_name)
            getattr(module, function_name)()
        connection.send(("ready", {"pid": os.getpid()}))
    except BaseException as exc:  # noqa: BLE001 - startup failure crosses a process boundary
        connection.send(
            (
                "startup_error",
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=20),
                },
            )
        )
        connection.close()
        return

    try:
        while True:
            request = connection.recv()
            if request == ("shutdown",):
                return
            if not isinstance(request, tuple) or len(request) != 5 or request[0] != "call":
                connection.send(
                    (
                        "error",
                        {
                            "type": "ProtocolError",
                            "message": "isolated process received an invalid request",
                            "traceback": "",
                        },
                    )
                )
                continue
            _, module_name, function_name, args, kwargs = request
            try:
                module = importlib.import_module(module_name)
                function = getattr(module, function_name)
                result = function(*args, **kwargs)
                if hasattr(result, "model_dump"):
                    result = result.model_dump(mode="json")
                connection.send(("ok", result))
            except BaseException as exc:  # noqa: BLE001 - kernel errors must stay contained
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
    except (EOFError, BrokenPipeError, OSError):
        return
    finally:
        connection.close()


class ReusableIsolatedExecutor:
    """A serial, restartable native-kernel process.

    Calls remain outside the API process. A timeout, cancellation or native
    crash destroys the whole child, and the next call starts a clean one.
    Ordinary deterministic validation errors do not throw away safely loaded
    native libraries.
    """

    def __init__(
        self,
        preload_targets: tuple[tuple[str, str], ...] = DEFAULT_KERNEL_PRELOAD_TARGETS,
    ) -> None:
        self._preload_targets = preload_targets
        self._process: mp.Process | None = None
        self._connection: Connection | None = None
        self._busy = False
        self.last_startup_ms: float | None = None

    @property
    def pid(self) -> int | None:
        if self._process is None or not self._process.is_alive():
            return None
        return self._process.pid

    def start(self, timeout_seconds: float) -> float:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self._process is not None and self._process.is_alive() and self._connection:
            return 0.0
        self.stop()
        started = time.perf_counter()
        context = mp.get_context("spawn")
        parent_connection, child_connection = context.Pipe(duplex=True)
        process = context.Process(
            target=_reusable_child_entry,
            args=(child_connection, self._preload_targets),
            daemon=True,
        )
        self._process = process
        self._connection = parent_connection
        process.start()
        child_connection.close()
        if not parent_connection.poll(timeout_seconds):
            self.stop()
            raise IsolatedExecutionTimeout(
                f"isolated kernel startup exceeded {timeout_seconds:.3f}s"
            )
        try:
            status, payload = parent_connection.recv()
        except (EOFError, OSError) as exc:
            exit_code = process.exitcode
            self.stop()
            raise IsolatedExecutionError(
                "ProcessExit",
                f"isolated kernel exited during startup (exit code {exit_code})",
            ) from exc
        if status != "ready":
            self.stop()
            if status == "startup_error" and isinstance(payload, dict):
                raise IsolatedExecutionError(
                    str(payload.get("type", "KernelStartupError")),
                    str(payload.get("message", "isolated kernel failed to start")),
                    str(payload.get("traceback", "")),
                )
            raise IsolatedExecutionError(
                "ProtocolError", "isolated kernel returned an invalid startup response"
            )
        self.last_startup_ms = (time.perf_counter() - started) * 1000
        return self.last_startup_ms

    def call(
        self,
        module_name: str,
        function_name: str,
        *args: Any,
        timeout_seconds: float,
        **kwargs: Any,
    ) -> Any:
        started = time.monotonic()
        self._begin_call(module_name, function_name, args, kwargs, timeout_seconds)
        try:
            while True:
                remaining = timeout_seconds - (time.monotonic() - started)
                if remaining <= 0:
                    self.stop()
                    raise IsolatedExecutionTimeout(
                        f"{module_name}.{function_name} exceeded {timeout_seconds:.3f}s"
                    )
                response = self._poll_response(min(remaining, 0.05))
                if response is not None:
                    return _decode_response(response)
                self._raise_if_child_exited(module_name, function_name)
        finally:
            self._busy = False

    async def call_async(
        self,
        module_name: str,
        function_name: str,
        *args: Any,
        timeout_seconds: float,
        **kwargs: Any,
    ) -> Any:
        started = time.monotonic()
        self._begin_call(module_name, function_name, args, kwargs, timeout_seconds)
        try:
            while True:
                remaining = timeout_seconds - (time.monotonic() - started)
                if remaining <= 0:
                    self.stop()
                    raise IsolatedExecutionTimeout(
                        f"{module_name}.{function_name} exceeded {timeout_seconds:.3f}s"
                    )
                response = self._poll_response(0)
                if response is not None:
                    return _decode_response(response)
                self._raise_if_child_exited(module_name, function_name)
                await asyncio.sleep(min(0.01, remaining))
        except asyncio.CancelledError:
            self.stop()
            raise
        finally:
            self._busy = False

    def _begin_call(
        self,
        module_name: str,
        function_name: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        timeout_seconds: float,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self._busy:
            raise RuntimeError("isolated kernel executor only accepts serial calls")
        self._busy = True
        try:
            self.start(timeout_seconds)
            if self._connection is None:
                raise IsolatedExecutionError("ProcessExit", "isolated kernel is unavailable")
            self._connection.send(("call", module_name, function_name, args, kwargs))
        except BaseException:
            self._busy = False
            raise

    def _poll_response(self, timeout_seconds: float) -> tuple[str, Any] | None:
        if self._connection is None or not self._connection.poll(timeout_seconds):
            return None
        try:
            return self._connection.recv()
        except (EOFError, OSError):
            return None

    def _raise_if_child_exited(self, module_name: str, function_name: str) -> None:
        if self._process is not None and self._process.is_alive():
            return
        exit_code = self._process.exitcode if self._process is not None else None
        self.stop()
        raise IsolatedExecutionError(
            "ProcessExit",
            f"{module_name}.{function_name} exited without a result (exit code {exit_code}).",
        )

    def stop(self) -> None:
        connection = self._connection
        process = self._process
        self._connection = None
        self._process = None
        if connection is not None:
            if process is not None and process.is_alive():
                try:
                    connection.send(("shutdown",))
                except (BrokenPipeError, EOFError, OSError):
                    pass
            connection.close()
        if process is not None:
            _stop_process(process)

    def __enter__(self) -> "ReusableIsolatedExecutor":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.stop()


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
