declare module "socket.io" {
  import { Server as HttpServer } from "http";

  interface ServerOptions {
    cors?: {
      origin?: string | string[];
      methods?: string[];
    };
    maxHttpBufferSize?: number;
  }

  interface Handshake {
    auth: Record<string, unknown>;
    /** HTTP headers from the upgrade request */
    headers: Record<string, string | string[] | undefined>;
    /** Source IP address of the connection */
    address: string;
  }

  interface BroadcastOperator {
    emit(event: string, ...args: unknown[]): boolean;
  }

  class Socket {
    id: string;
    handshake: Handshake;
    join(room: string): void;
    leave(room: string): void;
    emit(event: string, ...args: unknown[]): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): this;
  }

  class Server {
    constructor(httpServer: HttpServer, opts?: ServerOptions);
    use(fn: (socket: Socket, next: (err?: Error) => void) => void): void;
    on(event: "connection", listener: (socket: Socket) => void): void;
    to(room: string): BroadcastOperator;
    emit(event: string, ...args: unknown[]): boolean;
  }
}
