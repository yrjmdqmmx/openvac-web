import asyncio
import multiprocessing as mp
import time

import pytest

from app.isolation import (
    IsolatedExecutionError,
    IsolatedExecutionTimeout,
    ReusableIsolatedExecutor,
    run_isolated,
    run_isolated_async,
)


def test_public_error_keeps_diagnostic_but_hides_traceback() -> None:
    error = IsolatedExecutionError(
        "ValueError",
        "feature hole requires an existing body",
        'Traceback: File "/private/service/app/engine.py"',
    )
    assert error.public_message == "feature hole requires an existing body"
    assert "/private/service" not in error.public_message


def test_sync_timeout_terminates_the_child() -> None:
    before = {process.pid for process in mp.active_children()}
    with pytest.raises(IsolatedExecutionTimeout):
        run_isolated("time", "sleep", 2, timeout_seconds=0.05)
    after = {process.pid for process in mp.active_children()}
    assert after == before


def test_async_cancellation_terminates_the_child() -> None:
    async def scenario() -> float:
        before = {process.pid for process in mp.active_children()}
        task = asyncio.create_task(run_isolated_async("time", "sleep", 5, timeout_seconds=10))
        await asyncio.sleep(0.08)
        started = time.perf_counter()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert {process.pid for process in mp.active_children()} == before
        return time.perf_counter() - started

    assert asyncio.run(scenario()) < 1


def test_reusable_executor_keeps_calls_in_one_child() -> None:
    with ReusableIsolatedExecutor(preload_targets=()) as executor:
        first_pid = executor.call("os", "getpid", timeout_seconds=2)
        second_pid = executor.call("os", "getpid", timeout_seconds=2)

        assert first_pid == second_pid
        assert first_pid == executor.pid


def test_reusable_executor_restarts_after_timeout() -> None:
    with ReusableIsolatedExecutor(preload_targets=()) as executor:
        first_pid = executor.call("os", "getpid", timeout_seconds=2)
        with pytest.raises(IsolatedExecutionTimeout):
            executor.call("time", "sleep", 2, timeout_seconds=0.05)
        assert executor.pid is None

        replacement_pid = executor.call("os", "getpid", timeout_seconds=2)
        assert replacement_pid != first_pid


def test_reusable_executor_keeps_process_after_deterministic_error() -> None:
    with ReusableIsolatedExecutor(preload_targets=()) as executor:
        first_pid = executor.call("os", "getpid", timeout_seconds=2)
        with pytest.raises(IsolatedExecutionError, match="invalid literal"):
            executor.call("builtins", "int", "not-a-number", timeout_seconds=2)

        assert executor.call("os", "getpid", timeout_seconds=2) == first_pid


def test_reusable_executor_restarts_after_child_crash() -> None:
    with ReusableIsolatedExecutor(preload_targets=()) as executor:
        first_pid = executor.call("os", "getpid", timeout_seconds=2)
        with pytest.raises(IsolatedExecutionError, match="exited without a result"):
            executor.call("os", "_exit", 17, timeout_seconds=2)
        assert executor.pid is None

        replacement_pid = executor.call("os", "getpid", timeout_seconds=2)
        assert replacement_pid != first_pid


def test_reusable_executor_cancellation_discards_active_child() -> None:
    async def scenario() -> None:
        with ReusableIsolatedExecutor(preload_targets=()) as executor:
            first_pid = await executor.call_async("os", "getpid", timeout_seconds=2)
            task = asyncio.create_task(executor.call_async("time", "sleep", 5, timeout_seconds=10))
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert executor.pid is None

            replacement_pid = await executor.call_async("os", "getpid", timeout_seconds=2)
            assert replacement_pid != first_pid

    asyncio.run(scenario())
