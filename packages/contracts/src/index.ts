export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ContextMode = 'fast' | 'accurate';
export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'file_observation'
  | 'code_change'
  | 'test_result'
  | 'decision'
  | 'handoff'
  | 'custom';

export interface StartSessionRequest {
  workspace: { externalId: string };
  task?: { externalId: string };
  agent?: { name: string };
}

export interface StartSessionResponse {
  sessionId: string;
  contextHandle: string;
  architectureVersion: string;
}

export interface RecordEventRequest {
  contextHandle: string;
  kind: EventKind;
  content: JsonValue;
  metadata?: Record<string, JsonValue>;
  occurredAt?: string;
  idempotencyKey?: string;
}

export interface RecordEventResponse {
  eventId: string;
  ingestionId: string;
  status: 'accepted' | 'pending' | 'processing' | 'completed' | 'failed';
}

export interface ContextQueryRequest {
  contextHandle: string;
  query: string;
  mode?: ContextMode;
  budgetTokens?: number;
  includeExplanations?: boolean;
}

export interface ContextPackItem {
  memoryId: string;
  category: string;
  text: string;
  score: number;
  estimatedTokens: number;
  selectedBecause: string[];
  provenance: Array<{ eventId: string; occurredAt: string }>;
}

export interface ContextPack {
  id: string;
  sessionId: string;
  mode: ContextMode;
  budgetTokens: number;
  usedTokens: number;
  items: ContextPackItem[];
  omittedItems: number;
  createdAt: string;
}

export interface ContextCheckpointRequest {
  contextHandle: string;
  budgetTokens?: number;
}

export interface ContextCheckpointValidation {
  mustPreserveCount: number;
  preservedCount: number;
  coverage: number;
}

export interface ContextCheckpoint {
  id: string;
  sessionId: string;
  status: 'validated';
  budgetTokens: number;
  usedTokens: number;
  summary: string;
  sourceMemoryIds: string[];
  validation: ContextCheckpointValidation;
  createdAt: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }

  readonly code = 'invalid_request';
}

function objectValue(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function optionalBudgetTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 64 || value > 32_000) {
    throw new ValidationError('budgetTokens must be an integer between 64 and 32000');
  }
  return value;
}

export function parseStartSessionRequest(value: unknown): StartSessionRequest {
  const body = objectValue(value);
  const workspace = objectValue(body.workspace, 'workspace');
  const task = body.task === undefined ? undefined : objectValue(body.task, 'task');
  const agent = body.agent === undefined ? undefined : objectValue(body.agent, 'agent');
  const result: StartSessionRequest = {
    workspace: { externalId: stringValue(workspace.externalId, 'workspace.externalId') },
  };
  if (task !== undefined) {
    result.task = { externalId: stringValue(task.externalId, 'task.externalId') };
  }
  if (agent !== undefined) result.agent = { name: stringValue(agent.name, 'agent.name') };
  return result;
}

const eventKinds = new Set<EventKind>([
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
]);

export function parseRecordEventRequest(value: unknown): RecordEventRequest {
  const body = objectValue(value);
  const kind = stringValue(body.kind, 'kind') as EventKind;
  if (!eventKinds.has(kind)) throw new ValidationError(`unsupported event kind: ${kind}`);
  if (body.content === undefined) throw new ValidationError('content is required');

  const metadata = body.metadata === undefined ? undefined : objectValue(body.metadata, 'metadata');
  const result: RecordEventRequest = {
    contextHandle: stringValue(body.contextHandle, 'contextHandle'),
    kind,
    content: body.content as JsonValue,
  };
  if (metadata !== undefined) result.metadata = metadata as Record<string, JsonValue>;
  const occurredAt = optionalString(body.occurredAt, 'occurredAt');
  if (occurredAt !== undefined) result.occurredAt = occurredAt;
  const idempotencyKey = optionalString(body.idempotencyKey, 'idempotencyKey');
  if (idempotencyKey !== undefined) result.idempotencyKey = idempotencyKey;
  return result;
}

export function parseContextQueryRequest(value: unknown): ContextQueryRequest {
  const body = objectValue(value);
  const result: ContextQueryRequest = {
    contextHandle: stringValue(body.contextHandle, 'contextHandle'),
    query: stringValue(body.query, 'query'),
  };
  if (body.mode !== undefined) {
    if (body.mode !== 'fast' && body.mode !== 'accurate') {
      throw new ValidationError('mode must be fast or accurate');
    }
    result.mode = body.mode;
  }
  const budgetTokens = optionalBudgetTokens(body.budgetTokens);
  if (budgetTokens !== undefined) result.budgetTokens = budgetTokens;
  if (body.includeExplanations !== undefined) {
    if (typeof body.includeExplanations !== 'boolean') {
      throw new ValidationError('includeExplanations must be boolean');
    }
    result.includeExplanations = body.includeExplanations;
  }
  return result;
}

export function parseContextCheckpointRequest(value: unknown): ContextCheckpointRequest {
  const body = objectValue(value);
  const result: ContextCheckpointRequest = {
    contextHandle: stringValue(body.contextHandle, 'contextHandle'),
  };
  const budgetTokens = optionalBudgetTokens(body.budgetTokens);
  if (budgetTokens !== undefined) result.budgetTokens = budgetTokens;
  return result;
}
