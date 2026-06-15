import { IsNotEmpty, IsString } from "class-validator";

export class ResolveDto {
  /** base64 tx bytes from build-approve / build-reject. */
  @IsString() @IsNotEmpty() transaction!: string;
  /** owner signature over those bytes. */
  @IsString() @IsNotEmpty() signature!: string;
}
