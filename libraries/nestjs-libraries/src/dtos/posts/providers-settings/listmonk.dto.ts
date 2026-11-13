import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

export class ListmonkDto {
  @IsString()
  @MinLength(1)
  subject: string;

  // The preview line is optional (the form and the channel page both say
  // so), but a post created through the API or the agent without it was
  // rejected with "preview must be a string".
  @IsString()
  @IsOptional()
  preview: string;

  // An empty list passed validation and only failed at send time, when
  // Listmonk refused the campaign with "Invalid list IDs".
  @IsString()
  @IsNotEmpty({ message: 'Select a Listmonk list to send to' })
  @JSONSchema({
    description: 'List must be an id',
  })
  list: string;

  @IsString()
  @IsOptional()
  @JSONSchema({
    description: 'Template must be an id',
  })
  template: string;
}
