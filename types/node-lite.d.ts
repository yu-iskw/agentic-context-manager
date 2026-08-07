declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  cwd(): string;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

declare class Buffer {
  static from(input: string, encoding?: string): Buffer;
  toString(encoding?: string): string;
  at(index: number): number | undefined;
  readonly length: number;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): { digest(): Buffer };
  };
}

declare module 'node:child_process' {
  interface SpawnOptions {
    env?: Record<string, string | undefined>;
    stdio?: readonly string[];
  }
  interface ChildProcess {
    stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
    stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  }
  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers?: { host?: string };
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
  }
  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): Server;
}
