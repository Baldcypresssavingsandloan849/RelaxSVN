import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions, OpenDialogOptions } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';
import type {
  AddWorkingCopyInput,
  AppMenuCommand,
  AppSettings,
  CheckoutInput,
  CommandOutputEvent,
  CommitInput,
  CredentialProfile,
  DependencyCheck,
  OperationLog,
  Repository,
  RevisionDiffInput,
  ResolveInput,
  SvnRemoteEntry,
  SvnErrorCode,
  SvnFileHistoryEntry,
  SvnLogEntry,
  SvnStatusItem,
  TaskResult,
  TestConnectionInput,
  UpsertRepositoryInput,
  UpsertCredentialInput
} from '../shared/types';

const isDev = process.env.NODE_ENV === 'development';
const APPLE_SILICON_SVN = '/opt/homebrew/bin/svn';
const APPLE_SILICON_BREW = '/opt/homebrew/bin/brew';
const FALLBACK_VSCODE_CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const LEGACY_OPENSSL_CONFIG = `openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
MinProtocol = TLSv1
CipherString = DEFAULT@SECLEVEL=0
`;

type RunOptions = {
  operation: string;
  repositoryId?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  sensitive?: string[];
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  log: OperationLog;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  trimValues: false
});

function now(): string {
  return new Date().toISOString();
}

function oneOrMany<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toBool(value: number | boolean): boolean {
  return value === true || value === 1;
}

function sanitize(text: string, sensitive: string[] = []): string {
  let cleaned = text.replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1$2:******@');
  for (const secret of sensitive.filter(Boolean)) {
    cleaned = cleaned.split(secret).join('******');
  }
  return cleaned;
}

function classifyError(raw: string): SvnErrorCode {
  const text = raw.toLowerCase();
  if (text.includes('e170001') || text.includes('authentication failed')) return 'AUTH_FAILED';
  if (text.includes('unknown ca') || text.includes('certificate verify') || text.includes('certificate expired')) return 'CERT_FAILED';
  if (text.includes('ssl') || text.includes('tls') || text.includes('handshake') || text.includes('unsupported protocol')) return 'TLS_FAILED';
  if (text.includes('locked') || text.includes('previous operation has not finished')) return 'WORKING_COPY_LOCKED';
  if (text.includes('conflict')) return 'CONFLICT_EXISTS';
  if (text.includes('not a working copy')) return 'NOT_WORKING_COPY';
  if (text.includes('out of date')) return 'OUT_OF_DATE';
  if (text.includes('no such file') || text.includes('path not found')) return 'PATH_NOT_FOUND';
  if (text.includes('permission denied')) return 'PERMISSION_DENIED';
  if (text.includes('could not resolve') || text.includes('connection') || text.includes('timed out')) return 'NETWORK_FAILED';
  return 'UNKNOWN';
}

function friendlyMessage(code: SvnErrorCode): string {
  const messages: Record<SvnErrorCode, string> = {
    SVN_NOT_FOUND: '没有找到 SVN，请先安装 Homebrew subversion。',
    BREW_NOT_FOUND: '没有找到 Homebrew，App 不会自动安装 Homebrew。',
    AUTH_FAILED: '认证失败，请检查账号或密码。',
    CERT_FAILED: '证书校验失败，可以尝试开启旧 TLS/证书兼容模式。',
    TLS_FAILED: 'TLS 握手失败，可以尝试开启旧 TLS 兼容模式。',
    NETWORK_FAILED: '网络连接失败，请检查仓库地址和网络。',
    WORKING_COPY_LOCKED: '工作副本被锁定，请先执行 cleanup。',
    CONFLICT_EXISTS: '存在冲突，请先处理冲突再继续。',
    NOT_WORKING_COPY: '这个目录不是 SVN 工作副本。',
    OUT_OF_DATE: '工作副本不是最新版本，请先更新。',
    PATH_NOT_FOUND: '路径不存在。',
    PERMISSION_DENIED: '没有足够的文件权限。',
    UNKNOWN: 'SVN 命令执行失败。'
  };
  return messages[code];
}

class AppStore {
  private db: Database.Database;

  constructor(private userData: string) {
    mkdirSync(userData, { recursive: true });
    const dbPath = join(userData, 'svn-desktop.sqlite');
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists credentials (
        id text primary key,
        name text not null,
        match_url text not null,
        username text not null,
        password text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists repositories (
        id text primary key,
        name text not null,
        remote_url text not null,
        local_path text not null,
        svn_path text,
        credential_id text,
        legacy_tls integer not null default 0,
        openssl_config_path text,
        trust_server_cert_failures integer not null default 0,
        last_opened_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists operation_logs (
        id text primary key,
        operation text not null,
        repository_id text,
        command text not null,
        exit_code integer,
        stdout text not null,
        stderr text not null,
        started_at text not null,
        finished_at text not null
      );

      create table if not exists app_settings (
        key text primary key,
        value text
      );
    `);
  }

  settings(): AppSettings {
    const rows = this.db.prepare('select key, value from app_settings').all() as Array<{ key: string; value: string | null }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      svnPath: values.get('svnPath') || null,
      vscodeCliPath: values.get('vscodeCliPath') || null
    };
  }

  saveSettings(input: AppSettings): AppSettings {
    const settings: AppSettings = {
      svnPath: input.svnPath?.trim() || null,
      vscodeCliPath: input.vscodeCliPath?.trim() || null
    };
    const statement = this.db.prepare(
      `insert into app_settings (key, value)
       values (?, ?)
       on conflict(key) do update set value = excluded.value`
    );
    statement.run('svnPath', settings.svnPath);
    statement.run('vscodeCliPath', settings.vscodeCliPath);
    return settings;
  }

  listCredentials(includePasswords = false): CredentialProfile[] {
    return this.db
      .prepare('select * from credentials order by updated_at desc')
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        matchUrl: row.match_url,
        username: row.username,
        password: includePasswords ? row.password : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  getCredential(id: string): CredentialProfile | null {
    const row = this.db.prepare('select * from credentials where id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      matchUrl: row.match_url,
      username: row.username,
      password: row.password,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  saveCredential(input: UpsertCredentialInput): CredentialProfile {
    const timestamp = now();
    const existing = input.id ? this.getCredential(input.id) : null;
    const credential: CredentialProfile = {
      id: input.id ?? randomUUID(),
      name: input.name.trim(),
      matchUrl: input.matchUrl.trim(),
      username: input.username.trim(),
      password: input.password,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.db
      .prepare(
        `insert into credentials (id, name, match_url, username, password, created_at, updated_at)
         values (@id, @name, @matchUrl, @username, @password, @createdAt, @updatedAt)
         on conflict(id) do update set
          name = excluded.name,
          match_url = excluded.match_url,
          username = excluded.username,
          password = excluded.password,
          updated_at = excluded.updated_at`
      )
      .run(credential);
    return { ...credential, password: undefined };
  }

  removeCredential(id: string): void {
    this.db.prepare('delete from credentials where id = ?').run(id);
  }

  listRepositories(): Repository[] {
    return this.db
      .prepare('select * from repositories order by coalesce(last_opened_at, updated_at) desc')
      .all()
      .map((row: any) => this.mapRepository(row));
  }

  getRepository(id: string): Repository | null {
    const row = this.db.prepare('select * from repositories where id = ?').get(id) as any;
    return row ? this.mapRepository(row) : null;
  }

  saveRepository(input: Omit<Repository, 'createdAt' | 'updatedAt'> & Partial<Pick<Repository, 'createdAt' | 'updatedAt'>>): Repository {
    const timestamp = now();
    const existing = this.getRepository(input.id);
    const repository: Repository = {
      ...input,
      createdAt: input.createdAt ?? existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.db
      .prepare(
        `insert into repositories (
          id, name, remote_url, local_path, svn_path, credential_id, legacy_tls, openssl_config_path,
          trust_server_cert_failures, last_opened_at, created_at, updated_at
        ) values (
          @id, @name, @remoteUrl, @localPath, @svnPath, @credentialId, @legacyTls, @opensslConfigPath,
          @trustServerCertFailures, @lastOpenedAt, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          name = excluded.name,
          remote_url = excluded.remote_url,
          local_path = excluded.local_path,
          svn_path = excluded.svn_path,
          credential_id = excluded.credential_id,
          legacy_tls = excluded.legacy_tls,
          openssl_config_path = excluded.openssl_config_path,
          trust_server_cert_failures = excluded.trust_server_cert_failures,
          last_opened_at = excluded.last_opened_at,
          updated_at = excluded.updated_at`
      )
      .run({
        ...repository,
        legacyTls: repository.legacyTls ? 1 : 0,
        trustServerCertFailures: repository.trustServerCertFailures ? 1 : 0
      });
    return repository;
  }

  updateRepository(input: UpsertRepositoryInput): Repository {
    const existing = this.getRepository(input.id);
    if (!existing) throw new Error(`Repository not found: ${input.id}`);
    return this.saveRepository({
      ...existing,
      name: input.name.trim(),
      remoteUrl: input.remoteUrl.trim(),
      localPath: input.localPath.trim(),
      svnPath: input.svnPath?.trim() || null,
      credentialId: input.credentialId || null,
      legacyTls: Boolean(input.legacyTls),
      opensslConfigPath: input.legacyTls ? join(this.userData, 'openssl-legacy-svn.cnf') : null,
      trustServerCertFailures: Boolean(input.trustServerCertFailures),
      lastOpenedAt: existing.lastOpenedAt
    });
  }

  removeRepository(id: string): void {
    this.db.prepare('delete from repositories where id = ?').run(id);
  }

  addLog(log: OperationLog): void {
    this.db
      .prepare(
        `insert into operation_logs
         (id, operation, repository_id, command, exit_code, stdout, stderr, started_at, finished_at)
         values (@id, @operation, @repositoryId, @command, @exitCode, @stdout, @stderr, @startedAt, @finishedAt)`
      )
      .run(log);
  }

  listLogs(repositoryId?: string): OperationLog[] {
    const sql = repositoryId
      ? 'select * from operation_logs where repository_id = ? order by started_at desc limit 200'
      : 'select * from operation_logs order by started_at desc limit 200';
    const rows = repositoryId ? this.db.prepare(sql).all(repositoryId) : this.db.prepare(sql).all();
    return rows.map((row: any) => ({
      id: row.id,
      operation: row.operation,
      repositoryId: row.repository_id,
      command: row.command,
      exitCode: row.exit_code,
      stdout: row.stdout,
      stderr: row.stderr,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }));
  }

  clearLogs(repositoryId?: string): void {
    if (repositoryId) {
      this.db.prepare('delete from operation_logs where repository_id = ?').run(repositoryId);
      return;
    }
    this.db.prepare('delete from operation_logs').run();
  }

  private mapRepository(row: any): Repository {
    return {
      id: row.id,
      name: row.name,
      remoteUrl: row.remote_url,
      localPath: row.local_path,
      svnPath: row.svn_path,
      credentialId: row.credential_id,
      legacyTls: toBool(row.legacy_tls),
      opensslConfigPath: row.openssl_config_path,
      trustServerCertFailures: toBool(row.trust_server_cert_failures),
      lastOpenedAt: row.last_opened_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

class DependencyService {
  constructor(
    private userData: string,
    private store: AppStore
  ) {}

  svnConfigDir(): string {
    const dir = join(this.userData, 'svn-config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config'),
      '[auth]\npassword-stores =\nstore-passwords = no\nstore-auth-creds = no\n',
      { mode: 0o600 }
    );
    writeFileSync(join(dir, 'servers'), '[global]\nstore-passwords = no\nstore-auth-creds = no\n', { mode: 0o600 });
    return dir;
  }

  legacyConfigPath(): string {
    return join(this.userData, 'openssl-legacy-svn.cnf');
  }

  ensureLegacyConfig(): string {
    const configPath = this.legacyConfigPath();
    if (!existsSync(configPath)) {
      mkdirSync(this.userData, { recursive: true });
      writeFileSync(configPath, LEGACY_OPENSSL_CONFIG, { mode: 0o600 });
    }
    return configPath;
  }

  async detect(): Promise<DependencyCheck> {
    const [svn, brew] = await Promise.all([this.detectSvn(), this.detectBrew()]);
    const vscodeCli = existsSync(FALLBACK_VSCODE_CLI) ? FALLBACK_VSCODE_CLI : await this.which('code');
    const vscodeApp = '/Applications/Visual Studio Code.app';
    const legacyConfigPath = this.ensureLegacyConfig();
    return {
      svn,
      brew,
      vscode: {
        status: vscodeCli || existsSync(vscodeApp) ? 'found' : 'missing',
        appPath: existsSync(vscodeApp) ? vscodeApp : null,
        cliPath: vscodeCli || null
      },
      legacyTls: {
        status: existsSync(legacyConfigPath) ? 'found' : 'missing',
        configPath: legacyConfigPath
      },
      svnConfigDir: this.svnConfigDir(),
      appleSiliconOnly: true
    };
  }

  async svnPath(): Promise<string | null> {
    const configured = this.store.settings().svnPath;
    if (configured && existsSync(configured)) return configured;
    if (existsSync(APPLE_SILICON_SVN)) return APPLE_SILICON_SVN;
    return this.which('svn');
  }

  async brewPath(): Promise<string | null> {
    if (existsSync(APPLE_SILICON_BREW)) return APPLE_SILICON_BREW;
    return this.which('brew');
  }

  async vscodeCliPath(): Promise<string | null> {
    const configured = this.store.settings().vscodeCliPath;
    if (configured && existsSync(configured)) return configured;
    if (existsSync(FALLBACK_VSCODE_CLI)) return FALLBACK_VSCODE_CLI;
    return this.which('code');
  }

  private async detectSvn(): Promise<DependencyCheck['svn']> {
    const svnPath = await this.svnPath();
    if (!svnPath) return { status: 'missing', path: null, version: null, protocols: [], error: 'svn not found' };
    const result = await runRaw(svnPath, ['--version', '--quiet']);
    const verbose = await runRaw(svnPath, ['--version']);
    const protocols = ['http', 'https', 'svn', 'file'].filter((protocol) => verbose.stdout.includes(`${protocol}:`));
    return {
      status: result.exitCode === 0 ? 'found' : 'missing',
      path: svnPath,
      version: result.stdout.trim() || null,
      protocols,
      error: result.exitCode === 0 ? undefined : result.stderr
    };
  }

  private async detectBrew(): Promise<DependencyCheck['brew']> {
    const brewPath = await this.brewPath();
    if (!brewPath) return { status: 'missing', path: null, error: 'brew not found' };
    return { status: 'found', path: brewPath };
  }

  private async which(bin: string): Promise<string | null> {
    const result = await runRaw('/usr/bin/which', [bin], { PATH: process.env.PATH ?? '' });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
}

class CommandRunner {
  private activeChildren = new Set<ReturnType<typeof spawn>>();

  constructor(private store: AppStore) {}

  cancelActive(): number {
    let cancelled = 0;
    for (const child of this.activeChildren) {
      if (!child.killed) {
        child.kill('SIGTERM');
        cancelled += 1;
      }
    }
    return cancelled;
  }

  run(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
    const taskId = randomUUID();
    const startedAt = now();
    const commandText = sanitize([command, ...args.map((arg) => JSON.stringify(arg))].join(' '), options.sensitive);
    return new Promise((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout += text;
        emitTaskOutput({
          taskId,
          operation: options.operation,
          repositoryId: options.repositoryId ?? null,
          stream: 'stdout',
          chunk: sanitize(text, options.sensitive),
          at: now()
        });
      });
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr += text;
        emitTaskOutput({
          taskId,
          operation: options.operation,
          repositoryId: options.repositoryId ?? null,
          stream: 'stderr',
          chunk: sanitize(text, options.sensitive),
          at: now()
        });
      });
      child.on('error', (error) => {
        stderr += error.message;
      });
      child.on('close', (exitCode) => {
        this.activeChildren.delete(child);
        const finishedAt = now();
        const log: OperationLog = {
          id: randomUUID(),
          operation: options.operation,
          repositoryId: options.repositoryId ?? null,
          command: commandText,
          exitCode,
          stdout: sanitize(stdout, options.sensitive),
          stderr: sanitize(stderr, options.sensitive),
          startedAt,
          finishedAt
        };
        this.store.addLog(log);
        resolvePromise({ exitCode, stdout, stderr, command: commandText, log });
      });
      if (options.stdin) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}

class SvnService {
  constructor(
    private store: AppStore,
    private deps: DependencyService,
    private runner: CommandRunner
  ) {}

  async installSvn(): Promise<TaskResult<string>> {
    const brew = await this.deps.brewPath();
    if (!brew) return this.failure('BREW_NOT_FOUND', 'brew install subversion');
    const result = await this.runner.run(brew, ['install', 'subversion'], { operation: 'install-svn' });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  async testConnection(input: TestConnectionInput): Promise<TaskResult<string>> {
    const credential = this.store.getCredential(input.credentialId);
    const svn = await this.deps.svnPath();
    if (!svn) return this.failure('SVN_NOT_FOUND', 'svn info');
    if (!credential?.password) return this.failure('AUTH_FAILED', 'svn info');
    const first = await this.runSvn(svn, ['info', input.remoteUrl], {
      operation: 'test-connection',
      credential,
      legacyTls: false,
      trustServerCertFailures: Boolean(input.trustServerCertFailures)
    });
    if (first.ok) return first;
    if (this.canRetryWithCompatibility(first) && input.legacyTls) {
      return this.runSvn(svn, ['info', input.remoteUrl], {
        operation: 'test-connection-legacy',
        credential,
        legacyTls: true,
        trustServerCertFailures: Boolean(input.trustServerCertFailures)
      });
    }
    return first;
  }

  async addWorkingCopy(input: AddWorkingCopyInput): Promise<TaskResult<Repository>> {
    const svn = await this.deps.svnPath();
    if (!svn) return this.failure('SVN_NOT_FOUND', 'svn info');
    const info = await this.runSvn(svn, ['info', input.localPath, '--xml'], {
      operation: 'add-working-copy-info',
      legacyTls: Boolean(input.legacyTls),
      trustServerCertFailures: Boolean(input.trustServerCertFailures)
    });
    if (!info.ok) return this.asFailure<Repository>(info);
    const xml = parser.parse(info.data ?? '');
    const remoteUrl = input.remoteUrl?.trim() || xml?.info?.entry?.url || '';
    const repository = this.store.saveRepository({
      id: randomUUID(),
      name: input.name.trim(),
      remoteUrl,
      localPath: input.localPath.trim(),
      svnPath: svn,
      credentialId: input.credentialId ?? null,
      legacyTls: Boolean(input.legacyTls),
      opensslConfigPath: input.legacyTls ? this.deps.legacyConfigPath() : null,
      trustServerCertFailures: Boolean(input.trustServerCertFailures),
      lastOpenedAt: now()
    });
    return { ok: true, data: repository, log: info.log };
  }

  async checkout(input: CheckoutInput): Promise<TaskResult<Repository>> {
    const credential = this.store.getCredential(input.credentialId);
    const svn = await this.deps.svnPath();
    if (!svn) return this.failure('SVN_NOT_FOUND', 'svn checkout');
    if (!credential?.password) return this.failure('AUTH_FAILED', 'svn checkout');
    const targetDir = input.targetDir.trim();
    const conflict = this.findCheckoutPathConflict(targetDir);
    if (conflict) {
      return this.failure(
        'PATH_NOT_FOUND',
        'svn checkout',
        `目标目录不能和已有工作副本“${conflict.name}”相同，也不能放在它的目录里面。请选择一个新的空目录。`
      );
    }
    let usedLegacyTls = false;
    let usedTrustFailures = Boolean(input.trustServerCertFailures);
    const revisionArgs = input.revision?.trim() ? ['-r', input.revision.trim()] : [];
    let result = await this.runSvn(svn, ['checkout', ...revisionArgs, input.remoteUrl, targetDir], {
      operation: 'checkout',
      credential,
      legacyTls: false,
      trustServerCertFailures: usedTrustFailures
    });
    if (!result.ok && this.canRetryWithCompatibility(result) && input.legacyTls) {
      usedLegacyTls = true;
      result = await this.runSvn(svn, ['checkout', ...revisionArgs, input.remoteUrl, targetDir], {
        operation: 'checkout-legacy',
        credential,
        legacyTls: true,
        trustServerCertFailures: usedTrustFailures
      });
    }
    if (!result.ok) return this.asFailure<Repository>(result);
    const repository = this.store.saveRepository({
      id: randomUUID(),
      name: input.name.trim(),
      remoteUrl: input.remoteUrl.trim(),
      localPath: targetDir,
      svnPath: svn,
      credentialId: input.credentialId,
      legacyTls: usedLegacyTls,
      opensslConfigPath: usedLegacyTls ? this.deps.legacyConfigPath() : null,
      trustServerCertFailures: usedTrustFailures,
      lastOpenedAt: now()
    });
    return { ok: true, data: repository, log: result.log };
  }

  async status(repositoryId: string, showUpdates = false): Promise<TaskResult<SvnStatusItem[]>> {
    const repo = this.requireRepository(repositoryId);
    const result = await this.runRepoSvn(repo, ['status', repo.localPath, '--xml', ...(showUpdates ? ['--show-updates'] : [])], {
      operation: 'status'
    });
    if (!result.ok) return this.asFailure<SvnStatusItem[]>(result);
    const xml = parser.parse(result.data ?? '');
    const target = oneOrMany(xml?.status?.target);
    const items = target.flatMap((targetNode: any) =>
      oneOrMany(targetNode.entry).map((entry: any) => {
        const wc = entry['wc-status'] ?? {};
        const repos = entry['repos-status'] ?? {};
        return {
          path: entry.path,
          relativePath: repo.localPath && entry.path?.startsWith(repo.localPath)
            ? entry.path.slice(repo.localPath.length).replace(/^\//, '')
            : entry.path,
          item: this.mapStatus(wc.item),
          props: wc.props ?? 'none',
          revision: wc.revision ? String(wc.revision) : undefined,
          remoteItem: repos.item && repos.item !== 'none' ? this.mapStatus(repos.item) : undefined,
          remoteRevision: repos.revision ? String(repos.revision) : undefined,
          author: wc.commit?.author,
          treeConflict: entry['tree-conflict'] ? JSON.stringify(entry['tree-conflict']) : undefined
        } satisfies SvnStatusItem;
      })
    );
    return { ok: true, data: items, log: result.log };
  }

  async update(repositoryId: string, targetPath?: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    return this.runRepoSvn(repo, ['update', targetPath || repo.localPath, '--accept', 'postpone'], { operation: 'update' });
  }

  async add(repositoryId: string, targetPath: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    return this.runRepoSvn(repo, ['add', targetPath], { operation: 'add' });
  }

  async delete(repositoryId: string, targetPath: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    return this.runRepoSvn(repo, ['delete', targetPath], { operation: 'delete' });
  }

  async revert(repositoryId: string, targetPath: string, recursive = false): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    return this.runRepoSvn(repo, ['revert', targetPath, ...(recursive ? ['--depth', 'infinity'] : [])], { operation: 'revert' });
  }

  async ignore(repositoryId: string, targetPath: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    const parentDir = dirname(targetPath);
    const name = basename(targetPath);
    if (!name || name === '.' || parentDir === targetPath) {
      return this.failure('PATH_NOT_FOUND', 'svn propset svn:ignore', '无法识别要忽略的文件名。');
    }
    const current = await this.runRepoSvn(repo, ['propget', 'svn:ignore', parentDir], { operation: 'propget-ignore' });
    const existing = current.ok ? current.data ?? '' : '';
    const patterns = existing
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!patterns.includes(name)) patterns.push(name);
    return this.runRepoSvn(repo, ['propset', 'svn:ignore', patterns.join('\n'), parentDir], { operation: 'propset-ignore' });
  }

  async cleanup(repositoryId: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    return this.runRepoSvn(repo, ['cleanup', repo.localPath], { operation: 'cleanup' });
  }

  async commit(input: CommitInput): Promise<TaskResult<string>> {
    const repo = this.requireRepository(input.repositoryId);
    if (!input.message.trim()) {
      return this.failure('UNKNOWN', 'svn commit', '提交备注不能为空。');
    }
    if (input.targets.length === 0) {
      return this.failure('UNKNOWN', 'svn commit', '请至少选择一个文件。');
    }
    const tmp = mkdtempSync(join(tmpdir(), 'svn-desktop-'));
    try {
      const targetsFile = join(tmp, 'targets.txt');
      const messageFile = join(tmp, 'message.txt');
      writeFileSync(targetsFile, input.targets.join('\n'));
      writeFileSync(messageFile, input.message);
      return await this.runRepoSvn(repo, ['commit', '--targets', targetsFile, '-F', messageFile], {
        operation: 'commit',
        extraSensitive: [targetsFile, messageFile]
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async resolveConflict(input: ResolveInput): Promise<TaskResult<string>> {
    const repo = this.requireRepository(input.repositoryId);
    return this.runRepoSvn(repo, ['resolve', '--accept', input.accept, input.path], { operation: 'resolve' });
  }

  async log(repositoryId: string, limit = 50): Promise<TaskResult<SvnLogEntry[]>> {
    const repo = this.requireRepository(repositoryId);
    const target = repo.remoteUrl || repo.localPath;
    const result = await this.runRepoSvn(repo, ['log', target, '--xml', '--verbose', '-r', 'HEAD:1', '--limit', String(limit)], {
      operation: 'log'
    });
    if (!result.ok) return this.asFailure<SvnLogEntry[]>(result);
    const xml = parser.parse(result.data ?? '');
    const entries = oneOrMany(xml?.log?.logentry).map((entry: any) => {
      const paths = oneOrMany(entry.paths?.path).map((pathNode: any) => ({
        path: String(pathNode.text ?? pathNode ?? ''),
        action: pathNode.action ?? '',
        kind: pathNode.kind,
        textModified: pathNode['text-mods'] === 'true',
        propsModified: pathNode['prop-mods'] === 'true',
        copyFromPath: pathNode['copyfrom-path'],
        copyFromRevision: pathNode['copyfrom-rev'] ? String(pathNode['copyfrom-rev']) : undefined
      }));
      return {
        revision: String(entry.revision),
        author: entry.author ?? '',
        date: entry.date ?? '',
        message: entry.msg ?? '',
        paths
      };
    });
    return { ok: true, data: entries, log: result.log };
  }

  async openInVSCode(repositoryId: string, targetPath?: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    const cli = await this.deps.vscodeCliPath();
    if (!cli) return this.failure('PATH_NOT_FOUND', 'code', '没有找到 VSCode CLI。');
    const path = targetPath || repo.localPath;
    const result = await this.runner.run(cli, this.vscodeArgs([path]), { operation: 'open-vscode', repositoryId });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  async diffInVSCode(repositoryId: string, targetPath: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    const cli = await this.deps.vscodeCliPath();
    if (!cli) return this.failure('PATH_NOT_FOUND', 'code --diff', '没有找到 VSCode CLI。');
    const baseResult = await this.runRepoSvn(repo, ['cat', targetPath], { operation: 'cat-base' });
    if (!baseResult.ok) return baseResult;
    const tmp = mkdtempSync(join(tmpdir(), 'svn-desktop-diff-'));
    const baseFile = join(tmp, `base-${targetPath.split('/').pop() || 'file'}`);
    writeFileSync(baseFile, baseResult.data ?? '');
    const result = await this.runner.run(cli, this.vscodeArgs(['--diff', baseFile, targetPath]), { operation: 'diff-vscode', repositoryId });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  async mergeConflictInVSCode(repositoryId: string, targetPath: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    const cli = await this.deps.vscodeCliPath();
    if (!cli) return this.failure('PATH_NOT_FOUND', 'code --merge', '没有找到 VSCode CLI。');
    const files = this.findConflictFiles(targetPath);
    if (!files) return this.failure('PATH_NOT_FOUND', 'code --merge', '没有找到 SVN 冲突临时文件。请确认这个文件仍处于冲突状态。');
    const result = await this.runner.run(cli, this.vscodeArgs(['--merge', files.mine, files.theirs, files.base, targetPath]), {
      operation: 'merge-vscode',
      repositoryId
    });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  async listRemote(repositoryId: string, url?: string): Promise<TaskResult<SvnRemoteEntry[]>> {
    const repo = this.requireRepository(repositoryId);
    const targetUrl = this.normalizeRemoteUrl(url || repo.remoteUrl);
    if (!targetUrl) return this.failure('PATH_NOT_FOUND', 'svn list', '远程仓库地址为空。');
    const result = await this.runRepoSvn(repo, ['list', targetUrl, '--xml'], { operation: 'remote-list' });
    if (!result.ok) return this.asFailure<SvnRemoteEntry[]>(result);
    const xml = parser.parse(result.data ?? '');
    const entries = oneOrMany(xml?.lists?.list?.entry).map((entry: any) => {
      const kind = entry.kind === 'dir' ? 'dir' : 'file';
      const name = String(entry.name ?? '');
      const commit = entry.commit ?? {};
      return {
        name,
        url: this.joinRemoteUrl(targetUrl, name, kind),
        kind,
        size: entry.size == null ? undefined : Number(entry.size),
        revision: commit.revision == null ? undefined : String(commit.revision),
        author: commit.author,
        date: commit.date
      } satisfies SvnRemoteEntry;
    });
    return { ok: true, data: entries, log: result.log };
  }

  async openRemoteFileInVSCode(repositoryId: string, url: string): Promise<TaskResult<string>> {
    const repo = this.requireRepository(repositoryId);
    const cli = await this.deps.vscodeCliPath();
    if (!cli) return this.failure('PATH_NOT_FOUND', 'code', '没有找到 VSCode CLI。');
    const targetUrl = this.normalizeRemoteUrl(url);
    if (!targetUrl) return this.failure('PATH_NOT_FOUND', 'svn cat', '远程文件地址为空。');
    const content = await this.runRepoSvn(repo, ['cat', targetUrl], { operation: 'remote-cat' });
    if (!content.ok) return content;
    const tmp = mkdtempSync(join(tmpdir(), 'svn-desktop-remote-'));
    const fileName = this.safeTempName(decodeURIComponent(targetUrl.split('/').filter(Boolean).pop() || 'remote-file'));
    const filePath = join(tmp, fileName);
    writeFileSync(filePath, content.data ?? '');
    const result = await this.runner.run(cli, this.vscodeArgs([filePath]), { operation: 'remote-open-vscode', repositoryId });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  async remoteFileHistory(repositoryId: string, url: string, limit = 30): Promise<TaskResult<SvnFileHistoryEntry[]>> {
    const repo = this.requireRepository(repositoryId);
    const targetUrl = this.normalizeRemoteUrl(url);
    if (!targetUrl) return this.failure('PATH_NOT_FOUND', 'svn log', '远程文件地址为空。');
    const result = await this.runRepoSvn(repo, ['log', targetUrl, '--xml', '--verbose', '-r', 'HEAD:1', '--limit', String(limit)], {
      operation: 'remote-file-history'
    });
    if (!result.ok) return this.asFailure<SvnFileHistoryEntry[]>(result);
    const xml = parser.parse(result.data ?? '');
    const entries = oneOrMany(xml?.log?.logentry).map((entry: any) => {
      const paths = oneOrMany(entry.paths?.path);
      const changedPath = paths.find((pathNode: any) => String(pathNode.text ?? pathNode ?? '').length > 0) ?? paths[0];
      return {
        revision: String(entry.revision),
        author: entry.author ?? '',
        date: entry.date ?? '',
        message: entry.msg ?? '',
        action: changedPath?.action
      } satisfies SvnFileHistoryEntry;
    });
    return { ok: true, data: entries, log: result.log };
  }

  async diffRevisionPath(input: RevisionDiffInput): Promise<TaskResult<string>> {
    const repo = this.requireRepository(input.repositoryId);
    const cli = await this.deps.vscodeCliPath();
    if (!cli) return this.failure('PATH_NOT_FOUND', 'code --diff', '没有找到 VSCode CLI。');

    const revision = Number.parseInt(input.revision, 10);
    if (!Number.isFinite(revision) || revision <= 0) {
      return this.failure('UNKNOWN', 'svn cat', '版本号无效。');
    }

    const info = await this.runRepoSvn(repo, ['info', repo.localPath, '--xml'], { operation: 'diff-revision-info' });
    if (!info.ok) return this.asFailure<string>(info);
    const xml = parser.parse(info.data ?? '');
    const rootUrl = String(xml?.info?.entry?.repository?.root ?? '').replace(/\/$/, '');
    if (!rootUrl) return this.failure('UNKNOWN', 'svn info', '无法读取仓库根地址。');

    const repositoryPath = input.path.startsWith('/') ? input.path : `/${input.path}`;
    const targetUrl = `${rootUrl}${repositoryPath}`;
    const tmp = mkdtempSync(join(tmpdir(), 'svn-desktop-revision-diff-'));
    const name = this.safeTempName(repositoryPath.split('/').pop() || 'file');
    const beforeFile = join(tmp, `r${Math.max(revision - 1, 0)}-${name}`);
    const afterFile = join(tmp, `r${revision}-${name}`);

    const beforeRevision = String(Math.max(revision - 1, 0));
    const shouldReadBefore = input.action !== 'A' && revision > 1;
    const shouldReadAfter = input.action !== 'D';

    const before = shouldReadBefore
      ? await this.runRepoSvn(repo, ['cat', `${targetUrl}@${beforeRevision}`, '-r', beforeRevision], { operation: 'cat-revision-before' })
      : ({ ok: true, data: '' } as TaskResult<string>);
    if (!before.ok) return this.asFailure<string>(before);

    const after = shouldReadAfter
      ? await this.runRepoSvn(repo, ['cat', `${targetUrl}@${input.revision}`, '-r', input.revision], { operation: 'cat-revision-after' })
      : ({ ok: true, data: '' } as TaskResult<string>);
    if (!after.ok) return this.asFailure<string>(after);

    writeFileSync(beforeFile, before.data ?? '');
    writeFileSync(afterFile, after.data ?? '');

    const result = await this.runner.run(cli, this.vscodeArgs(['--diff', beforeFile, afterFile]), {
      operation: 'diff-revision-vscode',
      repositoryId: repo.id
    });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  private vscodeArgs(args: string[]): string[] {
    return ['--disable-workspace-trust', '--new-window', ...args];
  }

  private safeTempName(name: string): string {
    return name.replace(/[^\w.-]+/g, '_') || 'file';
  }

  private normalizeRemoteUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  private joinRemoteUrl(baseUrl: string, name: string, kind: SvnRemoteEntry['kind']): string {
    const encodedName = encodeURIComponent(name).replace(/%2F/gi, '/');
    return `${this.normalizeRemoteUrl(baseUrl)}/${encodedName}${kind === 'dir' ? '/' : ''}`;
  }

  private findConflictFiles(targetPath: string): { mine: string; theirs: string; base: string } | null {
    const folder = dirname(targetPath);
    const fileName = basename(targetPath);
    if (!existsSync(folder)) return null;
    const entries = readdirSync(folder);
    const mine = join(folder, `${fileName}.mine`);
    const revisions = entries
      .map((entry) => {
        const match = entry.match(new RegExp(`^${this.escapeRegExp(fileName)}\\.r(\\d+)$`));
        return match ? { path: join(folder, entry), revision: Number(match[1]) } : null;
      })
      .filter((entry): entry is { path: string; revision: number } => Boolean(entry))
      .sort((left, right) => left.revision - right.revision);
    if (!existsSync(mine) || revisions.length < 2) return null;
    return {
      mine,
      base: revisions[0].path,
      theirs: revisions[revisions.length - 1].path
    };
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async runRepoSvn(repo: Repository, args: string[], options: { operation: string; extraSensitive?: string[] }): Promise<TaskResult<string>> {
    const credential = repo.credentialId ? this.store.getCredential(repo.credentialId) : null;
    const svn = await this.resolveSvn(repo);
    const result = await this.runSvn(svn, args, {
      operation: options.operation,
      repositoryId: repo.id,
      credential: credential ?? undefined,
      legacyTls: repo.legacyTls,
      trustServerCertFailures: repo.trustServerCertFailures,
      extraSensitive: options.extraSensitive
    });
    if (!repo.legacyTls || result.ok || !this.canRetryWithCompatibility(result)) return result;
    return this.runSvn(svn, args, {
      operation: `${options.operation}-standard-tls`,
      repositoryId: repo.id,
      credential: credential ?? undefined,
      legacyTls: false,
      trustServerCertFailures: repo.trustServerCertFailures,
      extraSensitive: options.extraSensitive
    });
  }

  private async runSvn(
    svn: string,
    args: string[],
    options: {
      operation: string;
      repositoryId?: string;
      credential?: CredentialProfile;
      legacyTls?: boolean;
      trustServerCertFailures?: boolean;
      extraSensitive?: string[];
    }
  ): Promise<TaskResult<string>> {
    const fullArgs = [
      ...args,
      '--non-interactive',
      '--no-auth-cache',
      '--config-dir',
      this.deps.svnConfigDir(),
      ...(options.credential ? ['--username', options.credential.username, '--password-from-stdin'] : []),
      ...(options.trustServerCertFailures
        ? ['--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other']
        : [])
    ];
    const result = await this.runner.run(svn, fullArgs, {
      operation: options.operation,
      repositoryId: options.repositoryId,
      env: options.legacyTls ? { OPENSSL_CONF: this.deps.ensureLegacyConfig() } : undefined,
      stdin: options.credential?.password ? `${options.credential.password}\n` : undefined,
      sensitive: [options.credential?.password ?? '', ...(options.extraSensitive ?? [])]
    });
    return result.exitCode === 0 ? { ok: true, data: result.stdout, log: result.log } : this.commandFailure(result);
  }

  private canRetryWithCompatibility(result: TaskResult<unknown>): boolean {
    return ['TLS_FAILED', 'CERT_FAILED'].includes(result.error?.code ?? '');
  }

  private commandFailure<T = string>(result: CommandResult): TaskResult<T> {
    const raw = `${result.stderr}\n${result.stdout}`.trim();
    const code = classifyError(raw);
    return {
      ok: false,
      error: {
        code,
        message: friendlyMessage(code),
        raw: sanitize(raw),
        command: result.command
      },
      log: result.log
    };
  }

  private asFailure<T>(result: TaskResult<unknown>): TaskResult<T> {
    return {
      ok: false,
      error: result.error,
      log: result.log
    };
  }

  private failure<T>(code: SvnErrorCode, command: string, message = friendlyMessage(code)): TaskResult<T> {
    return { ok: false, error: { code, message, raw: message, command } };
  }

  private requireRepository(id: string): Repository {
    const repo = this.store.getRepository(id);
    if (!repo) throw new Error(`Repository not found: ${id}`);
    return repo;
  }

  private findCheckoutPathConflict(targetDir: string): Repository | null {
    const target = this.normalizeLocalPath(targetDir);
    if (!target) return null;
    return this.store.listRepositories().find((repo) => {
      const existing = this.normalizeLocalPath(repo.localPath);
      return Boolean(existing && (target === existing || target.startsWith(`${existing}/`)));
    }) ?? null;
  }

  private normalizeLocalPath(path: string): string {
    return resolve(path.trim()).replace(/\/+$/, '');
  }

  private async resolveSvn(repo: Repository): Promise<string> {
    if (repo.svnPath && existsSync(repo.svnPath)) return repo.svnPath;
    const svn = await this.deps.svnPath();
    if (!svn) throw new Error('SVN_NOT_FOUND');
    return svn;
  }

  private mapStatus(value: string): SvnStatusItem['item'] {
    const known: Record<string, SvnStatusItem['item']> = {
      normal: 'normal',
      modified: 'modified',
      added: 'added',
      deleted: 'deleted',
      unversioned: 'unversioned',
      conflicted: 'conflicted',
      missing: 'missing',
      replaced: 'replaced',
      ignored: 'ignored',
      external: 'external',
      incomplete: 'incomplete'
    };
    return known[value] ?? 'unknown';
  }
}

async function runRaw(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...(env ?? {}) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

let mainWindow: BrowserWindow | null = null;
let store: AppStore;
let dependencies: DependencyService;
let commandRunner: CommandRunner;
let svn: SvnService;

function emitTaskOutput(event: CommandOutputEvent): void {
  mainWindow?.webContents.send('tasks:output', event);
}

function emitAppMenuCommand(command: AppMenuCommand): void {
  mainWindow?.webContents.send('app-menu:command', command);
}

function createApplicationMenu(): void {
  const appMenu: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: 'RelaxSVN',
            submenu: [
              { role: 'about', label: '关于 RelaxSVN' },
              { type: 'separator' },
              {
                label: '偏好设置...',
                accelerator: 'Command+,',
                click: () => emitAppMenuCommand('open-settings')
              },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 RelaxSVN' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 RelaxSVN' }
            ]
          }
        ]
      : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: '文件',
      submenu: [
        {
          label: '添加本地副本',
          accelerator: 'Command+N',
          click: () => emitAppMenuCommand('add-working-copy')
        },
        {
          label: '检出远程仓库',
          accelerator: 'Command+Shift+N',
          click: () => emitAppMenuCommand('checkout-repository')
        },
        { type: 'separator' },
        {
          label: '打开本地目录',
          accelerator: 'Command+O',
          click: () => emitAppMenuCommand('open-local-path')
        },
        {
          label: '用 VSCode 打开',
          accelerator: 'Command+Shift+O',
          click: () => emitAppMenuCommand('open-vscode')
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '仓库',
      submenu: [
        {
          label: '刷新状态',
          accelerator: 'Command+R',
          click: () => emitAppMenuCommand('refresh-status')
        },
        {
          label: '检查远端状态',
          accelerator: 'Command+Shift+R',
          click: () => emitAppMenuCommand('refresh-remote-status')
        },
        {
          label: '更新',
          accelerator: 'Command+U',
          click: () => emitAppMenuCommand('update-working-copy')
        },
        {
          label: '清理锁定',
          accelerator: 'Command+Shift+U',
          click: () => emitAppMenuCommand('cleanup-working-copy')
        },
        { type: 'separator' },
        {
          label: '提交选中文件',
          accelerator: 'Command+Enter',
          click: () => emitAppMenuCommand('commit-selected')
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '变更',
          accelerator: 'Command+1',
          click: () => emitAppMenuCommand('show-changes')
        },
        {
          label: '冲突',
          accelerator: 'Command+2',
          click: () => emitAppMenuCommand('show-conflicts')
        },
        {
          label: '远程目录',
          accelerator: 'Command+3',
          click: () => emitAppMenuCommand('show-remote')
        },
        {
          label: 'SVN 日志',
          accelerator: 'Command+4',
          click: () => emitAppMenuCommand('show-history')
        },
        {
          label: '操作日志',
          accelerator: 'Command+5',
          click: () => emitAppMenuCommand('show-operation-logs')
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '全部置于前台' }
            ]
          : [{ role: 'close' as const, label: '关闭' }])
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开设置',
          click: () => emitAppMenuCommand('open-settings')
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: 'RelaxSVN',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 13 },
    backgroundColor: '#f6f4ef',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('dependencies:detect', () => dependencies.detect());
  ipcMain.handle('dependencies:install-svn', () => svn.installSvn());
  ipcMain.handle('dependencies:settings', () => store.settings());
  ipcMain.handle('dependencies:save-settings', (_, input: AppSettings) => store.saveSettings(input));
  ipcMain.handle('dependencies:choose-file', async () => {
    const options: OpenDialogOptions = { properties: ['openFile'] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('dependencies:choose-directory', async () => {
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('credentials:list', () => store.listCredentials());
  ipcMain.handle('credentials:save', (_, input: UpsertCredentialInput) => store.saveCredential(input));
  ipcMain.handle('credentials:remove', (_, id: string) => store.removeCredential(id));
  ipcMain.handle('repositories:list', () => store.listRepositories());
  ipcMain.handle('repositories:test-connection', (_, input: TestConnectionInput) => svn.testConnection(input));
  ipcMain.handle('repositories:add-working-copy', (_, input: AddWorkingCopyInput) => svn.addWorkingCopy(input));
  ipcMain.handle('repositories:checkout', (_, input: CheckoutInput) => svn.checkout(input));
  ipcMain.handle('repositories:update-settings', (_, input: UpsertRepositoryInput) => store.updateRepository(input));
  ipcMain.handle('repositories:remove', (_, id: string) => store.removeRepository(id));
  ipcMain.handle('repositories:status', (_, id: string, showUpdates?: boolean) => svn.status(id, showUpdates));
  ipcMain.handle('repositories:update', (_, id: string, targetPath?: string) => svn.update(id, targetPath));
  ipcMain.handle('repositories:add', (_, id: string, targetPath: string) => svn.add(id, targetPath));
  ipcMain.handle('repositories:delete', (_, id: string, targetPath: string) => svn.delete(id, targetPath));
  ipcMain.handle('repositories:revert', (_, id: string, targetPath: string, recursive?: boolean) => svn.revert(id, targetPath, recursive));
  ipcMain.handle('repositories:ignore', (_, id: string, targetPath: string) => svn.ignore(id, targetPath));
  ipcMain.handle('repositories:cleanup', (_, id: string) => svn.cleanup(id));
  ipcMain.handle('repositories:commit', (_, input: CommitInput) => svn.commit(input));
  ipcMain.handle('repositories:resolve', (_, input: ResolveInput) => svn.resolveConflict(input));
  ipcMain.handle('repositories:log', (_, id: string, limit?: number) => svn.log(id, limit));
  ipcMain.handle('repositories:open-local-path', (_, id: string) => {
    const repo = store.getRepository(id);
    if (repo) shell.openPath(repo.localPath);
  });
  ipcMain.handle('repositories:open-vscode', (_, id: string, targetPath?: string) => svn.openInVSCode(id, targetPath));
  ipcMain.handle('repositories:diff-vscode', (_, id: string, targetPath: string) => svn.diffInVSCode(id, targetPath));
  ipcMain.handle('repositories:merge-conflict-vscode', (_, id: string, targetPath: string) => svn.mergeConflictInVSCode(id, targetPath));
  ipcMain.handle('repositories:list-remote', (_, id: string, url?: string) => svn.listRemote(id, url));
  ipcMain.handle('repositories:open-remote-file-vscode', (_, id: string, url: string) => svn.openRemoteFileInVSCode(id, url));
  ipcMain.handle('repositories:remote-file-history', (_, id: string, url: string, limit?: number) => svn.remoteFileHistory(id, url, limit));
  ipcMain.handle('repositories:diff-revision-path', (_, input: RevisionDiffInput) => svn.diffRevisionPath(input));
  ipcMain.handle('logs:list', (_, repositoryId?: string) => store.listLogs(repositoryId));
  ipcMain.handle('logs:clear', (_, repositoryId?: string) => store.clearLogs(repositoryId));
  ipcMain.handle('tasks:cancel-active', () => commandRunner.cancelActive());
}

app.whenReady().then(() => {
  app.setName('RelaxSVN');
  store = new AppStore(app.getPath('userData'));
  dependencies = new DependencyService(app.getPath('userData'), store);
  commandRunner = new CommandRunner(store);
  svn = new SvnService(store, dependencies, commandRunner);
  registerIpc();
  createWindow();
  createApplicationMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
});
