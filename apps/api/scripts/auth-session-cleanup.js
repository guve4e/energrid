#!/usr/bin/env node
const path = require('node:path')
const dotenv = require('dotenv')
const { Pool } = require('pg')
const root = path.resolve(__dirname, '../../..')
dotenv.config({ path: path.join(root, '.env'), quiet: true })
dotenv.config({ path: path.join(root, '.env.auth.local'), override: false, quiet: true })
async function main() {
  const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSL } = process.env
  if (!process.env.AUTH_DATABASE_URL && (!PGHOST || !PGPORT || !PGDATABASE || !PGUSER || !PGPASSWORD)) throw new Error('PostgreSQL configuration is required.')
  if (process.env.AUTH_DATABASE_URL && process.env.NODE_ENV === 'production') throw new Error('AUTH_DATABASE_URL is local-development only.')
  if (process.env.AUTH_DATABASE_URL) {
    const target = new URL(process.env.AUTH_DATABASE_URL)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Local AUTH_DATABASE_URL must point to loopback.')
  }
  const pool = process.env.AUTH_DATABASE_URL
    ? new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 1 })
    : new Pool({ host: PGHOST, port: Number(PGPORT), database: PGDATABASE, user: PGUSER, password: PGPASSWORD, ssl: PGSSL === 'true', max: 1 })
  try {
    await pool.query("DELETE FROM auth.sessions WHERE absolute_expires_at < now()-interval '30 days'")
    await pool.query("DELETE FROM auth.login_rate_limits WHERE window_started_at < now()-interval '1 day'")
    await pool.query("DELETE FROM auth.refresh_rate_limits WHERE window_started_at < now()-interval '1 hour'")
    await pool.query("DELETE FROM auth.audit_events WHERE created_at < now()-interval '365 days'")
  } finally { await pool.end() }
  console.log('Expired authentication records cleaned up.')
}
main().catch((error) => { console.error(error.message); process.exit(1) })
