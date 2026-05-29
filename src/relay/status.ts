import type { HexString } from "../config/profile.js";

export type RelayReceiptLog = {
  address: HexString;
  data: HexString;
  topics: HexString[];
};

export type RelayReceipt = {
  blockHash: HexString;
  blockNumber: number;
  chainId: number;
  gasUsed: number;
  logs: RelayReceiptLog[];
  status: HexString;
  transactionHash: HexString;
};

export type RelayCallsStatus = {
  id: string;
  receipts?: RelayReceipt[];
  status: number;
};
