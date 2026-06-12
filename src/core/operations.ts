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
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type WalletOperation<I, O> = {
  schema: OperationSchema;
  run: (input: I) => Promise<O>;
};
