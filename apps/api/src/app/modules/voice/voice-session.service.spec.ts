import { Test, TestingModule } from '@nestjs/testing';
import { VoiceSessionService } from './voice-session.service';

describe('VoiceSessionService', () => {
  let service: VoiceSessionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VoiceSessionService],
    }).compile();

    service = module.get<VoiceSessionService>(VoiceSessionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
