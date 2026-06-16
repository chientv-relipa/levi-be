import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class BuildSubmitDto {
  @ApiProperty({ example: "0xf9048c16e5d6865f3b4a6bb1e08e3be75a5c644bb93d786c227a5767fad5a266" })
  @IsString() @IsNotEmpty() agentWallet!: string;

  @ApiProperty({ example: "0x2", description: "Declared target package address" })
  @IsString() @IsNotEmpty() targetProgram!: string;

  @ApiProperty({ example: "1000", description: "u64 as a decimal string" })
  @IsString() @IsNotEmpty() value!: string;

  @ApiProperty({ description: "base64 encrypted ActionPayload (x25519 + ChaCha20-Poly1305)" })
  @IsString() @IsNotEmpty() encryptedPayload!: string;

  @ApiProperty({ description: "base64 blake3 commitment of the plaintext payload" })
  @IsString() @IsNotEmpty() commitmentHash!: string;

  @ApiPropertyOptional({ description: "Explicit action id; defaults to the agent's next free id" })
  @IsOptional() @IsString() actionId?: string;

  @ApiPropertyOptional({ description: "Gas budget (≤ sponsor cap 100_000_000)" })
  @IsOptional() @IsInt() gasBudget?: number;
}
