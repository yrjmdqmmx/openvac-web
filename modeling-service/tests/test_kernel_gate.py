import asyncio

import pytest

import app.main as main_module
from app.isolation import IsolatedExecutionTimeout


def test_native_kernel_requests_are_globally_single_flight(monkeypatch) -> None:
    async def scenario() -> None:
        active = 0
        maximum_active = 0

        async def fake_isolated(*args, timeout_seconds):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.03)
            active -= 1
            return args[-1]

        monkeypatch.setattr(main_module, "_kernel_semaphore", asyncio.Semaphore(1))
        monkeypatch.setattr(main_module, "run_isolated_async", fake_isolated)
        results = await asyncio.gather(
            main_module._run_kernel_single_flight("module", "function", "first", timeout_seconds=1),
            main_module._run_kernel_single_flight(
                "module", "function", "second", timeout_seconds=1
            ),
        )

        assert results == ["first", "second"]
        assert maximum_active == 1

    asyncio.run(scenario())


def test_kernel_queue_wait_counts_toward_deadline_and_releases_slot(
    monkeypatch,
) -> None:
    async def scenario() -> None:
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        invocations: list[str] = []

        async def fake_isolated(*args, timeout_seconds):
            label = str(args[-1])
            invocations.append(label)
            if label == "first":
                first_started.set()
                await release_first.wait()
            return label

        monkeypatch.setattr(main_module, "_kernel_semaphore", asyncio.Semaphore(1))
        monkeypatch.setattr(main_module, "run_isolated_async", fake_isolated)
        first = asyncio.create_task(
            main_module._run_kernel_single_flight("module", "function", "first", timeout_seconds=1)
        )
        await first_started.wait()

        with pytest.raises(IsolatedExecutionTimeout, match=r"queue \+ execution"):
            await main_module._run_kernel_single_flight(
                "module", "function", "queued", timeout_seconds=0.02
            )
        assert invocations == ["first"]

        release_first.set()
        assert await first == "first"
        assert (
            await main_module._run_kernel_single_flight(
                "module", "function", "after", timeout_seconds=1
            )
            == "after"
        )

    asyncio.run(scenario())


def test_cancelling_active_kernel_request_releases_global_slot(monkeypatch) -> None:
    async def scenario() -> None:
        started = asyncio.Event()

        async def fake_isolated(*args, timeout_seconds):
            label = str(args[-1])
            if label == "cancelled":
                started.set()
                await asyncio.Event().wait()
            return label

        monkeypatch.setattr(main_module, "_kernel_semaphore", asyncio.Semaphore(1))
        monkeypatch.setattr(main_module, "run_isolated_async", fake_isolated)
        active = asyncio.create_task(
            main_module._run_kernel_single_flight(
                "module", "function", "cancelled", timeout_seconds=1
            )
        )
        await started.wait()
        active.cancel()
        with pytest.raises(asyncio.CancelledError):
            await active

        assert (
            await main_module._run_kernel_single_flight(
                "module", "function", "after-cancel", timeout_seconds=1
            )
            == "after-cancel"
        )

    asyncio.run(scenario())
