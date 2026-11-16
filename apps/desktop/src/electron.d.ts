/**
 * The subset of Electron 43's API the desktop shell uses, written against `electron.d.ts` 43.8.3.
 *
 * Why not the `electron` npm package: its typings pull in `@types/node`-style declarations that
 * clash with Bun's across the whole workspace (playwright-core's types import "electron" too), and
 * its install script downloads a binary we do not want in `bun install`. The app runs on the
 * system Electron (ADR 0025); extend this file when the shell uses more of the API.
 */
declare module "electron" {
  interface Event {
    preventDefault(): void;
  }

  interface PermissionRequestDetails {
    requestingUrl?: string;
  }

  interface Session {
    setPermissionRequestHandler(
      handler: (
        webContents: WebContents,
        permission: string,
        callback: (granted: boolean) => void,
        details: PermissionRequestDetails,
      ) => void,
    ): void;
    setPermissionCheckHandler(
      handler: (
        webContents: WebContents | null,
        permission: string,
        requestingOrigin: string,
      ) => boolean,
    ): void;
    setDevicePermissionHandler(handler: () => boolean): void;
  }

  type WindowOpenResponse =
    | { action: "deny" }
    | { action: "allow"; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions };

  interface WebContents {
    setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenResponse): void;
    on(
      event: "will-navigate" | "will-redirect",
      listener: (event: Event, url: string) => void,
    ): this;
    on(event: "will-attach-webview", listener: (event: Event) => void): this;
    send(channel: string, ...args: unknown[]): void;
  }

  interface WebPreferences {
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    nodeIntegrationInWorker?: boolean;
    nodeIntegrationInSubFrames?: boolean;
    sandbox?: boolean;
    webSecurity?: boolean;
    allowRunningInsecureContent?: boolean;
    webviewTag?: boolean;
    experimentalFeatures?: boolean;
    spellcheck?: boolean;
    navigateOnDragDrop?: boolean;
    partition?: string;
    preload?: string;
    devTools?: boolean;
  }

  interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    show?: boolean;
    title?: string;
    backgroundColor?: string;
    autoHideMenuBar?: boolean;
    webPreferences?: WebPreferences;
  }

  class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    static getAllWindows(): BrowserWindow[];
    readonly webContents: WebContents;
    loadURL(url: string): Promise<void>;
    loadFile(path: string, options?: { query?: Record<string, string> }): Promise<void>;
    show(): void;
    close(): void;
    focus(): void;
    restore(): void;
    isMinimized(): boolean;
    isVisible(): boolean;
    isDestroyed(): boolean;
    on(event: "closed", listener: () => void): this;
    once(event: "ready-to-show", listener: () => void): this;
  }

  interface App {
    getAppPath(): string;
    enableSandbox(): void;
    setPath(name: "userData", path: string): void;
    requestSingleInstanceLock(): boolean;
    quit(): void;
    isReady(): boolean;
    whenReady(): Promise<void>;
    on(
      event: "web-contents-created",
      listener: (event: Event, webContents: WebContents) => void,
    ): this;
    on(event: "second-instance" | "window-all-closed" | "before-quit", listener: () => void): this;
  }

  interface IpcMainInvokeEvent {
    readonly sender: WebContents;
  }

  interface IpcMain {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown,
    ): void;
  }

  interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: unknown, ...args: never[]) => void): this;
  }

  type MenuItemRole =
    | "quit"
    | "editMenu"
    | "reload"
    | "resetZoom"
    | "zoomIn"
    | "zoomOut"
    | "togglefullscreen"
    | "toggleDevTools";

  interface MenuItemConstructorOptions {
    label?: string;
    role?: MenuItemRole;
    type?: "separator";
    enabled?: boolean;
    click?: () => void;
    submenu?: MenuItemConstructorOptions[];
  }

  interface Menu {
    readonly items: unknown[];
  }

  export const Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
    setApplicationMenu(menu: Menu | null): void;
  };
  export const app: App;
  export const ipcMain: IpcMain;
  export const ipcRenderer: IpcRenderer;
  export const contextBridge: {
    exposeInMainWorld(key: string, api: Record<string, unknown>): void;
  };
  export const dialog: { showErrorBox(title: string, content: string): void };
  export const session: { fromPartition(partition: string): Session };
  export const shell: { openExternal(url: string): Promise<void> };
  export {
    BrowserWindow,
    type BrowserWindowConstructorOptions,
    type IpcMainInvokeEvent,
    type MenuItemConstructorOptions,
    type Session,
    type WebContents,
  };
}
