import { env } from "../env.js";
import { listTeams, getTeam } from "../db/teams.js";
import type { TeamInfra } from "../types.js";

/** Fully-resolved infra for a team (every field concrete, env as fallback). */
export interface ResolvedInfra {
  recording_bucket: string;
  output_bucket: string;
  transcription_queue_url: string;
  audit_queue_url: string;
  batch_size: number;
  wait_time_seconds: number;
  max_receive_count: number;
  worker_concurrency: number;
}

/** Merge a (possibly partial) per-team infra block over the global env defaults. */
export function resolveInfra(infra?: TeamInfra | null): ResolvedInfra {
  return {
    recording_bucket: infra?.recording_bucket || env.S3_RECORDING_BUCKET,
    output_bucket: infra?.output_bucket || env.S3_OUTPUT_BUCKET,
    transcription_queue_url: infra?.transcription_queue_url || env.SQS_TRANSCRIPTION_QUEUE_URL,
    audit_queue_url: infra?.audit_queue_url || env.SQS_AUDIT_QUEUE_URL,
    batch_size: infra?.batch_size ?? env.SQS_BATCH_SIZE,
    wait_time_seconds: infra?.wait_time_seconds ?? env.SQS_WAIT_TIME_SECONDS,
    max_receive_count: infra?.max_receive_count ?? env.SQS_MAX_RECEIVE_COUNT,
    worker_concurrency: infra?.worker_concurrency ?? env.WORKER_CONCURRENCY,
  };
}

/** Resolve a team id (or null = global default) to its effective infra. */
export async function resolveTeamInfra(teamId: string | null): Promise<ResolvedInfra> {
  if (!teamId) return resolveInfra(undefined);
  const team = await getTeam(teamId);
  return resolveInfra(team?.infra);
}

export interface QueueTarget {
  queueUrl: string;
  teamId: string | null; // null = the global/default queue (shared teams)
  tuning: ResolvedInfra;
}

/**
 * Discover the distinct SQS queues a worker should consume for a given stage:
 *  - the global/default queue (covers all teams without their own queue), plus
 *  - one queue per active team that configured a *distinct* custom queue url.
 * De-duplicates so a team falling back to the global url doesn't double-consume.
 */
export async function resolveQueueTargets(stage: "transcription" | "audit"): Promise<QueueTarget[]> {
  const pick = (i: ResolvedInfra) => (stage === "transcription" ? i.transcription_queue_url : i.audit_queue_url);

  const targets: QueueTarget[] = [];
  const seen = new Set<string>();

  const globalTuning = resolveInfra(undefined);
  const globalUrl = pick(globalTuning);
  if (globalUrl) {
    seen.add(globalUrl);
    targets.push({ queueUrl: globalUrl, teamId: null, tuning: globalTuning });
  }

  for (const team of await listTeams()) {
    if (team.active === false) continue;
    const tuning = resolveInfra(team.infra);
    const url = pick(tuning);
    if (url && !seen.has(url)) {
      seen.add(url);
      targets.push({ queueUrl: url, teamId: team.team_id, tuning });
    }
  }
  return targets;
}
