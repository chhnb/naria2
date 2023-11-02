import type { PartialDeep } from 'type-fest';
import {
  type Socket,
  type Conn,
  open,
  close,
  aria2,
  type Aria2ServerVersion,
  type Aria2ServerGlobalStat
} from 'maria2';

import { type Aria2InputOptions, resolveInputOptions } from '@naria2/options';

import type { ClientOptions, DownloadOptions } from './types';

import { Aria2Monitor } from './monitor';

export class Aria2Client {
  private _conn: Conn | undefined;

  private _monitor: Aria2Monitor | undefined;

  private _options: Required<Omit<ClientOptions, 'secret' | 'timeout' | 'openTimeout'>>;

  public constructor(conn: Conn, options: ClientOptions = {}) {
    this._conn = conn;
    this._monitor = new Aria2Monitor(this);

    this._options = { progressInterval: 1000, ...options };
    Reflect.deleteProperty(this._options, 'secret');
    Reflect.deleteProperty(this._options, 'timeout');
    Reflect.deleteProperty(this._options, 'openTimeout');
  }

  public get conn(): Conn {
    if (!this._conn) {
      throw new Error('Connection has been closed');
    }
    return this._conn;
  }

  public get options() {
    return this._options;
  }

  public get socket(): Socket {
    return this.conn.getSocket();
  }

  public get monitor(): Aria2Monitor {
    if (!this._monitor) {
      throw new Error('Connection has been closed');
    }
    return this._monitor;
  }

  public close() {
    close(this.conn);
    this._monitor?.close();
    this._conn = undefined;
    this._monitor = undefined;
  }

  /**
   * This method shuts down aria2.
   *
   * @param force Call forceShutdown or shutdown
   */
  public async shutdown(force = false) {
    const shudown = force
      ? aria2.forceShutdown(this.conn).catch(() => undefined)
      : aria2.shutdown(this.conn).catch(() => undefined);
    this.close();
    await shudown;
  }

  /**
   * This method returns the version of aria2 and the list of enabled features. The response is a struct and contains following keys.
   */
  public async version(): Promise<Aria2ServerVersion> {
    return await aria2.getVersion(this.conn);
  }

  /**
   * This method returns global statistics such as the overall download and upload speeds. The response is a struct and contains the following keys. Values are strings.
   */
  public async globalStat(): Promise<Aria2ServerGlobalStat> {
    return await aria2.getGlobalStat(this.conn);
  }

  public async downloadTorrent(
    torrent: string,
    options: PartialDeep<Aria2InputOptions> & DownloadOptions = {}
  ) {
    const inputOptions = resolveInputOptions(options);
    const position = options.position ? [options.position] : [];
    const gid = await aria2
      .addTorrent(this.conn, torrent, undefined, { ...inputOptions }, ...position)
      .catch((error) => {
        return { error };
      });
    if (typeof gid !== 'string') throw gid.error;

    return this.monitor.watchStatus(gid);
  }

  public async downloadUri(
    uri: string | string[],
    options: PartialDeep<Aria2InputOptions> & DownloadOptions = {}
  ) {
    const uris = Array.isArray(uri) ? uri : [uri];
    const inputOptions = resolveInputOptions(options);
    const position = options.position ? [options.position] : [];
    const gid = await aria2
      .addUri(this.conn, uris, { ...inputOptions }, ...position)
      .catch((error) => {
        return { error };
      });
    if (typeof gid !== 'string') throw gid.error;

    return this.monitor.watchStatus(gid);
  }

  // --- List ---
  public async listActive() {
    return this.monitor.listActive();
  }

  public async listWaiting(offset: number, num: number) {
    return aria2.tellWaiting(this.conn, offset, num);
  }

  public async listStopped(offset: number, num: number) {
    return aria2.tellStopped(this.conn, offset, num);
  }
}

export async function createClient(_socket: Socket | Promise<Socket>, options: ClientOptions = {}) {
  const socket = await _socket;
  const conn = await open(socket, {
    secret: options.secret,
    timeout: options.timeout ?? 5000,
    openTimeout: options.openTimeout ?? 5000
  });

  const client = new Aria2Client(conn);
  await client.monitor.start();

  return client;
}
