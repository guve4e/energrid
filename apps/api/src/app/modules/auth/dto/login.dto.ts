import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'you@example.com',
    description: 'Configured portal email.',
  })
  email!: string;

  @ApiProperty({
    description: 'Configured portal password.',
  })
  password!: string;
}
