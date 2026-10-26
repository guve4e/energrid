/**
 * Minimal Nest decorator/logger surface used only by the standalone observer bundle.
 * The bundle reuses the production collector without bootstrapping Nest or its providers.
 */
export function Injectable(): ClassDecorator {
  return target => target
}

export function Inject(_token: unknown): ParameterDecorator & PropertyDecorator {
  return () => undefined
}

export function Optional(): ParameterDecorator & PropertyDecorator {
  return () => undefined
}

export class BadRequestException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestException'
  }
}

export class Logger {
  constructor(private readonly context?: string) {}

  log(message: string): void { console.log(this.format(message)) }
  warn(message: string): void { console.warn(this.format(message)) }
  error(message: string): void { console.error(this.format(message)) }

  private format(message: string): string {
    return this.context ? `[${this.context}] ${message}` : message
  }
}
