export type OperationSafety = "read" | "preview-write" | "write" | "trust-admin";

export type OperationSchema = {
  id: string;
  title: string;
  description: string;
  safety: OperationSafety;
  exposedIn: {
    cli: boolean;
    mcp: boolean;
  };
  metadata?: {
    agentExposed?: boolean;
    humanGoverned?: boolean;
    mayReturnIssues?: string[];
    movesValue?: boolean;
    pairsWith?: string;
    recommendedFirstStep?: string;
    requirements?: {
      canMoveValue?: boolean;
      requiresCallAuthority?: boolean;
      requiresDelegatedKey?: boolean;
      requiresSpendAuthority?: boolean;
      requiresWalletProfile?: boolean;
    };
    role?: "read" | "preview" | "execute" | "admin";
    valueType?: "none" | "native|erc20" | "arbitrary";
  };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type WalletOperation<I, O> = {
  schema: OperationSchema;
  run: (input: I) => Promise<O>;
};
