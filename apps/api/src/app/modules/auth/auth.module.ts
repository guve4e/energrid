import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common'
import { Pool } from 'pg'
import { AUTH_POOL } from './auth.types'
import { AuthConfig } from './auth-config'
import { AccessTokenService } from './access-token.service'
import { AuthRepository } from './auth.repository'
import { PasswordHasher } from './password-hasher'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { AccessJwtGuard, RoleGuard } from './auth.guard'

function createAuthPool(): Pool {
  const authDatabaseUrl = process.env.AUTH_DATABASE_URL?.trim()
  if (authDatabaseUrl) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_DATABASE_URL is for isolated local development only; production auth uses the configured PostgreSQL connection')
    let parsed: URL
    try { parsed = new URL(authDatabaseUrl) } catch { throw new Error('AUTH_DATABASE_URL must be a PostgreSQL connection URL') }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1' && parsed.hostname !== 'localhost') {
      throw new Error('AUTH_DATABASE_URL is only supported for loopback local development; use the configured PostgreSQL connection in production')
    }
    return new Pool({ connectionString: authDatabaseUrl, max: 4, connectionTimeoutMillis: 5000,
      query_timeout: 15000, statement_timeout: 10000, application_name: 'energrid-auth' })
  }
  const { PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: user, PGPASSWORD: password, PGSSL } = process.env
  if (!host || !port || !database || !user || !password) {
    throw new Error('Authentication requires PostgreSQL: configure PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD')
  }
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Invalid PostgreSQL port')
  const pool = new Pool({ host, port: portNumber, database, user, password, ssl: PGSSL?.toLowerCase() === 'true',
    max: 4, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 10000, application_name: 'energrid-auth' })
  pool.on('error', () => undefined)
  return pool
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthConfig,
    { provide: AUTH_POOL, useFactory: createAuthPool },
    { provide: AuthRepository, inject: [AUTH_POOL], useFactory: (pool: Pool) => new AuthRepository(pool) },
    PasswordHasher,
    AccessTokenService,
    AuthService,
    AccessJwtGuard,
    RoleGuard,
  ],
  exports: [AuthConfig, AuthService, AccessTokenService, AccessJwtGuard, RoleGuard, AuthRepository],
})
export class AuthModule implements OnModuleDestroy {
  constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}
  async onModuleDestroy() { await this.pool.end() }
}
