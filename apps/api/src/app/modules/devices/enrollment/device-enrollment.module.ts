import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { DeviceEnrollmentService } from './device-enrollment.service';
import { PostgresDeviceEnrollmentRepository } from './postgres-device-enrollment.repository';
import { PhysicalDeviceInventoryService } from './physical-device-inventory.service';
import { PostgresPhysicalDeviceInventoryRepository } from './postgres-physical-device-inventory.repository';

export const DEVICE_ENROLLMENT_SERVICE = Symbol(
  'DEVICE_ENROLLMENT_SERVICE',
);
export const PHYSICAL_DEVICE_INVENTORY_SERVICE = Symbol('PHYSICAL_DEVICE_INVENTORY_SERVICE');

const ENROLLMENT_POOL = Symbol('ENROLLMENT_POOL');

function createEnrollmentPool(): Pool {
  const {
    PGHOST: host,
    PGPORT: port,
    PGDATABASE: database,
    PGUSER: user,
    PGPASSWORD: password,
    PGSSL,
  } = process.env;

  if (!host || !port || !database || !user || !password) {
    throw new Error(
      'Device enrollment requires PostgreSQL configuration: ' +
      'PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD.',
    );
  }

  const portNumber = Number(port);

  if (
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    throw new Error('Invalid PostgreSQL port');
  }

  return new Pool({
    host,
    port: portNumber,
    database,
    user,
    password,
    ssl: PGSSL?.toLowerCase() === 'true',
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    statement_timeout: 10000,
    application_name: 'energrid-device-enrollment',
  });
}

@Module({
  providers: [
    {
      provide: ENROLLMENT_POOL,
      useFactory: createEnrollmentPool,
    },
    {
      provide: DEVICE_ENROLLMENT_SERVICE,
      inject: [ENROLLMENT_POOL],
      useFactory: (pool: Pool) =>
        new DeviceEnrollmentService(
          new PostgresDeviceEnrollmentRepository(pool),
        ),
    },
    {
      provide: PHYSICAL_DEVICE_INVENTORY_SERVICE,
      inject: [ENROLLMENT_POOL, DEVICE_ENROLLMENT_SERVICE],
      useFactory: (pool: Pool, enrollment: DeviceEnrollmentService) =>
        new PhysicalDeviceInventoryService(
          new PostgresPhysicalDeviceInventoryRepository(pool), enrollment,
        ),
    },
  ],
  exports: [DEVICE_ENROLLMENT_SERVICE, PHYSICAL_DEVICE_INVENTORY_SERVICE],
})
export class DeviceEnrollmentModule implements OnModuleDestroy {
  constructor(
    @Inject(ENROLLMENT_POOL)
    private readonly pool: Pool,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
