import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer gets exactly two capabilities: receive state, send a UI intent.
 * No node, no fs, no arbitrary ipc channel.
 */
contextBridge.exposeInMainWorld("overlay", {
  onState(cb: (s: unknown) => void): void {
    ipcRenderer.on("state", (_e, s) => cb(s));
  },
  onSetup(cb: (s: unknown) => void): void {
    ipcRenderer.on("setup", (_e, s) => cb(s));
  },
  send(msg: { t: string; [k: string]: unknown }): void {
    ipcRenderer.send("ui", msg);
  },
});
