import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  EstimateLineResult,
  EstimateResult,
} from '@energrid/domain-estimator';

@Injectable()
export class EstimatesRepository {
  async createEstimate(
    client: PoolClient,
    projectId: string,
    result: EstimateResult,
    source: string = 'manual',
  ) {
    const { rows } = await client.query(
      `
      insert into estimates (
        project_id,
        source,
        subtotal,
        currency,
        confidence,
        needs_inspection,
        assumptions_json
      )
      values ($1,$2,$3,$4,$5,$6,$7)
      returning *
      `,
      [
        projectId,
        source,
        result.subtotal,
        result.currency,
        result.confidence,
        result.needsInspection,
        JSON.stringify(result.assumptions ?? []),
      ],
    );

    return rows[0];
  }

  async createEstimateLines(
    client: PoolClient,
    estimateId: string,
    lines: EstimateLineResult[],
  ) {
    const inserted = [];

    for (const line of lines) {
      const { rows } = await client.query(
        `
        insert into estimate_lines (
          estimate_id,
          code,
          label,
          quantity,
          unit,
          unit_price,
          subtotal
        )
        values ($1,$2,$3,$4,$5,$6,$7)
        returning *
        `,
        [
          estimateId,
          line.code,
          line.label,
          line.quantity,
          line.unit,
          line.unitPrice,
          line.subtotal,
        ],
      );

      inserted.push(rows[0]);
    }

    return inserted;
  }
}
