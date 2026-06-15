import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class BuildSubmitDto {
  @IsString() @IsNotEmpty() agentWallet!: string;
  @IsString() @IsNotEmpty() targetProgram!: string;
  /** u64 as a decimal string. */
  @IsString() @IsNotEmpty() value!: string;
  /** base64 encrypted ActionPayload. */
  @IsString() @IsNotEmpty() encryptedPayload!: string;
  /** base64 blake3 commitment. */
  @IsString() @IsNotEmpty() commitmentHash!: string;
  @IsOptional() @IsString() actionId?: string;
  @IsOptional() @IsInt() gasBudget?: number;
}
