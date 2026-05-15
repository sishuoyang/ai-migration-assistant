import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchDefaultOlapQueries } from "../lib/prompts";

interface OlapQueriesValue {
  /** Current OLAP query text — the value the partner will see fired into prompts. */
  queries: string;
  /** Default for the current source (fetched from the API). */
  defaults: string;
  /** True if the user has edited away from the defaults. */
  isCustom: boolean;
  /** Replace the queries. Empty string resets to defaults. */
  setQueries: (next: string) => void;
  /** Force a reload of the defaults from the API. */
  resetToDefaults: () => void;
}

const Ctx = createContext<OlapQueriesValue | null>(null);

interface ProviderProps {
  /** Source id; empty string disables the fetch (e.g. while the source
   *  list is still loading). */
  source: string;
  children: ReactNode;
}

export function OlapQueriesProvider({ source, children }: ProviderProps) {
  const [queries, setQueriesState] = useState<string>("");
  const [defaults, setDefaults] = useState<string>("");

  // Re-fetch defaults whenever the source changes, and reset the
  // in-memory queries to the new defaults so the next button click
  // sends the appropriate query set for the picked source.
  useEffect(() => {
    if (!source) {
      setDefaults("");
      setQueriesState("");
      return;
    }
    let cancelled = false;
    fetchDefaultOlapQueries(source)
      .then((text) => {
        if (cancelled) return;
        setDefaults(text);
        setQueriesState(text);
      })
      .catch(() => {
        if (cancelled) return;
        setDefaults("");
        setQueriesState("");
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const setQueries = useCallback((next: string) => {
    setQueriesState(next);
  }, []);

  const resetToDefaults = useCallback(() => {
    setQueriesState(defaults);
  }, [defaults]);

  const value = useMemo<OlapQueriesValue>(
    () => ({
      queries,
      defaults,
      isCustom: queries.trim() !== defaults.trim(),
      setQueries,
      resetToDefaults,
    }),
    [queries, defaults, setQueries, resetToDefaults],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOlapQueries(): OlapQueriesValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useOlapQueries must be used inside <OlapQueriesProvider>");
  }
  return v;
}
