import { HttpStatus } from '@nestjs/common'
import { PasswordHasher } from './password-hasher'

describe('PasswordHasher capacity', () => {
  it('bounds concurrent Argon2 work and releases capacity after completion', async () => {
    const hasher = new PasswordHasher()
    const password = 'correct horse battery staple'
    const hash = await hasher.hash(password)
    const first = hasher.verify(hash, password)
    const second = hasher.verify(hash, password)

    await expect(hasher.verify(hash, password))
      .rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS })

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    await expect(hasher.verify(hash, password)).resolves.toBe(true)
  })
})
