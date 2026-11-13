import { IsOptional, IsString } from 'class-validator';

export class MoltbookDto {
  // Optional: the provider posts to "general" when it is empty, as the
  // composer's placeholder says. Required here, an untouched field blocked
  // the post with a validation error instead.
  @IsOptional()
  @IsString()
  submolt?: string;
}
