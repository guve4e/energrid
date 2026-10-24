#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { Pool } = require('pg')
const { runner } = require('node-pg-migrate')

const root = path.resolve(__dirname, '../../..')
const target = path.join(root, '.env.auth.local')
const database = 'energrid_auth_local'
const username = process.env.USER

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local auth setup cannot run in production.')
  if (!username || !/^[A-Za-z0-9_.-]{1,63}$/.test(username)) throw new Error('Could not determine a safe local PostgreSQL role name.')
  let authDatabaseUrl
  let existingValues
  const createdConfig = !fs.existsSync(target)
  if (!createdConfig) {
    existingValues = require('dotenv').parse(fs.readFileSync(target))
    authDatabaseUrl = existingValues.AUTH_DATABASE_URL
    let existing
    try { existing = new URL(authDatabaseUrl) } catch { throw new Error('Existing local auth configuration has no valid AUTH_DATABASE_URL; it was left unchanged.') }
    if (existing.hostname !== '127.0.0.1' || existing.port !== '5432' || existing.pathname !== `/${database}` || decodeURIComponent(existing.username) !== username) {
      throw new Error('Existing local auth database is not the expected loopback database; it was left unchanged.')
    }
    const expectedLocal = { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: database, PGUSER: username, PGSSL: 'false' }
    for (const [key, value] of Object.entries(expectedLocal)) {
      if (existingValues[key] && existingValues[key] !== value) throw new Error(`Existing ${key} points away from the isolated local auth database; configuration was left unchanged.`)
    }
    if (existingValues.DATABASE_URL && existingValues.DATABASE_URL !== authDatabaseUrl) throw new Error('Existing DATABASE_URL is not the isolated local database; configuration was left unchanged.')
  } else {
    authDatabaseUrl = `postgres://${encodeURIComponent(username)}@127.0.0.1:5432/${database}`
  }

  const admin = new Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: username, password: '',
    max: 1, connectionTimeoutMillis: 2500, application_name: 'energrid-auth-local-setup' })
  try {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${username}"`)
  } catch (error) {
    if (error.code !== '42P04') throw new Error('Could not create the isolated local auth database. Confirm local PostgreSQL is running and your local role can create databases.')
  } finally { await admin.end() }

  await runner({ databaseUrl: authDatabaseUrl, dir: path.join(root, 'apps/core/migrations'),
    migrationsTable: 'pgmigrations', direction: 'up', checkOrder: false,
    verbose: false, singleTransaction: true })

  if (createdConfig) {
    const secret = randomBytes(48).toString('base64url')
    const content = [
      '# Local-only auth database and signing key. Keep private and do not copy to production.',
      `AUTH_DATABASE_URL=${authDatabaseUrl}`,
      'PGHOST=127.0.0.1',
      'PGPORT=5432',
      `PGDATABASE=${database}`,
      `PGUSER=${username}`,
      'PGPASSWORD=local-trust-auth-placeholder',
      'PGSSL=false',
      `DATABASE_URL=${authDatabaseUrl}`,
      'AUTH_JWT_ACTIVE_KID=local',
      `AUTH_JWT_LOCAL_SECRET=${secret}`,
      'AUTH_JWT_ISSUER=energrid-local',
      'AUTH_JWT_AUDIENCE=energrid-portal',
      'AUTH_TRUSTED_ORIGINS=http://localhost:4300,http://127.0.0.1:4300,http://localhost:4301,http://127.0.0.1:4301',
      '',
    ].join('\n')
    fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
  } else {
    const extra = [
      ['PGHOST', '127.0.0.1'], ['PGPORT', '5432'], ['PGDATABASE', database], ['PGUSER', username],
      ['PGPASSWORD', 'local-trust-auth-placeholder'], ['PGSSL', 'false'], ['DATABASE_URL', authDatabaseUrl],
    ].filter(([key]) => existingValues[key] === undefined)
    if (extra.length) fs.appendFileSync(target, [
      '',
      '# Local API/Core database overrides. This prevents local green-arrow runs from using root .env PG settings.',
      ...extra.map(([key, value]) => `${key}=${value}`),
      '',
    ].join('\n'), { mode: 0o600 })
  }
  console.log(`${createdConfig ? 'Created' : 'Verified'} the isolated local auth database and private configuration. Bootstrap a local admin with pnpm auth:bootstrap-admin.`)
}

main().catch((error) => { console.error(error.message); process.exit(1) })
