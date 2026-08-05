export interface ApprovalRequest {
  id: string;
  from: string;
  description: string;
  sessionId: string;
  hubMessageId: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  resolvedAt: string | null;
}
