export interface HubMessage {
  id: string;
  from: string;
  text: string;
  timestamp: string;
  sessionId: string;
  images?: string[];
}
