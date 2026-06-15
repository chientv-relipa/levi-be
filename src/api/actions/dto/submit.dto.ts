import { IsNotEmpty, IsString } from "class-validator";

export class SubmitDto {
  /** base64 tx bytes from build-submit. */
  @IsString() @IsNotEmpty() transaction!: string;
  /** sender (agent) signature over those bytes. */
  @IsString() @IsNotEmpty() signature!: string;
}
