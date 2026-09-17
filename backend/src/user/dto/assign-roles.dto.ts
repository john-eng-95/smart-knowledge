import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/** Replace all roles assigned to a user. */
export class AssignRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  roleCodes: string[];
}
