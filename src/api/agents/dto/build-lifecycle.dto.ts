import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class BuildLifecycleDto {
  @ApiProperty({ description: "Agent owner address (signs the tx)" })
  @IsString() @IsNotEmpty() ownerAddress!: string;
}
