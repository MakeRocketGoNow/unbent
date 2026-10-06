/**
 * Which job a run of the one cron trigger is, `17,47 * * * *` in wrangler.toml: the sweep
 * at :17 (lib/sweep.ts) and the daily dumps at :47 (lib/backups.ts). Told apart by the
 * minute the run was scheduled for, not the one it started in, which a late start could
 * push past the half hour. A module of its own so the rule is tested without the entry
 * point, which pulls in the object class.
 */
export function cronJob(scheduledTime: number): 'sweep' | 'dumps' {
  return new Date(scheduledTime).getUTCMinutes() < 30 ? 'sweep' : 'dumps';
}
