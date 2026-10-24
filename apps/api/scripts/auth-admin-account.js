#!/usr/bin/env node
const path = require('node:path')
const dotenv = require('dotenv')
const { Pool } = require('pg')
const argon2 = require('argon2')
const { randomUUID } = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')

const root = path.resolve(__dirname, '../../..')
dotenv.config({ path: path.join(root, '.env'), quiet: true })
dotenv.config({ path: path.join(root, '.env.auth.local'), override: false, quiet: true })

function readSecret(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Run this command in an interactive terminal.'))
    process.stdout.write(label)
    let value = ''
    const stdin = process.stdin
    const decoder = new StringDecoder('utf8')
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return reject(new Error('Cancelled.')) }
        if (character === '\r' || character === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(value) }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('')
        else if (character >= ' ') value += character
      }
    }
    stdin.on('data', onData)
  })
}

function pool() {
  if (process.env.AUTH_DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_DATABASE_URL is local-development only; use production PostgreSQL settings.')
    let target
    try { target = new URL(process.env.AUTH_DATABASE_URL) } catch { throw new Error('AUTH_DATABASE_URL must be a PostgreSQL connection URL.') }
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Local AUTH_DATABASE_URL must point to loopback.')
    return new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
  }
  const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSL } = process.env
  if (!PGHOST || !PGPORT || !PGDATABASE || !PGUSER || !PGPASSWORD) throw new Error('PostgreSQL configuration is required via PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD.')
  return new Pool({ host: PGHOST, port: Number(PGPORT), database: PGDATABASE, user: PGUSER, password: PGPASSWORD, ssl: PGSSL === 'true', max: 1, connectionTimeoutMillis: 5000 })
}

async function main() {
  const [mode, rawEmail] = process.argv.slice(2).filter((argument) => argument !== '--')
  const email = typeof rawEmail === 'string' ? rawEmail.trim().normalize('NFKC').toLowerCase() : ''
  if (!['bootstrap','recover'].includes(mode) || !email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: node apps/api/scripts/auth-admin-account.js <bootstrap|recover> <email>')
  }
  const password = await readSecret('New administrator password (12+ characters): ')
  const confirm = await readSecret('Confirm password: ')
  if (password !== confirm || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) throw new Error('Passwords must match and be 12–1024 UTF-8 bytes.')
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
  const db = pool()
  try {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (mode === 'bootstrap') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['energrid-auth-admin-bootstrap'])
        const existing = await client.query("SELECT 1 FROM auth.users WHERE role='admin' LIMIT 1")
        if (existing.rowCount) throw new Error('An administrator already exists; bootstrap refused to overwrite it.')
        await client.query("INSERT INTO auth.users(id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,'admin')", [randomUUID(), email, passwordHash, email.split('@')[0]])
        await client.query("INSERT INTO auth.audit_events(event_type,details) VALUES('admin_bootstrap',$1::jsonb)", [JSON.stringify({ email })])
      } else {
        const updated = await client.query("UPDATE auth.users SET password_hash=$2,password_changed_at=now(),session_version=session_version+1,updated_at=now() WHERE email=$1 AND role='admin' RETURNING id", [email,passwordHash])
        if (!updated.rowCount) throw new Error('Administrator account was not found.')
        const id = updated.rows[0].id
        await client.query("UPDATE auth.sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='password_reset' WHERE user_id=$1", [id])
        await client.query("UPDATE auth.refresh_tokens r SET status='revoked' FROM auth.sessions s WHERE r.session_id=s.id AND s.user_id=$1 AND r.status='current'", [id])
        await client.query("INSERT INTO auth.audit_events(event_type,user_id) VALUES('password_reset',$1)", [id])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  } finally { await db.end() }
  console.log(mode === 'bootstrap' ? 'Administrator account created.' : 'Administrator password updated; existing sessions revoked.')
}

main().catch((error) => { console.error(error.message); process.exit(1) })
