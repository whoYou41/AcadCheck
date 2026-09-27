'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Expose only scanner operations; renderer code never gets Node or raw IPC.
contextBridge.exposeInMainWorld('acadcheckOmr', Object.freeze({
  prewarm: () => ipcRenderer.invoke('acadcheck:omr:prewarm'),
  scan: options => ipcRenderer.invoke('acadcheck:omr:scan', options),
}));
