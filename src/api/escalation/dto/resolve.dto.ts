import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class ResolveDto {
  @ApiProperty({ description: "base64 tx bytes from build-approve / build-reject" })
  @IsString() @IsNotEmpty() transaction!: string;

  @ApiProperty({ description: "Owner signature over those bytes" })
  @IsString() @IsNotEmpty() signature!: string;
}
