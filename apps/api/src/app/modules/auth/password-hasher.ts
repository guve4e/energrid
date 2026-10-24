import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'

const PARAMETERS: argon2.HashOptions = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }
const MAX_CONCURRENT_HASHES = 2

@Injectable()
export class PasswordHasher {
  private activeHashes = 0

  hash(password: string): Promise<string> {
    return this.withCapacity(() => argon2.hash(password, PARAMETERS))
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try { return await this.withCapacity(() => argon2.verify(hash, password)) }
    catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error
      return false
    }
  }

  private async withCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeHashes >= MAX_CONCURRENT_HASHES) {
      throw new HttpException('Password verification capacity is busy. Retry shortly.', HttpStatus.TOO_MANY_REQUESTS)
    }
    this.activeHashes += 1
    try { return await operation() }
    finally { this.activeHashes -= 1 }
  }
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Password must be at least 12 characters and no more than 1024 UTF-8 bytes')
  }
}
