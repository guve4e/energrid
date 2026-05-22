import { Injectable } from '@nestjs/common'

@Injectable()
export class WeatherRiskEngine {
  evaluate(snapshot: any) {
    const risks: string[] = []

    if (snapshot.current.gustKmh > 70) {
      risks.push('HIGH_WIND')
    }

    if (snapshot.current.condition.toLowerCase().includes('thunder')) {
      risks.push('THUNDERSTORM')
    }

    return {
      level: risks.length ? 'high' : 'low',
      risks,
    }
  }
}
