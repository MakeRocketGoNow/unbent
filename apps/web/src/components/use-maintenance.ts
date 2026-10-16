import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface Maintenance {
  busy: boolean;
  /** Human-readable summary of the last successful run. */
  result: string | null;
  error: string | null;
  /** Runs one action, tracking state and invalidating every cached query afterwards, even on failure. */
  run: (action: () => Promise<string>) => Promise<void>;
  /** Clears the last result or error, so a panel can be reset between runs. */
  reset: () => void;
}

/**
 * Runs one destructive maintenance action.
 *
 * Shared because emptying the trash is offered in two places: the trash view, where you
 * can see what you are about to destroy and restore anything first, and the maintenance
 * page, which has to list every destructive operation to be worth trusting. Two copies
 * would drift on what they invalidate, and a missed invalidation here leaves a note on
 * screen that no longer exists.
 *
 * Invalidation is deliberately unscoped: these actions delete notes, attachments and the
 * counts derived from them, so nothing cached is still known to be true.
 */
export function useMaintenance(): Maintenance {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Whether or not it finished: a purge is several requests, and one that fails
      // partway has still deleted everything before the failure.
      await queryClient.invalidateQueries();
      setBusy(false);
    }
  }

  return {
    busy,
    result,
    error,
    run,
    reset: () => {
      setResult(null);
      setError(null);
    },
  };
}
