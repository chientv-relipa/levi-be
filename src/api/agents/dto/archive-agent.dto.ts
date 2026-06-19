import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class ArchiveAgentDto {
  @ApiProperty({ description: "true to hide the agent from listings, false to unarchive" })
  @IsBoolean()
  archived!: boolean;
}
