import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class SetAgentNameDto {
  @ApiProperty({ description: "Display name for the agent (cosmetic, off-chain)", maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name!: string;
}
