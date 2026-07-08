export type DependencyStatus = 'found' | 'missing';

export type DependencyCheck = {
  svn: {
    status: DependencyStatus;
    path: string | null;
    version: string | null;
    protocols: string[];
    error?: string;
  };
  brew: {
    status: DependencyStatus;
    path: string | null;
    error?: string;
  };
  vscode: {
    status: DependencyStatus;
    appPath: string | null;
    cliPath: string | null;
    error?: string;
  };
  legacyTls: {
    status: DependencyStatus;
    configPath: string;
  };
  svnConfigDir: string;
  appleSiliconOnly: true;
};

export type CredentialProfile = {
  id: string;
  name: string;
  matchUrl: string;
  username: string;
  password?: string;
  createdAt: string;
  updatedAt: string;
};

export type Repository = {
  id: string;
  name: string;
  remoteUrl: string;
  localPath: string;
  svnPath: string | null;
  credentialId: string | null;
  legacyTls: boolean;
  opensslConfigPath: string | null;
  trustServerCertFailures: boolean;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  svnPath: string | null;
  vscodeCliPath: string | null;
};

export type UpsertRepositoryInput = {
  id: string;
  name: string;
  remoteUrl: string;
  localPath: string;
  svnPath?: string | null;
  credentialId?: string | null;
  legacyTls?: boolean;
  trustServerCertFailures?: boolean;
};

export type OperationLog = {
  id: string;
  operation: string;
  repositoryId: string | null;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
};

export type CommandOutputEvent = {
  taskId: string;
  operation: string;
  repositoryId: string | null;
  stream: 'stdout' | 'stderr';
  chunk: string;
  at: string;
};

export type SvnStatusKind =
  | 'normal'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'unversioned'
  | 'conflicted'
  | 'missing'
  | 'replaced'
  | 'ignored'
  | 'external'
  | 'incomplete'
  | 'unknown';

export type SvnStatusItem = {
  path: string;
  relativePath: string;
  item: SvnStatusKind;
  props: string;
  revision?: string;
  remoteItem?: SvnStatusKind;
  remoteRevision?: string;
  author?: string;
  treeConflict?: string;
};

export type SvnLogChangedPath = {
  path: string;
  action: string;
  kind?: string;
  textModified?: boolean;
  propsModified?: boolean;
  copyFromPath?: string;
  copyFromRevision?: string;
};

export type SvnLogEntry = {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths: SvnLogChangedPath[];
};

export type SvnFileHistoryEntry = {
  revision: string;
  author: string;
  date: string;
  message: string;
  action?: string;
};

export type SvnRemoteEntry = {
  name: string;
  url: string;
  kind: 'file' | 'dir';
  size?: number;
  revision?: string;
  author?: string;
  date?: string;
};

export type TaskResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: {
    code: SvnErrorCode;
    message: string;
    raw: string;
    command?: string;
  };
  log?: OperationLog;
};

export type SvnErrorCode =
  | 'SVN_NOT_FOUND'
  | 'BREW_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'CERT_FAILED'
  | 'TLS_FAILED'
  | 'NETWORK_FAILED'
  | 'WORKING_COPY_LOCKED'
  | 'CONFLICT_EXISTS'
  | 'NOT_WORKING_COPY'
  | 'OUT_OF_DATE'
  | 'PATH_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

export type CheckoutInput = {
  name: string;
  remoteUrl: string;
  targetDir: string;
  credentialId: string;
  revision?: string;
  legacyTls?: boolean;
  trustServerCertFailures?: boolean;
};

export type AddWorkingCopyInput = {
  name: string;
  localPath: string;
  remoteUrl?: string;
  credentialId?: string | null;
  legacyTls?: boolean;
  trustServerCertFailures?: boolean;
};

export type CommitInput = {
  repositoryId: string;
  targets: string[];
  message: string;
};

export type ResolveInput = {
  repositoryId: string;
  path: string;
  accept: 'mine-full' | 'theirs-full' | 'working';
};

export type RevisionDiffInput = {
  repositoryId: string;
  revision: string;
  path: string;
  action: string;
};

export type UpsertCredentialInput = {
  id?: string;
  name: string;
  matchUrl: string;
  username: string;
  password: string;
};

export type TestConnectionInput = {
  remoteUrl: string;
  credentialId: string;
  legacyTls?: boolean;
  trustServerCertFailures?: boolean;
};

export type AppMenuCommand =
  | 'open-settings'
  | 'add-working-copy'
  | 'checkout-repository'
  | 'open-local-path'
  | 'open-vscode'
  | 'refresh-status'
  | 'refresh-remote-status'
  | 'update-working-copy'
  | 'cleanup-working-copy'
  | 'commit-selected'
  | 'show-changes'
  | 'show-conflicts'
  | 'show-remote'
  | 'show-history'
  | 'show-operation-logs';

export type SvnDesktopApi = {
  appMenu: {
    onCommand(listener: (command: AppMenuCommand) => void): () => void;
  };
  dependencies: {
    detect(): Promise<DependencyCheck>;
    installSvn(): Promise<TaskResult<string>>;
    settings(): Promise<AppSettings>;
    saveSettings(input: AppSettings): Promise<AppSettings>;
    chooseFile(): Promise<string | null>;
    chooseDirectory(): Promise<string | null>;
  };
  credentials: {
    list(): Promise<CredentialProfile[]>;
    save(input: UpsertCredentialInput): Promise<CredentialProfile>;
    remove(id: string): Promise<void>;
  };
  repositories: {
    list(): Promise<Repository[]>;
    addWorkingCopy(input: AddWorkingCopyInput): Promise<TaskResult<Repository>>;
    checkout(input: CheckoutInput): Promise<TaskResult<Repository>>;
    testConnection(input: TestConnectionInput): Promise<TaskResult<string>>;
    updateSettings(input: UpsertRepositoryInput): Promise<Repository>;
    remove(id: string): Promise<void>;
    status(id: string, showUpdates?: boolean): Promise<TaskResult<SvnStatusItem[]>>;
    update(id: string, targetPath?: string): Promise<TaskResult<string>>;
    add(id: string, targetPath: string): Promise<TaskResult<string>>;
    delete(id: string, targetPath: string): Promise<TaskResult<string>>;
    revert(id: string, targetPath: string, recursive?: boolean): Promise<TaskResult<string>>;
    ignore(id: string, targetPath: string): Promise<TaskResult<string>>;
    cleanup(id: string): Promise<TaskResult<string>>;
    commit(input: CommitInput): Promise<TaskResult<string>>;
    resolve(input: ResolveInput): Promise<TaskResult<string>>;
    log(id: string, limit?: number): Promise<TaskResult<SvnLogEntry[]>>;
    openLocalPath(id: string): Promise<void>;
    openInVSCode(id: string, targetPath?: string): Promise<TaskResult<string>>;
    diffInVSCode(id: string, targetPath: string): Promise<TaskResult<string>>;
    mergeConflictInVSCode(id: string, targetPath: string): Promise<TaskResult<string>>;
    listRemote(id: string, url?: string): Promise<TaskResult<SvnRemoteEntry[]>>;
    openRemoteFileInVSCode(id: string, url: string): Promise<TaskResult<string>>;
    remoteFileHistory(id: string, url: string, limit?: number): Promise<TaskResult<SvnFileHistoryEntry[]>>;
    diffRevisionPath(input: RevisionDiffInput): Promise<TaskResult<string>>;
  };
  logs: {
    list(repositoryId?: string): Promise<OperationLog[]>;
    clear(repositoryId?: string): Promise<void>;
  };
  tasks: {
    cancelActive(): Promise<number>;
    onOutput(listener: (event: CommandOutputEvent) => void): () => void;
  };
};
