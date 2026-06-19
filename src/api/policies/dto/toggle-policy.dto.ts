import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class TogglePolicyDto {
  @ApiProperty({ description: "true to enable the policy, false to disable" })
  @IsBoolean()
  active!: boolean;
}
