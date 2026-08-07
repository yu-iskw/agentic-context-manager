export const EVENT_KINDS = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_observation',
  'code_change',
  'test_result',
  'decision',
  'handoff',
  'custom',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type RetrievalMode = 'fast' | 'accurate';

export interface PrincipalContext {
  tenantId: string;
  principalId: string;
}

export interface CreateSessionInput {
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionRecord extends CreateSessionInput {
  id: string;
  tenantId: string;
  principalId: string;
  createdAt: string;
}

export interface EventContent {
  text: string;
}

export interface RecordEventInput {
  sessionId: string;
  kind: EventKind;
  content: EventContent;
  metadata?: Record<string, unknown>;
  sensitivity?: Sensitivity;
  occurredAt?: string;
}

export interface AcceptedEvent {
  eventId: string;
  ingestionId: string;
  status: 'accepted' | 'queued' | 'processing' | 'completed' | 'retry' | 'failed';
}

export interface IngestionStatus {
  ingestionId: string;
  eventId: string;
  status: 'queued' | 'processing' | 'completed' | 'retry' | 'failed';
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

export interface ContextRecallInput {
  sessionId: string;
  query: string;
  tokenBudget?: number;
  mode?: RetrievalMode;
  limit?: number;
}

export interface ContextPackItem {
  kind: 'memory' | 'recent-event';
  id: string;
  text: string;
  category: string;
  score: number;
  scope: 'session' | 'task' | 'workspace' | 'tenant';
  sourceEventIds: string[];
  tokenEstimate: number;
}

export interface ContextPack {
  id: string;
  sessionId: string;
  query: string;
  mode: RetrievalMode;
  tokenBudget: number;
  tokensUsed: number;
  items: ContextPackItem[];
  createdAt: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
