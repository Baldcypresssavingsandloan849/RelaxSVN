import { defineStore } from 'pinia';
import type {
  AppSettings,
  CommandOutputEvent,
  CredentialProfile,
  DependencyCheck,
  OperationLog,
  Repository,
  SvnFileHistoryEntry,
  SvnRemoteEntry,
  SvnLogChangedPath,
  SvnLogEntry,
  SvnStatusItem,
  TaskResult,
  UpsertRepositoryInput
} from '../../../shared/types';

type Notice = {
  tone: 'info' | 'error' | 'success';
  text: string;
  placement: 'app-center' | 'bottom-right';
};

export type RemoteTreeNode = SvnRemoteEntry & {
  depth: number;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  children: RemoteTreeNode[];
};

export const useWorkbenchStore = defineStore('workbench', {
  state: () => ({
    dependencies: null as DependencyCheck | null,
    settings: null as AppSettings | null,
    repositories: [] as Repository[],
    credentials: [] as CredentialProfile[],
    selectedRepositoryId: null as string | null,
    statusItems: [] as SvnStatusItem[],
    logs: [] as OperationLog[],
    svnLogs: [] as SvnLogEntry[],
    remoteEntries: [] as SvnRemoteEntry[],
    remoteTree: [] as RemoteTreeNode[],
    remoteFileHistory: [] as SvnFileHistoryEntry[],
    remoteFileHistoryUrl: '',
    remoteFileHistoryLoading: false,
    remoteUrl: '',
    selectedRemoteUrl: '',
    selectedSvnRevision: null as string | null,
    selectedPaths: [] as string[],
    loading: false,
    notice: null as Notice | null,
    lastError: null as TaskResult['error'] | null,
    taskOutput: [] as CommandOutputEvent[],
    toastTimer: null as number | null,
    unsubscribeTaskOutput: null as null | (() => void)
  }),
  getters: {
    selectedRepository(state): Repository | null {
      return state.repositories.find((repo) => repo.id === state.selectedRepositoryId) ?? state.repositories[0] ?? null;
    },
    conflicts(state): SvnStatusItem[] {
      return state.statusItems.filter((item) => item.item === 'conflicted' || item.treeConflict);
    },
    changedItems(state): SvnStatusItem[] {
      return state.statusItems.filter((item) =>
        (item.item !== 'normal' || Boolean(item.remoteItem)) && item.item !== 'ignored' && item.item !== 'external'
      );
    },
    selectedSvnLog(state): SvnLogEntry | null {
      return state.svnLogs.find((entry) => entry.revision === state.selectedSvnRevision) ?? null;
    }
  },
  actions: {
    async bootstrap() {
      this.subscribeTaskOutput();
      this.loading = true;
      try {
        const [dependencies, settings, credentials, repositories, logs] = await Promise.allSettled([
          window.svnDesktop.dependencies.detect(),
          window.svnDesktop.dependencies.settings(),
          window.svnDesktop.credentials.list(),
          window.svnDesktop.repositories.list(),
          window.svnDesktop.logs.list()
        ]);
        if (dependencies.status === 'fulfilled') this.dependencies = dependencies.value;
        if (settings.status === 'fulfilled') this.settings = settings.value;
        if (credentials.status === 'fulfilled') this.credentials = credentials.value;
        if (repositories.status === 'fulfilled') this.repositories = repositories.value;
        if (logs.status === 'fulfilled') this.logs = logs.value;

        const failed = [
          dependencies.status === 'rejected' ? '依赖检测' : '',
          settings.status === 'rejected' ? '应用设置' : '',
          credentials.status === 'rejected' ? '账号列表' : '',
          repositories.status === 'rejected' ? '仓库列表' : '',
          logs.status === 'rejected' ? '操作日志' : ''
        ].filter(Boolean);
        if (failed.length > 0) this.toast('error', `${failed.join('、')}加载失败。`);

        this.selectedRepositoryId = this.selectedRepositoryId ?? this.repositories[0]?.id ?? null;
        if (this.selectedRepositoryId) await this.refreshStatus();
      } finally {
        this.loading = false;
      }
    },
    async refreshDependencies() {
      try {
        this.dependencies = await window.svnDesktop.dependencies.detect();
        this.toast('info', '依赖检测已刷新。', 'app-center');
      } catch (error) {
        this.toast('error', error instanceof Error ? error.message : String(error), 'app-center');
      }
    },
    async loadSettings() {
      this.settings = await window.svnDesktop.dependencies.settings();
    },
    async saveSettings(input: AppSettings) {
      this.settings = await window.svnDesktop.dependencies.saveSettings(input);
      this.toast('success', '应用设置已保存。', 'app-center');
      await this.refreshDependencies();
    },
    async installSvn() {
      await this.run(() => window.svnDesktop.dependencies.installSvn(), 'SVN 安装完成。', true, true, 'app-center');
      await this.refreshDependencies();
    },
    async saveCredential(input: { id?: string; name: string; matchUrl: string; username: string; password: string }) {
      await window.svnDesktop.credentials.save(input);
      this.credentials = await window.svnDesktop.credentials.list();
      this.toast('success', '账号已保存。');
    },
    async removeCredential(id: string) {
      await window.svnDesktop.credentials.remove(id);
      this.credentials = await window.svnDesktop.credentials.list();
      this.toast('success', '账号已删除。');
    },
    async addWorkingCopy(input: Parameters<typeof window.svnDesktop.repositories.addWorkingCopy>[0]) {
      const result = await this.run(() => window.svnDesktop.repositories.addWorkingCopy(input), '工作副本已添加。');
      if (result?.data) this.selectedRepositoryId = result.data.id;
      await this.reloadRepositories();
      await this.refreshStatus();
    },
    async checkout(input: Parameters<typeof window.svnDesktop.repositories.checkout>[0]) {
      const result = await this.run(() => window.svnDesktop.repositories.checkout(input), '检出完成。');
      if (result?.data) this.selectedRepositoryId = result.data.id;
      await this.reloadRepositories();
      await this.refreshStatus();
    },
    async removeRepository(id: string) {
      await window.svnDesktop.repositories.remove(id);
      await this.reloadRepositories();
      this.selectedRepositoryId = this.repositories[0]?.id ?? null;
      this.statusItems = [];
      this.toast('success', '仓库记录已删除。');
    },
    async updateRepositorySettings(input: UpsertRepositoryInput) {
      const repository = await window.svnDesktop.repositories.updateSettings(input);
      await this.reloadRepositories();
      this.selectedRepositoryId = repository.id;
      this.toast('success', '仓库设置已保存。');
    },
    async selectRepository(id: string) {
      this.selectedRepositoryId = id;
      this.statusItems = [];
      this.selectedPaths = [];
      this.selectedSvnRevision = null;
      this.remoteEntries = [];
      this.remoteTree = [];
      this.remoteFileHistory = [];
      this.remoteFileHistoryUrl = '';
      this.remoteUrl = '';
      this.selectedRemoteUrl = '';
      await Promise.all([this.refreshStatus(), this.refreshSvnLogs(), this.reloadLogs()]);
    },
    async refreshStatus(showUpdates = false) {
      const repo = this.selectedRepository;
      if (!repo) return;
      const result = await this.run(() => window.svnDesktop.repositories.status(repo.id, showUpdates), '状态已刷新。', false);
      if (result?.data) this.statusItems = result.data;
      await this.reloadLogs();
    },
    async updateWorkingCopy() {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.update(repo.id), '更新完成。');
      await this.refreshStatus();
    },
    async updatePath(path: string, showUpdates = false) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.update(repo.id, path), '路径更新完成。');
      await this.refreshStatus(showUpdates);
    },
    async updatePaths(paths: string[]) {
      const repo = this.selectedRepository;
      if (!repo || paths.length === 0) return;
      for (const path of paths) {
        const result = await this.run(() => window.svnDesktop.repositories.update(repo.id, path), '路径更新完成。', false);
        if (!result?.ok) return;
      }
      this.selectedPaths = [];
      await this.refreshStatus(true);
      this.toast('success', `已更新 ${paths.length} 个文件。`);
    },
    async cleanup() {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.cleanup(repo.id), '清理成功。');
      await this.refreshStatus();
    },
    async addPath(path: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.add(repo.id, path), '已加入版本控制。');
      await this.refreshStatus();
    },
    async deletePath(path: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.delete(repo.id, path), '已标记删除。');
      await this.refreshStatus();
    },
    async revertPath(path: string, recursive = false) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.revert(repo.id, path, recursive), '已还原。');
      await this.refreshStatus();
    },
    async ignorePath(path: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.ignore(repo.id, path), '已加入忽略。');
      await this.refreshStatus();
    },
    async commit(message: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.refreshStatus(true);
      const selected = new Set(this.selectedPaths);
      const selectedConflicts = this.conflicts.filter((item) => selected.has(item.path));
      if (selectedConflicts.length > 0) {
        this.toast('error', `提交前发现 ${selectedConflicts.length} 个冲突，请先处理。`);
        return;
      }
      const remoteUpdates = this.statusItems.filter((item) => selected.has(item.path) && item.remoteItem);
      if (remoteUpdates.length > 0) {
        this.toast('error', `选中文件有 ${remoteUpdates.length} 个远程更新，请先更新后再提交。`);
        return;
      }
      const result = await this.run(
        () => window.svnDesktop.repositories.commit({ repositoryId: repo.id, targets: [...this.selectedPaths], message }),
        '提交完成。'
      );
      if (!result?.ok) return;
      this.selectedPaths = [];
      await Promise.all([this.refreshStatus(), this.refreshSvnLogs()]);
    },
    async resolve(path: string, accept: 'mine-full' | 'theirs-full' | 'working') {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(
        () => window.svnDesktop.repositories.resolve({ repositoryId: repo.id, path: String(path), accept }),
        '冲突状态已更新。'
      );
      await this.refreshStatus();
    },
    async refreshSvnLogs() {
      const repo = this.selectedRepository;
      if (!repo) return;
      const result = await this.run(() => window.svnDesktop.repositories.log(repo.id, 50), '日志已刷新。', false, false);
      if (result?.data) {
        this.svnLogs = result.data;
        if (!this.selectedSvnRevision || !this.svnLogs.some((entry) => entry.revision === this.selectedSvnRevision)) {
          this.selectedSvnRevision = null;
        }
      }
    },
    selectSvnLog(revision: string) {
      this.selectedSvnRevision = this.selectedSvnRevision === revision ? null : revision;
    },
    async diffRevisionPath(revision: string, path: SvnLogChangedPath) {
      const repo = this.selectedRepository;
      if (!repo) return;
      if (path.kind === 'dir') {
        this.toast('info', '目录不能直接对比，请选择具体文件。');
        return;
      }
      await this.run(
        () =>
          window.svnDesktop.repositories.diffRevisionPath({
            repositoryId: repo.id,
            revision,
            path: path.path,
            action: path.action
          }),
        '已打开提交前后对比。',
        true,
        false
      );
    },
    async openLocalPath() {
      const repo = this.selectedRepository;
      if (repo) await window.svnDesktop.repositories.openLocalPath(repo.id);
    },
    async openVSCode(path?: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.openInVSCode(repo.id, path), '已打开 VSCode。', true, false);
    },
    async diffVSCode(path: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.diffInVSCode(repo.id, path), '已打开 VSCode 对比。', true, false);
    },
    async mergeConflictVSCode(path: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.mergeConflictInVSCode(repo.id, path), '已打开 VSCode 合并。', true, false);
    },
    async openRemoteRoot() {
      const repo = this.selectedRepository;
      if (!repo) return;
      this.remoteUrl = repo.remoteUrl;
      this.selectedRemoteUrl = repo.remoteUrl;
      const entries = await this.fetchRemoteEntries(repo.remoteUrl);
      if (!entries) return;
      this.remoteEntries = entries;
      this.remoteTree = entries.map((entry) => this.toRemoteTreeNode(entry, 0));
    },
    async openRemoteUrl(url: string) {
      const repo = this.selectedRepository;
      if (!repo || !url) return;
      const entries = await this.fetchRemoteEntries(url);
      if (!entries) return;
      this.remoteUrl = url;
      this.selectedRemoteUrl = url;
      this.remoteEntries = entries;
      this.remoteTree = entries.map((entry) => this.toRemoteTreeNode(entry, 0));
    },
    async refreshRemote() {
      if (this.remoteUrl) {
        await this.openRemoteUrl(this.remoteUrl);
        return;
      }
      await this.openRemoteRoot();
    },
    async toggleRemoteNode(node: RemoteTreeNode) {
      this.selectedRemoteUrl = node.url;
      if (node.kind !== 'dir') {
        await this.openRemoteFile(node.url);
        return;
      }
      if (node.expanded) {
        node.expanded = false;
        return;
      }
      node.expanded = true;
      if (node.loaded) return;
      node.loading = true;
      try {
        const entries = await this.fetchRemoteEntries(node.url);
        if (!entries) return;
        node.children = entries.map((entry) => this.toRemoteTreeNode(entry, node.depth + 1));
        node.loaded = true;
      } finally {
        node.loading = false;
      }
    },
    async openRemoteFile(url: string) {
      const repo = this.selectedRepository;
      if (!repo) return;
      await this.run(() => window.svnDesktop.repositories.openRemoteFileInVSCode(repo.id, url), '已打开远程文件。', true, false);
    },
    async loadRemoteFileHistory(url: string) {
      const repo = this.selectedRepository;
      if (!repo || !url) return;
      this.remoteFileHistoryUrl = url;
      this.remoteFileHistory = [];
      this.remoteFileHistoryLoading = true;
      try {
        const result = await this.run(
          () => window.svnDesktop.repositories.remoteFileHistory(repo.id, url, 30),
          '文件历史已加载。',
          false,
          false
        );
        if (result?.data) this.remoteFileHistory = result.data;
      } finally {
        this.remoteFileHistoryLoading = false;
      }
    },
    closeRemoteFileHistory() {
      this.remoteFileHistory = [];
      this.remoteFileHistoryUrl = '';
      this.remoteFileHistoryLoading = false;
    },
    async fetchRemoteEntries(url: string): Promise<SvnRemoteEntry[] | null> {
      const repo = this.selectedRepository;
      if (!repo || !url) return null;
      const result = await this.run(() => window.svnDesktop.repositories.listRemote(repo.id, url), '远程目录已刷新。', false, false);
      return result?.ok && result.data ? result.data : null;
    },
    toRemoteTreeNode(entry: SvnRemoteEntry, depth: number): RemoteTreeNode {
      return {
        ...entry,
        depth,
        expanded: false,
        loading: false,
        loaded: false,
        children: []
      };
    },
    async reloadRepositories() {
      this.repositories = await window.svnDesktop.repositories.list();
    },
    async reloadLogs() {
      this.logs = await window.svnDesktop.logs.list(this.selectedRepositoryId ?? undefined);
    },
    async clearLogs() {
      await window.svnDesktop.logs.clear(this.selectedRepositoryId ?? undefined);
      this.logs = [];
      this.toast('success', '操作日志已清除。');
    },
    togglePath(path: string) {
      this.selectedPaths = this.selectedPaths.includes(path)
        ? this.selectedPaths.filter((item) => item !== path)
        : [...this.selectedPaths, path];
    },
    selectAllChanges() {
      const remoteUpdates = this.changedItems.filter((item) => item.remoteItem);
      const targets = remoteUpdates.length > 0
        ? remoteUpdates
        : this.changedItems.filter((item) => item.item !== 'conflicted' && item.item !== 'normal');
      this.selectedPaths = targets.map((item) => item.path);
    },
    clearSelection() {
      this.selectedPaths = [];
    },
    subscribeTaskOutput() {
      if (this.unsubscribeTaskOutput) return;
      this.unsubscribeTaskOutput = window.svnDesktop.tasks.onOutput((event) => {
        this.taskOutput = [...this.taskOutput, event].slice(-80);
      });
    },
    async run<T>(
      task: () => Promise<TaskResult<T>>,
      successText: string,
      showSuccess = true,
      showLoading = true,
      placement: Notice['placement'] = 'bottom-right'
    ): Promise<TaskResult<T> | null> {
      if (showLoading) this.loading = true;
      try {
        this.lastError = null;
        this.taskOutput = [];
        const result = await task();
        if (!result.ok) {
          this.lastError = result.error ?? null;
          this.toast('error', `${result.error?.message ?? '操作失败'} ${result.error?.code ? `(${result.error.code})` : ''}`, placement);
          await this.reloadLogs();
          return result;
        }
        if (showSuccess) this.toast('success', successText, placement);
        await this.reloadLogs();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = { code: 'UNKNOWN', message, raw: message };
        this.toast('error', message, placement);
        return null;
      } finally {
        if (showLoading) this.loading = false;
      }
    },
    clearError() {
      this.lastError = null;
    },
    async cancelActiveTask() {
      const cancelled = await window.svnDesktop.tasks.cancelActive();
      this.toast(
        'info',
        cancelled > 0 ? '已请求中断当前任务，必要时请执行 cleanup。' : '当前没有正在运行的任务。'
      );
    },
    toast(tone: Notice['tone'], text: string, placement: Notice['placement'] = 'bottom-right') {
      if (this.toastTimer) window.clearTimeout(this.toastTimer);
      this.notice = { tone, text, placement };
      this.toastTimer = window.setTimeout(() => {
        if (this.notice?.text === text) this.notice = null;
        this.toastTimer = null;
      }, 1500);
    }
  }
});
