import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  AddWorkingCopyInput,
  AppMenuCommand,
  AppSettings,
  CheckoutInput,
  CommandOutputEvent,
  CommitInput,
  RevisionDiffInput,
  ResolveInput,
  TestConnectionInput,
  UpsertRepositoryInput,
  UpsertCredentialInput
} from '../shared/types';

contextBridge.exposeInMainWorld('svnDesktop', {
  appMenu: {
    onCommand: (listener: (command: AppMenuCommand) => void) => {
      const handler = (_: IpcRendererEvent, command: AppMenuCommand) => listener(command);
      ipcRenderer.on('app-menu:command', handler);
      return () => ipcRenderer.off('app-menu:command', handler);
    }
  },
  dependencies: {
    detect: () => ipcRenderer.invoke('dependencies:detect'),
    installSvn: () => ipcRenderer.invoke('dependencies:install-svn'),
    settings: () => ipcRenderer.invoke('dependencies:settings'),
    saveSettings: (input: AppSettings) => ipcRenderer.invoke('dependencies:save-settings', input),
    chooseFile: () => ipcRenderer.invoke('dependencies:choose-file'),
    chooseDirectory: () => ipcRenderer.invoke('dependencies:choose-directory')
  },
  credentials: {
    list: () => ipcRenderer.invoke('credentials:list'),
    save: (input: UpsertCredentialInput) => ipcRenderer.invoke('credentials:save', input),
    remove: (id: string) => ipcRenderer.invoke('credentials:remove', id)
  },
  repositories: {
    list: () => ipcRenderer.invoke('repositories:list'),
    addWorkingCopy: (input: AddWorkingCopyInput) => ipcRenderer.invoke('repositories:add-working-copy', input),
    checkout: (input: CheckoutInput) => ipcRenderer.invoke('repositories:checkout', input),
    testConnection: (input: TestConnectionInput) => ipcRenderer.invoke('repositories:test-connection', input),
    updateSettings: (input: UpsertRepositoryInput) => ipcRenderer.invoke('repositories:update-settings', input),
    remove: (id: string) => ipcRenderer.invoke('repositories:remove', id),
    status: (id: string, showUpdates?: boolean) => ipcRenderer.invoke('repositories:status', id, showUpdates),
    update: (id: string, targetPath?: string) => ipcRenderer.invoke('repositories:update', id, targetPath),
    add: (id: string, targetPath: string) => ipcRenderer.invoke('repositories:add', id, targetPath),
    delete: (id: string, targetPath: string) => ipcRenderer.invoke('repositories:delete', id, targetPath),
    revert: (id: string, targetPath: string, recursive?: boolean) =>
      ipcRenderer.invoke('repositories:revert', id, targetPath, recursive),
    ignore: (id: string, targetPath: string) => ipcRenderer.invoke('repositories:ignore', id, targetPath),
    cleanup: (id: string) => ipcRenderer.invoke('repositories:cleanup', id),
    commit: (input: CommitInput) => ipcRenderer.invoke('repositories:commit', input),
    resolve: (input: ResolveInput) => ipcRenderer.invoke('repositories:resolve', input),
    log: (id: string, limit?: number) => ipcRenderer.invoke('repositories:log', id, limit),
    openLocalPath: (id: string) => ipcRenderer.invoke('repositories:open-local-path', id),
    openInVSCode: (id: string, targetPath?: string) => ipcRenderer.invoke('repositories:open-vscode', id, targetPath),
    diffInVSCode: (id: string, targetPath: string) => ipcRenderer.invoke('repositories:diff-vscode', id, targetPath),
    mergeConflictInVSCode: (id: string, targetPath: string) => ipcRenderer.invoke('repositories:merge-conflict-vscode', id, targetPath),
    listRemote: (id: string, url?: string) => ipcRenderer.invoke('repositories:list-remote', id, url),
    openRemoteFileInVSCode: (id: string, url: string) => ipcRenderer.invoke('repositories:open-remote-file-vscode', id, url),
    remoteFileHistory: (id: string, url: string, limit?: number) => ipcRenderer.invoke('repositories:remote-file-history', id, url, limit),
    diffRevisionPath: (input: RevisionDiffInput) => ipcRenderer.invoke('repositories:diff-revision-path', input)
  },
  logs: {
    list: (repositoryId?: string) => ipcRenderer.invoke('logs:list', repositoryId),
    clear: (repositoryId?: string) => ipcRenderer.invoke('logs:clear', repositoryId)
  },
  tasks: {
    cancelActive: () => ipcRenderer.invoke('tasks:cancel-active'),
    onOutput: (listener: (event: CommandOutputEvent) => void) => {
      const handler = (_: IpcRendererEvent, event: CommandOutputEvent) => listener(event);
      ipcRenderer.on('tasks:output', handler);
      return () => ipcRenderer.off('tasks:output', handler);
    }
  }
});
