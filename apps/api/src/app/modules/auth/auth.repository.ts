import { Injectable } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AccountRole, AuthUser } from './auth.types'

export interface LoginRateDecision { blocked: boolean; retryAfterSeconds: number }
export interface CreatedSession { sessionId: string; refreshToken: string; absoluteExpiresAt: Date; idleExpiresAt: Date }
export interface RefreshResult { status: 'rotated' | 'reused' | 'invalid'; sessionId?: string; user?: AuthUser; refreshToken?: string; absoluteExpiresAt?: Date; idleExpiresAt?: Date }
export interface RefreshAccess { user: AuthUser; sessionId: string }

@Injectable()
export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const result = await this.pool.query(
      `SELECT id,email,display_name,role,is_active,session_version,password_hash
       FROM auth.users WHERE email=$1`, [email],
    )
    return result.rows[0] ? toUser(result.rows[0]) : null
  }

  async userForAccess(userId: string, sessionId: string, sessionVersion: number): Promise<AuthUser | null> {
    const result = await this.pool.query(
      `SELECT u.id,u.email,u.display_name,u.role,u.is_active,u.session_version,u.password_hash
       FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
       WHERE u.id=$1 AND s.id=$2 AND u.is_active=true AND s.revoked_at IS NULL
         AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
         AND u.session_version=$3 AND s.session_version=$3`,
      [userId, sessionId, sessionVersion],
    )
    return result.rows[0] ? toUser(result.rows[0]) : null
  }

  async checkLoginRate(emailHash: Buffer, ipHash: Buffer): Promise<LoginRateDecision> {
    const result = await this.pool.query(
      `SELECT blocked_until FROM auth.login_rate_limits
       WHERE email_hash=$1 AND ip_hash=$2 AND blocked_until > now()`, [emailHash, ipHash],
    )
    const blockedUntil = result.rows[0]?.blocked_until as Date | undefined
    return blockedUntil ? { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 1000)) }
      : { blocked: false, retryAfterSeconds: 0 }
  }

  async recordLoginFailure(emailHash: Buffer, ipHash: Buffer): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth.login_rate_limits(email_hash,ip_hash,failures,window_started_at,blocked_until)
       VALUES($1,$2,1,now(),NULL)
       ON CONFLICT(email_hash,ip_hash) DO UPDATE SET
         failures=LEAST(5,CASE WHEN auth.login_rate_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth.login_rate_limits.failures+1 END),
         window_started_at=CASE WHEN auth.login_rate_limits.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth.login_rate_limits.window_started_at END,
         blocked_until=CASE WHEN (CASE WHEN auth.login_rate_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth.login_rate_limits.failures+1 END) >= 5 THEN now()+interval '15 minutes' ELSE NULL END`,
      [emailHash, ipHash],
    )
  }

  async clearLoginFailures(emailHash: Buffer, ipHash: Buffer): Promise<void> {
    await this.pool.query('DELETE FROM auth.login_rate_limits WHERE email_hash=$1 AND ip_hash=$2', [emailHash, ipHash])
  }

  async checkRefreshRate(ipHash: Buffer): Promise<LoginRateDecision> {
    const result = await this.pool.query(`SELECT blocked_until FROM auth.refresh_rate_limits WHERE ip_hash=$1 AND blocked_until > now()`, [ipHash])
    const until = result.rows[0]?.blocked_until as Date | undefined
    return until ? { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((until.getTime()-Date.now())/1000)) } : { blocked: false, retryAfterSeconds: 0 }
  }

  async recordRefreshAttempt(ipHash: Buffer): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth.refresh_rate_limits(ip_hash,attempts,window_started_at,blocked_until) VALUES($1,1,now(),NULL)
       ON CONFLICT(ip_hash) DO UPDATE SET
         attempts=CASE WHEN auth.refresh_rate_limits.window_started_at < now()-interval '1 minute' THEN 1 ELSE LEAST(61,auth.refresh_rate_limits.attempts+1) END,
         window_started_at=CASE WHEN auth.refresh_rate_limits.window_started_at < now()-interval '1 minute' THEN now() ELSE auth.refresh_rate_limits.window_started_at END,
         blocked_until=CASE WHEN (CASE WHEN auth.refresh_rate_limits.window_started_at < now()-interval '1 minute' THEN 1 ELSE auth.refresh_rate_limits.attempts+1 END) > 60 THEN now()+interval '1 minute' ELSE NULL END`,
      [ipHash],
    )
  }

  async userForRefreshToken(tokenHash: Buffer): Promise<RefreshAccess | null> {
    const result = await this.pool.query(
      `SELECT s.id AS session_id,u.id,u.email,u.display_name,u.role,u.is_active,u.session_version,u.password_hash
       FROM auth.refresh_tokens r JOIN auth.sessions s ON s.id=r.session_id JOIN auth.users u ON u.id=s.user_id
       WHERE r.token_hash=$1 AND r.status='current' AND r.expires_at>now() AND s.revoked_at IS NULL
         AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND u.is_active=true AND u.session_version=s.session_version`, [tokenHash],
    )
    const row = result.rows[0]
    return row ? { user: toUser(row), sessionId: String(row.session_id) } : null
  }

  async recordAudit(event: string, userId: string | null, ipHash: Buffer | null, details: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth.audit_events(event_type,user_id,ip_hash,details) VALUES($1,$2,$3,$4::jsonb)`,
      [event, userId, ipHash, JSON.stringify(details)],
    )
  }

  async createSession(user: AuthUser, ipHash: Buffer | null): Promise<CreatedSession> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO auth.sessions(id,user_id,session_version,idle_expires_at,absolute_expires_at,created_ip_hash,last_ip_hash)
         VALUES($1,$2,$3,now()+interval '7 days',now()+interval '30 days',$4,$4)
         RETURNING id,absolute_expires_at,idle_expires_at`, [randomUUID(), user.id, user.sessionVersion, ipHash],
      )
      const session = inserted.rows[0]
      const refreshToken = randomRefreshToken()
      await client.query(
        `INSERT INTO auth.refresh_tokens(id,session_id,token_hash,status,expires_at)
         VALUES($1,$2,$3,'current',LEAST(now()+interval '7 days',$4))`,
        [randomUUID(), session.id, refreshHashFor(refreshToken), session.absolute_expires_at],
      )
      await client.query('INSERT INTO auth.audit_events(event_type,user_id,ip_hash) VALUES($1,$2,$3)', ['login_success', user.id, ipHash])
      await client.query('COMMIT')
      return { sessionId: session.id, refreshToken, absoluteExpiresAt: session.absolute_expires_at, idleExpiresAt: session.idle_expires_at }
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async rotateRefreshToken(tokenHash: Buffer, nextToken: string, ipHash: Buffer | null): Promise<RefreshResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const ref = await client.query('SELECT session_id FROM auth.refresh_tokens WHERE token_hash=$1', [tokenHash])
      if (!ref.rowCount) { await client.query('COMMIT'); return { status: 'invalid' } }
      const sessionId = ref.rows[0].session_id as string
      const sessionResult = await client.query(
        `SELECT s.*,u.id AS account_id,u.email,u.display_name,u.role,u.is_active,u.session_version AS account_session_version,u.password_hash
         FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s`, [sessionId],
      )
      const session = sessionResult.rows[0]
      const tokenResult = await client.query('SELECT status,expires_at FROM auth.refresh_tokens WHERE token_hash=$1 AND session_id=$2 FOR UPDATE', [tokenHash, sessionId])
      const tokenRow = tokenResult.rows[0]
      if (!session || !tokenRow) { await client.query('COMMIT'); return { status: 'invalid' } }
      if (tokenRow.status === 'used' && !session.revoked_at) {
        await client.query(`UPDATE auth.sessions SET revoked_at=now(),revoke_reason='refresh_reuse' WHERE id=$1`, [sessionId])
        await client.query('UPDATE auth.refresh_tokens SET status=\'revoked\' WHERE session_id=$1 AND status=\'current\'', [sessionId])
        await client.query('INSERT INTO auth.audit_events(event_type,user_id,ip_hash,details) VALUES($1,$2,$3,$4::jsonb)', ['refresh_reuse', session.user_id, ipHash, JSON.stringify({ sessionId })])
        await client.query('COMMIT')
        return { status: 'reused', sessionId }
      }
      if (tokenRow.status !== 'current' || session.revoked_at || !session.is_active ||
          session.idle_expires_at <= new Date() || session.absolute_expires_at <= new Date() ||
          session.account_session_version !== session.session_version || tokenRow.expires_at <= new Date()) {
        await client.query('COMMIT'); return { status: 'invalid', sessionId }
      }
      await client.query(`UPDATE auth.refresh_tokens SET status='used',consumed_at=now() WHERE token_hash=$1`, [tokenHash])
      await client.query(
        `UPDATE auth.sessions SET last_used_at=now(),last_ip_hash=$2,idle_expires_at=LEAST(now()+interval '7 days',absolute_expires_at) WHERE id=$1`,
        [sessionId, ipHash],
      )
      await client.query(
        `INSERT INTO auth.refresh_tokens(id,session_id,token_hash,status,expires_at)
         VALUES($1,$2,$3,'current',LEAST(now()+interval '7 days',$4))`,
        [randomUUID(), sessionId, refreshHashFor(nextToken), session.absolute_expires_at],
      )
      await client.query('COMMIT')
      return {
        status: 'rotated', sessionId, refreshToken: nextToken,
        absoluteExpiresAt: session.absolute_expires_at,
        idleExpiresAt: new Date(Math.min(Date.now() + 7 * 86400_000, new Date(session.absolute_expires_at).getTime())),
        user: toUser({ id: session.account_id, email: session.email, display_name: session.display_name, role: session.role,
          is_active: session.is_active, session_version: session.account_session_version, password_hash: session.password_hash }),
      }
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async revokeSession(sessionId: string, userId: string, ipHash: Buffer | null, reason: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE auth.sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=$3 WHERE id=$1 AND user_id=$2`, [sessionId,userId,reason])
      await client.query(`UPDATE auth.refresh_tokens SET status='revoked' WHERE session_id=$1 AND status='current'`, [sessionId])
      await client.query('INSERT INTO auth.audit_events(event_type,user_id,ip_hash,details) VALUES($1,$2,$3,$4::jsonb)', ['logout', userId, ipHash, JSON.stringify({ sessionId })])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async revokeAll(userId: string, ipHash: Buffer | null): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE auth.users SET session_version=session_version+1,updated_at=now() WHERE id=$1', [userId])
      await client.query(`UPDATE auth.sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='logout_all' WHERE user_id=$1`, [userId])
      await client.query(`UPDATE auth.refresh_tokens r SET status='revoked' FROM auth.sessions s WHERE r.session_id=s.id AND s.user_id=$1 AND r.status='current'`, [userId])
      await client.query('INSERT INTO auth.audit_events(event_type,user_id,ip_hash) VALUES($1,$2,$3)', ['logout_all',userId,ipHash])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async createAdministrator(email: string, passwordHash: string, name: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['energrid-auth-admin-bootstrap'])
      const existing = await client.query(`SELECT 1 FROM auth.users WHERE role='admin' LIMIT 1`)
      if (existing.rowCount) throw new Error('An administrator already exists; bootstrap will not overwrite accounts')
      await client.query(`INSERT INTO auth.users(id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,'admin')`, [randomUUID(),email,passwordHash,name])
      await client.query(`INSERT INTO auth.audit_events(event_type,details) VALUES('admin_bootstrap',$1::jsonb)`, [JSON.stringify({ email })])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async recoverPassword(email: string, passwordHash: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(`UPDATE auth.users SET password_hash=$2,password_changed_at=now(),session_version=session_version+1,updated_at=now() WHERE email=$1 AND role='admin' RETURNING id`, [email,passwordHash])
      if (changed.rowCount) {
        await client.query(`UPDATE auth.sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='password_reset' WHERE user_id=$1`, [changed.rows[0].id])
        await client.query(`UPDATE auth.refresh_tokens r SET status='revoked' FROM auth.sessions s WHERE r.session_id=s.id AND s.user_id=$1 AND r.status='current'`, [changed.rows[0].id])
        await client.query(`INSERT INTO auth.audit_events(event_type,user_id) VALUES('password_reset',$1)`, [changed.rows[0].id])
      }
      await client.query('COMMIT')
      return !!changed.rowCount
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }
}

function toUser(row: Record<string, unknown>): AuthUser {
  return { id: String(row.id), email: String(row.email), name: String(row.display_name || 'Admin'),
    role: row.role as AccountRole, active: row.is_active === true, sessionVersion: Number(row.session_version), passwordHash: String(row.password_hash) }
}

function randomRefreshToken(): string { return randomBytes(32).toString('base64url') }
function refreshHashFor(token: string): Buffer { return createHash('sha256').update(token).digest() }
