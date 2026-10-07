import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api';

export interface ObserverFetchState<T> {
  data: T | null;
  warnings: string[];
  loading: boolean;
  error: string | null;
}

/**
 * Sequence-guarded observer fetch: late responses never overwrite a newer
 * load, and unmounts never commit. Mirrors the use-workbench guards.
 * Pass enabled=false to keep a tab's query idle until its tab is active.
 */
export function useObserverFetch<T>(loader: () => Promise<{ data: T; warnings: string[] }>, deps: unknown[], enabled = true): ObserverFetchState<T> & { reload: () => void } {
  const [state, setState] = useState<ObserverFetchState<T>>({ data: null, warnings: [], loading: true, error: null });
  const sequence = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setState(current => ({ ...current, loading: true, error: null }));
    try {
      const result = await loaderRef.current();
      if (request !== sequence.current) return;
      setState({ data: result.data, warnings: result.warnings, loading: false, error: null });
    } catch (error) {
      if (request !== sequence.current) return;
      const message = error instanceof ApiError
        ? error.message
        : error instanceof DOMException && error.name === 'TimeoutError'
          ? 'The local service did not respond in time. Retry when the local service is available.'
          : 'The observed data could not be read. Retry when the local service is available.';
      setState(current => ({ ...current, loading: false, error: message }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState(current => (current.loading ? { ...current, loading: false } : current));
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { ...state, reload: load };
}

export function WarningsStrip({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="status" className="border-l-2 border-warning bg-warning-background px-4 py-2 text-xs leading-5 text-warning">
      {warnings.map(warning => <p key={warning}>{warning}</p>)}
    </div>
  );
}
