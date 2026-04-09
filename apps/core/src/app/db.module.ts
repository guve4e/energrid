import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        return new Pool({
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT),
          database: process.env.PGDATABASE,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          ssl:
            String(process.env.PGSSL || '').toLowerCase() === 'true'
              ? { rejectUnauthorized: false }
              : false,
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
