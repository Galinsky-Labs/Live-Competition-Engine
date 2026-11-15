import { DomainError } from "@live-competition-engine/domain";
import type { JudgeStatusReport, JudgeStatusSource } from "./control-room.ts";
import { getSqlClient } from "./index.ts";

/**
 * Control-room judge status backed by LC-19/LC-20 data. The expected judges for a
 * performance are the round's active panel (falling back to every competition judge
 * when no panel is assigned), minus judges with an active recusal for the entry.
 * `submitted` is true only when a submitted (immutable) score sheet exists.
 */
export const scoringJudgeStatusSource: JudgeStatusSource = {
  async forPerformance(organizationId, competitionId, performanceId): Promise<JudgeStatusReport> {
    const sql = getSqlClient();
    const [performance] = await sql<{ round_id: string; entry_id: string }[]>`
      SELECT round_id, entry_id FROM performances
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${performanceId}
    `;
    if (!performance) throw new DomainError("performance_not_found");
    const rows = await sql<{ id: string; display_name: string; submitted: boolean }[]>`
      WITH panel AS (
        SELECT judge_id FROM round_judge_panels
        WHERE organization_id = ${organizationId} AND round_id = ${performance.round_id} AND removed_at IS NULL
      ), expected AS (
        SELECT cj.judge_id FROM competition_judges cj
        WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${competitionId}
          AND (NOT EXISTS (SELECT 1 FROM panel) OR cj.judge_id IN (SELECT judge_id FROM panel))
          AND NOT EXISTS (
            SELECT 1 FROM judge_recusals r
            WHERE r.organization_id = ${organizationId} AND r.competition_id = ${competitionId}
              AND r.judge_id = cj.judge_id AND r.entry_id = ${performance.entry_id} AND r.rescinded_at IS NULL
          )
      )
      SELECT j.id, j.display_name, EXISTS (
        SELECT 1 FROM score_sheets s
        WHERE s.organization_id = ${organizationId} AND s.performance_id = ${performanceId}
          AND s.judge_id = j.id AND s.status = 'submitted'
      ) AS submitted
      FROM expected e JOIN judges j ON j.id = e.judge_id AND j.organization_id = ${organizationId}
      ORDER BY j.display_name, j.id
    `;
    return {
      performanceId,
      source: "scoring",
      status: "known",
      judges: rows.map(row => ({ judgeId: row.id, displayName: row.display_name, submitted: row.submitted }))
    };
  }
};
