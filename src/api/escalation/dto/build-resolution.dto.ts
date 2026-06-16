import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class BuildResolutionDto {
  @ApiProperty({ description: "Agent owner address (signs the resolution)" })
  @IsString() @IsNotEmpty() ownerAddress!: string;

  @ApiPropertyOptional({ description: "Gas budget (≤ sponsor cap)" })
  @IsOptional() @IsInt() gasBudget?: number;
}
