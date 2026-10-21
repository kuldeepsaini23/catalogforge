"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fetches JSON and optionally re-polls. Keeps the last good data while refreshing so tables don't
 * flash; aborts in-flight requests when the URL changes or the component unmounts.
 */
export function useJson<T>(url: string | null, pollMs?: number | false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The URL whose response is currently shown; loading = a different URL is in flight.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    controller.current?.abort();
    controller.current = ac;
    fetch(url, { signal: ac.signal, cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
        setData(body as T);
        setError(null);
        setLoadedUrl(url);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoadedUrl(url);
      });
    return () => ac.abort();
  }, [url, tick]);

  useEffect(() => {
    if (!url || !pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, pollMs);
    return () => clearInterval(id);
  }, [url, pollMs]);

  return { data, error, loading: Boolean(url) && loadedUrl !== url, refresh: () => setTick((t) => t + 1), setData };
}

export async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Subscribes to a Server-Sent Events stream of JSON messages; reconnects are handled by EventSource. */
export function useEventStream<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.onmessage = (e) => setData(JSON.parse(e.data) as T);
    // The server closes the stream when the import finishes; don't reconnect after that.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) es.close();
    };
    return () => es.close();
  }, [url]);
  return data;
}
