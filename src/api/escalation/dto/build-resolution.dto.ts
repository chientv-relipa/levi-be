import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class BuildResolutionDto {
  @IsString() @IsNotEmpty() ownerAddress!: string;
  @IsOptional() @IsInt() gasBudget?: number;
}
