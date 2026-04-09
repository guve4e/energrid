import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface CreateProjectInput {
  tenantSlug: string;
  leadId?: string | null;
  conversationId?: string | null;
  status?: string;
  name?: string | null;
  city?: string | null;
  address?: string | null;
}

@Injectable()
export class ProjectsRepository {
  async create(client: PoolClient, input: CreateProjectInput) {
    const { rows } = await client.query(
      `
      insert into projects (
        tenant_slug,
        lead_id,
        conversation_id,
        status,
        name,
        city,
        address
      )
      values ($1,$2,$3,$4,$5,$6,$7)
      returning *
      `,
      [
        input.tenantSlug,
        input.leadId ?? null,
        input.conversationId ?? null,
        input.status ?? 'estimated',
        input.name ?? null,
        input.city ?? null,
        input.address ?? null,
      ],
    );

    return rows[0];
  }
}
