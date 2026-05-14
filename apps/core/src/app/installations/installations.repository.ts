import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
} from './installations.dto';

@Injectable()
export class InstallationsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createInstallation(dto: CreateInstallationDto) {
    const { rows } = await this.pool.query(
      `
      insert into installations (
        id,
        customer_name,
        customer_phone,
        property_address,
        notes
      )
      values (gen_random_uuid(), $1, $2, $3, $4)
      returning *
      `,
      [dto.customerName, dto.customerPhone ?? null, dto.propertyAddress, dto.notes ?? null],
    );

    return rows[0];
  }

  async listInstallations() {
    const { rows } = await this.pool.query(`
      select *
      from installations
      order by created_at desc
    `);

    return rows;
  }

  async getInstallation(id: string) {
    const installationResult = await this.pool.query(
      `select * from installations where id = $1`,
      [id],
    );

    const installation = installationResult.rows[0];
    if (!installation) return null;

    const panelsResult = await this.pool.query(
      `
      select *
      from installation_panels
      where installation_id = $1
      order by created_at asc
      `,
      [id],
    );

    const serviceEntriesResult = await this.pool.query(
      `
      select *
      from installation_service_entries
      where installation_id = $1
      order by date desc
      `,
      [id],
    );

    const panels = [];

    for (const panel of panelsResult.rows) {
      const circuitsResult = await this.pool.query(
        `
        select *
        from installation_circuits
        where panel_id = $1
        order by circuit_no asc
        `,
        [panel.id],
      );

      panels.push({
        ...panel,
        circuits: circuitsResult.rows,
      });
    }

    return {
      ...installation,
      panels,
      serviceEntries: serviceEntriesResult.rows,
    };
  }

  async createPanel(installationId: string, dto: CreatePanelDto) {
    const { rows } = await this.pool.query(
      `
      insert into installation_panels (
        id,
        installation_id,
        name,
        location,
        main_breaker,
        grounding_type,
        notes
      )
      values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
      returning *
      `,
      [
        installationId,
        dto.name,
        dto.location ?? null,
        dto.mainBreaker ?? null,
        dto.groundingType ?? 'unknown',
        dto.notes ?? null,
      ],
    );

    return rows[0];
  }

  async createCircuit(panelId: string, dto: CreateCircuitDto) {
    const { rows } = await this.pool.query(
      `
      insert into installation_circuits (
        id,
        panel_id,
        circuit_no,
        label,
        breaker_type,
        breaker_amps,
        breaker_curve,
        cable_type,
        cable_mm2,
        rcd_group,
        room,
        notes
      )
      values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      returning *
      `,
      [
        panelId,
        dto.circuitNo,
        dto.label,
        dto.breakerType ?? null,
        dto.breakerAmps ?? null,
        dto.breakerCurve ?? null,
        dto.cableType ?? null,
        dto.cableMm2 ?? null,
        dto.rcdGroup ?? null,
        dto.room ?? null,
        dto.notes ?? null,
      ],
    );

    return rows[0];
  }

  async createServiceEntry(installationId: string, dto: CreateServiceEntryDto) {
    const { rows } = await this.pool.query(
      `
      insert into installation_service_entries (
        id,
        installation_id,
        type,
        date,
        title,
        notes
      )
      values (gen_random_uuid(), $1, $2, coalesce($3::timestamptz, now()), $4, $5)
      returning *
      `,
      [
        installationId,
        dto.type,
        dto.date ?? null,
        dto.title,
        dto.notes ?? null,
      ],
    );

    return rows[0];
  }
}
