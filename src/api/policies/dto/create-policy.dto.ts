import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import type { StoredPolicyRule } from "../../../store/store.interface";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export class CreatePolicyDto {
  @ApiProperty({ maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @ApiProperty({ enum: SEVERITIES })
  @IsIn(SEVERITIES)
  severity!: (typeof SEVERITIES)[number];

  @ApiProperty({ required: false, maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @ApiProperty({ required: false, maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiProperty({ required: false, type: "array" })
  @IsOptional()
  @IsArray()
  rules?: StoredPolicyRule[];
}
