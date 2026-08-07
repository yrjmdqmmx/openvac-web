// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SemacadHeroBackdrop } from "./semacad-hero-backdrop";

const originalMatchMedia = window.matchMedia;
let mediaState = { desktop: true, reduced: false, coarse: false };
let mediaListeners = new Map<string, Set<EventListener>>();

function mediaKey(query: string): keyof typeof mediaState {
  if (query.includes("prefers-reduced-motion")) return "reduced";
  if (query.includes("pointer: coarse")) return "coarse";
  return "desktop";
}

function setMedia({ desktop = true, reduced = false, coarse = false } = {}) {
  mediaState = { desktop, reduced, coarse };
  mediaListeners = new Map();
  window.matchMedia = vi.fn((query: string) => {
    const listeners = new Set<EventListener>();
    mediaListeners.set(query, listeners);
    return {
      get matches() {
        return mediaState[mediaKey(query)];
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => {
        listeners.delete(listener);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    } as MediaQueryList;
  });
}

function changeMedia(update: Partial<typeof mediaState>) {
  const changed = new Set(Object.keys(update));
  Object.assign(mediaState, update);
  for (const [query, listeners] of mediaListeners) {
    if (!changed.has(mediaKey(query))) continue;
    for (const listener of listeners) listener(new Event("change"));
  }
}

function stubIntersectionObserver() {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let onIntersection: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        onIntersection = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "0px";
      thresholds = [0];
    }
  );
  return { observe, disconnect, getCallback: () => onIntersection };
}

beforeEach(() => {
  setMedia();
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("SemacadHeroBackdrop", () => {
  it("keeps the static poster and never requests WebGL on mobile", () => {
    setMedia({ desktop: false });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    render(createElement(SemacadHeroBackdrop));

    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );
    expect(getContext).not.toHaveBeenCalled();
  });

  it("keeps the static poster on a landscape touch device", () => {
    setMedia({ desktop: true, coarse: true });
    const rendererFactory = vi.fn();

    render(
      createElement(SemacadHeroBackdrop, { createRenderer: rendererFactory })
    );

    expect(rendererFactory).not.toHaveBeenCalled();
    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );
  });

  it("keeps the static poster when reduced motion is requested", () => {
    setMedia({ reduced: true });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    render(createElement(SemacadHeroBackdrop));

    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );
    expect(getContext).not.toHaveBeenCalled();
  });

  it("falls back to the poster when WebGL cannot be created", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    render(createElement(SemacadHeroBackdrop));

    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );
  });

  it("pauses offscreen and releases animation resources on unmount", () => {
    const stop = vi.fn();
    const start = vi.fn();
    const destroy = vi.fn();
    const { observe, disconnect, getCallback } = stubIntersectionObserver();

    const rendererFactory = vi.fn(() => ({ start, stop, destroy }));
    const { unmount } = render(
      createElement(SemacadHeroBackdrop, { createRenderer: rendererFactory })
    );

    expect(rendererFactory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "webgl"
    );

    act(() => {
      getCallback()?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    expect(stop).toHaveBeenCalledOnce();

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reacts to reduced-motion changes without recreating WebGL", () => {
    stubIntersectionObserver();
    const stop = vi.fn();
    const start = vi.fn();
    const rendererFactory = vi.fn(() => ({
      start,
      stop,
      destroy: vi.fn()
    }));
    render(
      createElement(SemacadHeroBackdrop, { createRenderer: rendererFactory })
    );

    act(() => changeMedia({ reduced: true }));
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );

    act(() => changeMedia({ reduced: false }));
    expect(rendererFactory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "webgl"
    );
  });

  it("does not start while hidden and never restarts after context loss", () => {
    stubIntersectionObserver();
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const stop = vi.fn();
    const start = vi.fn();
    const rendererFactory = vi.fn(() => ({
      start,
      stop,
      destroy: vi.fn()
    }));
    const { container } = render(
      createElement(SemacadHeroBackdrop, { createRenderer: rendererFactory })
    );

    expect(start).not.toHaveBeenCalled();
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(start).toHaveBeenCalledOnce();

    const canvas = container.querySelector("canvas");
    act(() => {
      canvas?.dispatchEvent(
        new Event("webglcontextlost", { cancelable: true })
      );
    });
    expect(stop).toHaveBeenCalled();
    expect(screen.getByTestId("semacad-hero-backdrop")).toHaveAttribute(
      "data-renderer",
      "poster"
    );

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => changeMedia({ reduced: true }));
    act(() => changeMedia({ reduced: false }));
    expect(start).toHaveBeenCalledOnce();
  });
});
