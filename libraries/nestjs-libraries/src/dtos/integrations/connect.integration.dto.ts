import {
  IsDefined,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CONNECT_HANDOFF_ID,
  CONNECT_HANDOFF_MAX_CODE_LENGTH,
} from '@hookpost/nestjs-libraries/integrations/connect.handoff';

export class ConnectIntegrationDto {
  @IsString()
  @IsDefined()
  state: string;

  /**
   * The provider's OAuth code. Absent when the credentials were handed over
   * beforehand (`handoff`), and on a reload of the callback page, which no
   * longer has it in its URL (connect.handoff.ts in the frontend strips it).
   */
  @IsString()
  @IsOptional()
  code?: string;

  /**
   * For a channel connected with credentials (custom fields, or the Skool
   * cookies the Chrome extension reads): the one-time id of what the Add
   * Channel page sent to POST /integrations/social-connect/:provider/handoff,
   * so the credentials never travel in a URL.
   */
  @IsString()
  @IsOptional()
  @Matches(CONNECT_HANDOFF_ID)
  handoff?: string;

  @IsString()
  @IsDefined()
  timezone: string;

  @IsString()
  @IsOptional()
  refresh?: string;
}

/** POST /integrations/social-connect/:provider/handoff */
export class ConnectHandoffDto {
  @IsString()
  @IsDefined()
  @MaxLength(512)
  state: string;

  /** base64 of the credentials' JSON, as the code used to be. */
  @IsString()
  @IsDefined()
  @MaxLength(CONNECT_HANDOFF_MAX_CODE_LENGTH)
  code: string;
}
