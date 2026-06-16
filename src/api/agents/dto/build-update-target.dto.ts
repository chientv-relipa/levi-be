import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsString } from "class-validator";

export class BuildUpdateTargetDto {
  @ApiProperty({ description: "Agent owner address (signs the tx)" })
  @IsString() @IsNotEmpty() ownerAddress!: string;

  @ApiProperty({ description: "Target package address to add/toggle in the allow-list" })
  @IsString() @IsNotEmpty() target!: string;

  @ApiProperty({ description: "Allowed flag for the target" })
  @IsBoolean() allowed!: boolean;
}
