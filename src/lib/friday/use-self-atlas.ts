import { useCallback, useState, useSyncExternalStore } from "react";
import {
  latestAtlas,
  latestReliability,
  refreshAtlas,
  refreshReliability,
  selfAtlasAvailable,
  selfAtlasVersion,
  subscribeSelfAtlas,
  type AtlasSnapshot,
  type ReliabilityReport,
} from "./self-atlas";

export type SelfAtlasView = {
  atlas: AtlasSnapshot | null;
  reliability: ReliabilityReport | null;
  /** The probes exist only in the desktop app. */
  available: boolean;
  loading: boolean;
  error: string | null;
  /** Read both again now, past the freshness window. */
  refresh: () => Promise<void>;
};

/**
 * The Self Atlas and the PC reliability report for a page. The shared live poller reads them on
 * a schedule; this hook only re-renders on a new answer and offers the Refresh and Retry action.
 */
export function useSelfAtlas(): SelfAtlasView {
  useSyncExternalStore(subscribeSelfAtlas, selfAtlasVersion, selfAtlasVersion);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        refreshAtlas(Date.now(), { force: true, strict: true }),
        refreshReliability(Date.now(), { force: true, strict: true }),
      ]);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    atlas: latestAtlas(),
    reliability: latestReliability(),
    available: selfAtlasAvailable(),
    loading,
    error,
    refresh,
  };
}
