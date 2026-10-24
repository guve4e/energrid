import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { AuthRepository } from './auth.repository'
import type { AuthUser } from './auth.types'

const connectionString = process.env.ENERGRID_AUTH_TEST_DATABASE_URL
if (connectionString) {
  const target = new URL(connectionString)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/energrid_auth_e2e') {
    throw new Error('Auth repository integration tests require the isolated loopback energrid_auth_e2e database.')
  }
}
const testWithDatabase = connectionString ? it : it.skip

describe('AuthRepository PostgreSQL integration', () => {
  let pool: Pool
  let repository: AuthRepository
  const userIds: string[] = []

  beforeAll(async () => {
    if (!connectionString) return
    pool = new Pool({ connectionString, max: 4 })
    repository = new AuthRepository(pool)
  })

  afterEach(async () => {
    if (userIds.length) await pool.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [userIds.splice(0)])
  })

  afterAll(async () => { await pool?.end() })

  async function createUser(role: AuthUser['role'] = 'admin'): Promise<AuthUser> {
    const id = randomUUID(); userIds.push(id)
    const result = await pool.query(
      `INSERT INTO auth.users(id,email,password_hash,display_name,role)
       VALUES($1,$2,$3,$4,$5) RETURNING id,email,display_name,role,is_active,session_version,password_hash`,
      [id, `auth-${id}@example.test`, '$argon2id$integration-placeholder', 'Auth integration', role],
    )
    return { id, email: result.rows[0].email, name: result.rows[0].display_name, role,
      active: true, sessionVersion: 0, passwordHash: result.rows[0].password_hash }
  }

  testWithDatabase('rotates atomically, detects concurrent replay, revokes the family, and survives a new pool', async () => {
    const user = await createUser()
    const ip = createHash('sha256').update('test-ip').digest()
    const session = await repository.createSession(user, ip)
    const oldHash = createHash('sha256').update(session.refreshToken).digest()
    const outcomes = await Promise.all([
      repository.rotateRefreshToken(oldHash, 'n'.repeat(43), ip),
      repository.rotateRefreshToken(oldHash, 'm'.repeat(43), ip),
    ])
    expect(outcomes.map(item => item.status).sort()).toEqual(['reused', 'rotated'])
    const replayed = outcomes.find(item => item.status === 'reused')!
    expect(replayed.sessionId).toBe(session.sessionId)

    const restartedPool = new Pool({ connectionString, max: 1 })
    try {
      const afterRestart = new AuthRepository(restartedPool)
      await expect(afterRestart.userForAccess(user.id, session.sessionId, user.sessionVersion)).resolves.toBeNull()
      const current = await restartedPool.query(`SELECT status FROM auth.refresh_tokens WHERE session_id=$1 ORDER BY issued_at DESC`, [session.sessionId])
      expect(current.rows.map(row => row.status)).toContain('revoked')
    } finally { await restartedPool.end() }
  })

  testWithDatabase('persists a rotated session and rejects stale session versions and disabled accounts', async () => {
    const user = await createUser()
    const ip = createHash('sha256').update('test-ip').digest()
    const session = await repository.createSession(user, ip)
    const rotated = await repository.rotateRefreshToken(createHash('sha256').update(session.refreshToken).digest(), 'r'.repeat(43), ip)
    expect(rotated.status).toBe('rotated')
    const fresh = await repository.userForAccess(user.id, session.sessionId, user.sessionVersion)
    expect(fresh?.active).toBe(true)
    await pool.query('UPDATE auth.users SET is_active=false WHERE id=$1', [user.id])
    await expect(repository.userForAccess(user.id, session.sessionId, user.sessionVersion)).resolves.toBeNull()
    expect((await repository.rotateRefreshToken(createHash('sha256').update('r'.repeat(43)).digest(), 's'.repeat(43), ip)).status).toBe('invalid')
  })


  testWithDatabase('serializes administrator bootstrap and refuses a duplicate administrator', async () => {
    const email = `bootstrap-${randomUUID()}@example.test`
    const attempts = await Promise.allSettled([
      repository.createAdministrator(email, '$argon2id$bootstrap-placeholder', 'Bootstrap Admin'),
      repository.createAdministrator(email, '$argon2id$bootstrap-placeholder', 'Bootstrap Admin'),
    ])
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1)
    const created = await pool.query("SELECT id FROM auth.users WHERE email=$1 AND role='admin'", [email])
    expect(created.rowCount).toBe(1)
    userIds.push(created.rows[0].id)
  })

  testWithDatabase.each(['idle_expires_at', 'absolute_expires_at'])('rejects refresh and access after %s', async (expiryColumn) => {
    const user = await createUser()
    const session = await repository.createSession(user, null)
    if (expiryColumn === 'absolute_expires_at') {
      await pool.query(`UPDATE auth.sessions SET created_at=now()-interval '31 days',absolute_expires_at=now()-interval '1 second',idle_expires_at=now()-interval '2 seconds' WHERE id=$1`, [session.sessionId])
    } else {
      await pool.query(`UPDATE auth.sessions SET idle_expires_at=now()-interval '1 second' WHERE id=$1`, [session.sessionId])
    }
    await expect(repository.userForAccess(user.id, session.sessionId, user.sessionVersion)).resolves.toBeNull()
    const result = await repository.rotateRefreshToken(createHash('sha256').update(session.refreshToken).digest(), 'x'.repeat(43), null)
    expect(result.status).toBe('invalid')
  })

  testWithDatabase('logout-all invalidates every session and its current refresh credentials', async () => {
    const user = await createUser()
    const first = await repository.createSession(user, null)
    const second = await repository.createSession(user, null)
    await repository.revokeAll(user.id, null)
    await expect(repository.userForAccess(user.id, first.sessionId, user.sessionVersion)).resolves.toBeNull()
    await expect(repository.userForAccess(user.id, second.sessionId, user.sessionVersion)).resolves.toBeNull()
    expect((await repository.rotateRefreshToken(createHash('sha256').update(first.refreshToken).digest(), 'y'.repeat(43), null)).status).toBe('invalid')
    expect((await repository.rotateRefreshToken(createHash('sha256').update(second.refreshToken).digest(), 'z'.repeat(43), null)).status).toBe('invalid')
  })


  testWithDatabase('password recovery invalidates access and refresh credentials for every old session', async () => {
    const user = await createUser()
    const session = await repository.createSession(user, null)
    await expect(repository.recoverPassword(user.email, '$argon2id$recovered-placeholder')).resolves.toBe(true)
    await expect(repository.userForAccess(user.id, session.sessionId, user.sessionVersion)).resolves.toBeNull()
    expect((await repository.rotateRefreshToken(createHash('sha256').update(session.refreshToken).digest(), 'p'.repeat(43), null)).status).toBe('invalid')
  })

  testWithDatabase('administrator recovery cannot modify installer accounts', async () => {
    const installer = await createUser('installer')
    await expect(repository.recoverPassword(installer.email, '$argon2id$new-hash')).resolves.toBe(false)
    const stored = await pool.query('SELECT password_hash FROM auth.users WHERE id=$1', [installer.id])
    expect(stored.rows[0].password_hash).toBe(installer.passwordHash)
  })
})
