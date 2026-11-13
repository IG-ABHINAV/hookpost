import { Transform } from 'class-transformer';
import { IsDefined, IsEmail, IsString, MaxLength } from 'class-validator';

export class ChangeUnverifiedEmailDto {
  // " Jo@Gmail.com" is the same address as "jo@gmail.com"
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  )
  @IsString()
  @IsDefined()
  @IsEmail()
  @MaxLength(254)
  email: string;
}
