import { aria2, system } from 'maria2';
import mitt, { type Emitter } from 'mitt';

import type { Aria2Client } from './client';

import { Task, Torrent } from './torrent';

interface Disposable<T = void> {
  dispose(): T;
}

type Aria2MonitorEvents = Record<
  | `start:${string}`
  | `progress:${string}`
  | `pause:${string}`
  | `stop:${string}`
  | `complete:${string}`
  | `error:${string}`,
  Task
> &
  Record<`bt-complete:${string}`, Torrent>;

export class Aria2Monitor implements Pick<Emitter<Aria2MonitorEvents>, 'on' | 'off'> {
  private readonly client: Aria2Client;

  private readonly disposables: Set<Disposable<void>> = new Set();

  private readonly emitter = mitt<Aria2MonitorEvents>();

  private readonly map: Map<string, Task> = new Map();

  private readonly progressIds: Set<string> = new Set();

  public constructor(client: Aria2Client) {
    this.client = client;
  }

  private get conn() {
    return this.client.conn;
  }

  public async start() {
    [
      aria2.when(this.conn, 'aria2.onDownloadStart', (ev) => {
        this.onDownloadStart(ev.gid);
      }),
      aria2.when(this.conn, 'aria2.onDownloadPause', (ev) => {
        this.onDownloadPause(ev.gid);
      }),
      aria2.when(this.conn, 'aria2.onDownloadStop', (ev) => {
        this.onDownloadStop(ev.gid);
      }),
      aria2.when(this.conn, 'aria2.onDownloadComplete', (ev) => {
        this.onDownloadComplete(ev.gid);
      }),
      aria2.when(this.conn, 'aria2.onBtDownloadComplete', (ev) => {
        this.onBtDownloadComplete(ev.gid);
      }),
      aria2.when(this.conn, 'aria2.onDownloadError', (ev) => {
        this.onDownloadError(ev.gid);
      })
    ].forEach((dis) => this.disposables.add(dis));

    const timeout = setInterval(async () => {
      await this.onDownloadProgress();
    }, this.client.options.progressInterval);
    this.disposables.add({
      dispose() {
        clearInterval(timeout);
      }
    });
  }

  public close() {
    this.disposables.forEach((dis) => dis.dispose());
  }

  public async listActive() {
    const result = await aria2.tellActive(this.conn);
    return await Promise.all(
      result.map(async (status) => {
        const freshTask = !this.map.has(status.gid);
        const task = await this.getTask(status.gid);
        if (!freshTask) {
          Reflect.set(task, '_status', status);
          Reflect.set(task, '_timestamp', new Date());
        }
        return task;
      })
    );
  }

  public async getTask(gid: string): Promise<Task> {
    if (this.map.has(gid)) {
      return this.map.get(gid)!;
    } else {
      const status = await aria2.tellStatus(this.conn, gid);
      // Concurrent
      if (this.map.has(gid)) {
        return this.map.get(gid)!;
      }

      const following = status.following ? await this.getTask(status.following) : undefined;
      const task = status.bittorrent
        ? new Torrent(this.client, gid, following as Torrent | undefined)
        : new Task(this.client, gid);

      this.map.set(gid, task);
      Reflect.set(task, '_status', status);
      Reflect.set(task, '_timestamp', new Date());

      return task;
    }
  }

  public async watchStatus(gid: string): Promise<Task> {
    const task = await this.getTask(gid);
    return task;
  }

  // --- emitter ---
  public on<Key extends keyof Aria2MonitorEvents>(key: Key, handler: any) {
    if (key.startsWith('progress:')) {
      const id = key.slice('progress:'.length);
      this.progressIds.add(id);
    }
    this.emitter.on(key, handler);
  }

  public off<Key extends keyof Aria2MonitorEvents>(key: Key, handler?: any) {
    this.emitter.off(key, handler);
  }
  // ---------------

  // --- internal ---
  private async onDownloadProgress() {
    if (this.progressIds.size === 0) return;

    const statues = await system.multicall(
      this.conn,
      ...[...this.progressIds].map(
        (id) =>
          ({
            methodName: 'aria2.tellStatus',
            params: [id] as [string]
          } as const)
      )
    );
    for (const status of statues) {
      if (!status.gid) continue;

      const gid = status.gid!;
      const freshTask = !this.map.has(gid);
      const task = await this.getTask(gid);
      if (!freshTask) {
        Reflect.set(task, '_status', status);
        Reflect.set(task, '_timestamp', new Date());
      }
      this.emitter.emit(`progress:${gid}`, task);
    }
  }

  private async onDownloadStart(gid: string) {
    this.emitter.emit(`start:${gid}`, await this.getTask(gid));
  }

  private async onDownloadPause(gid: string) {
    this.emitter.emit(`pause:${gid}`, await this.getTask(gid));
  }

  private async onDownloadStop(gid: string) {
    this.emitter.emit(`stop:${gid}`, await this.getTask(gid));
  }

  private async onDownloadComplete(gid: string) {
    this.emitter.emit(`complete:${gid}`, await this.getTask(gid));
  }

  private async onBtDownloadComplete(gid: string) {
    const task = (await this.getTask(gid)) as Torrent;
    this.emitter.emit(`bt-complete:${gid}`, task);
  }

  private async onDownloadError(gid: string) {
    this.emitter.emit(`error:${gid}`, await this.getTask(gid));
  }
}
