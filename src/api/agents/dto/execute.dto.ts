import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class ExecuteDto {
  @ApiProperty({ description: "base64 tx bytes from a build-* endpoint" })
  @IsString() @IsNotEmpty() transaction!: string;

  @ApiProperty({ description: "Owner signature over those bytes" })
  @IsString() @IsNotEmpty() signature!: string;
}
