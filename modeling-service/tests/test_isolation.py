import asyncio
import multiprocessing as mp
import time

import pytest

from app.isolation import (
    IsolatedExecutionError,
    IsolatedExecutionTimeout,
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
