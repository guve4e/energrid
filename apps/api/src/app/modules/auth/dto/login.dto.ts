import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'admin@energrid.local',
    description: 'Development user email.',
  })
  email!: string;

  @ApiProperty({
    example: 'admin123',
    description: 'Development user password.',
  })
  password!: string;
}
