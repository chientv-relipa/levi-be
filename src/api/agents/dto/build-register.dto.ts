import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class BuildRegisterDto {
  @ApiProperty({ description: "Owner address (signs the tx; becomes the agent owner)" })
  @IsString() @IsNotEmpty() ownerAddress!: string;

  @ApiProperty({ description: "The agent's wallet address (the one that will sign actions)" })
  @IsString() @IsNotEmpty() agentWallet!: string;

  @ApiProperty({ example: "1000000", description: "Spend limit, u64 as a decimal string" })
  @IsString() @IsNotEmpty() spendLimit!: string;
}
