const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  platform: process.platform
});

contextBridge.exposeInMainWorld('usageApi', {
  getClaudeUsage: () => ipcRenderer.invoke('claude:usage'),
  getCodexUsage: () => ipcRenderer.invoke('codex:usage'),
  getKiroUsage: () => ipcRenderer.invoke('kiro:usage'),
  getAgyUsage: () => ipcRenderer.invoke('agy:usage'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings)
});
