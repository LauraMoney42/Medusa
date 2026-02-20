export interface CompletedTask {
  id: string;
  hubMessageId: string;
  from: string;
  description: string;
  timestamp: string;
  sessionId: string;
  acknowledged: boolean;
}
