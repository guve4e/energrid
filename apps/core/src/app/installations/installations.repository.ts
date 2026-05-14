import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
  UpdateCircuitDto,
  UpdateInstallationDto,
  UpdatePanelDto,
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

  async updateInstallation(id: string, dto: UpdateInstallationDto) {
    const { rows } = await this.pool.query(
      `
      update installations
      set
        customer_name = coalesce($2, customer_name),
        customer_phone = coalesce($3, customer_phone),
        property_address = coalesce($4, property_address),
        status = coalesce($5, status),
        notes = coalesce($6, notes),
        updated_at = now()
      where id = $1
      returning *
      `,
      [
        id,
        dto.customerName ?? null,
        dto.customerPhone ?? null,
        dto.propertyAddress ?? null,
        dto.status ?? null,
        dto.notes ?? null,
      ],
    );

    return rows[0] ?? null;
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

  async updatePanel(id: string, dto: UpdatePanelDto) {
    const { rows } = await this.pool.query(
      `
      update installation_panels
      set
        name = coalesce($2, name),
        location = coalesce($3, location),
        main_breaker = coalesce($4, main_breaker),
        grounding_type = coalesce($5, grounding_type),
        notes = coalesce($6, notes),
        updated_at = now()
      where id = $1
      returning *
      `,
      [
        id,
        dto.name ?? null,
        dto.location ?? null,
        dto.mainBreaker ?? null,
        dto.groundingType ?? null,
        dto.notes ?? null,
      ],
    );

    return rows[0] ?? null;
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

  async updateCircuit(id: string, dto: UpdateCircuitDto) {
    const { rows } = await this.pool.query(
      `
      update installation_circuits
      set
        circuit_no = coalesce($2, circuit_no),
        label = coalesce($3, label),
        breaker_type = coalesce($4, breaker_type),
        breaker_amps = coalesce($5, breaker_amps),
        breaker_curve = coalesce($6, breaker_curve),
        cable_type = coalesce($7, cable_type),
        cable_mm2 = coalesce($8, cable_mm2),
        rcd_group = coalesce($9, rcd_group),
        room = coalesce($10, room),
        notes = coalesce($11, notes),
        updated_at = now()
      where id = $1
      returning *
      `,
      [
        id,
        dto.circuitNo ?? null,
        dto.label ?? null,
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

    return rows[0] ?? null;
  }

  async deleteCircuit(id: string) {
    const { rowCount } = await this.pool.query(
      `delete from installation_circuits where id = $1`,
      [id],
    );

    return (rowCount ?? 0) > 0;
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
