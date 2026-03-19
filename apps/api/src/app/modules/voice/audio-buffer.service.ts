import { Injectable } from '@nestjs/common'

@Injectable()
export class AudioBufferService {

  private chunks: Buffer[] = []

  addChunk(chunk: Buffer) {
    this.chunks.push(chunk)
  }

  flush(): Buffer {
    const audio = Buffer.concat(this.chunks)
    this.chunks = []
    return audio
  }
}
