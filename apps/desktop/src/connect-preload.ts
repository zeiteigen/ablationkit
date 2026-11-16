/**
 * Preload of the local connection page only (never of a coordinator page): three calls, no Node.
 * Runs sandboxed with context isolation (spec §8.3).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ablationkitDesktop", {
  config: (): Promise<unknown> => ipcRenderer.invoke("desktop:config"),
  connect: (input: {
    mode: "managed" | "remote";
    home?: string;
    launch?: "service" | "child";
    remote_url?: string;
    link?: string;
  }): Promise<unknown> => ipcRenderer.invoke("desktop:connect", input),
  onError: (fn: (message: string) => void): void => {
    ipcRenderer.on("desktop:error", (_e, message: string) => fn(String(message)));
  },
});
