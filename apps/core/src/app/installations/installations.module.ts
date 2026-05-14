import { Module } from '@nestjs/common';
import { InstallationsController } from './installations.controller';
import { InstallationsRepository } from './installations.repository';
import { InstallationsService } from './installations.service';

@Module({
  controllers: [InstallationsController],
  providers: [InstallationsRepository, InstallationsService],
})
export class InstallationsModule {}
