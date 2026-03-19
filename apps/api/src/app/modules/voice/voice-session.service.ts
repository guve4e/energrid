import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name);

  onConnect(client: any): void {
    this.logger.log(`Session open for client: ${client?.id ?? 'unknown'}`);
  }

  onDisconnect(client: any): void {
    this.logger.log(`Session closed for client: ${client?.id ?? 'unknown'}`);
  }
}
