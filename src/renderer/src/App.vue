<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { VNodeChild } from 'vue';
import { ElCheckbox, ElIcon, ElInput, ElOption, ElSelect } from 'element-plus';
import { CaretBottom, CaretRight } from '@element-plus/icons-vue';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eraser,
  FileText,
  Folder,
  FolderOpen,
  GitCommitVertical,
  History,
  Info,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
  Undo2,
  Wrench,
  X
} from 'lucide-vue-next';
import { useWorkbenchStore, type RemoteTreeNode } from './stores/workbench';
import type { AppMenuCommand, CredentialProfile, OperationLog, SvnStatusItem } from '../../shared/types';
import svnLogoUrl from './assets/svn.png';

type MainTab = 'changes' | 'conflicts' | 'remote' | 'history' | 'logs';
type RepoMode = 'working-copy' | 'checkout';
type ChangeActionMode = 'commit' | 'update';
type ContextMenuItem = {
  label: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
};
type PendingPathAction = {
  kind: 'update' | 'delete' | 'revert';
  item: SvnStatusItem;
  title: string;
  description: string;
  confirmText: string;
  tone: 'primary' | 'danger';
  recursive?: boolean;
};

const store = useWorkbenchStore();
const mainTab = ref<MainTab>('changes');
const repoMode = ref<RepoMode>('working-copy');
const changeActionMode = ref<ChangeActionMode>('commit');
const remoteStatusChecking = ref(false);
const showRepoForm = ref(false);
const showCredentialList = ref(false);
const showCredentialForm = ref(false);
const showRepoSettingsForm = ref(false);
const showAppSettingsForm = ref(false);
const commitMessage = ref('');
const pendingPathAction = ref<PendingPathAction | null>(null);
const expandedOperationLogId = ref<string | null>(null);
const contextMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
const showCancelButton = ref(false);
let cancelButtonTimer: number | null = null;

const credentialForm = reactive({
  id: '',
  name: '',
  matchUrl: '',
  username: '',
  password: ''
});

const repoForm = reactive({
  name: '',
  remoteUrl: '',
  localPath: '',
  targetDir: '',
  revision: '',
  credentialId: '',
  legacyTls: false,
  trustServerCertFailures: false
});

const repoSettingsForm = reactive({
  id: '',
  name: '',
  remoteUrl: '',
  localPath: '',
  credentialId: '',
  legacyTls: false,
  trustServerCertFailures: false
});

const appSettingsForm = reactive({
  svnPath: '',
  vscodeCliPath: ''
});

const RemoteTreeNodeView: ReturnType<typeof defineComponent> = defineComponent({
  name: 'RemoteTreeNodeView',
  props: {
    node: {
      type: Object as () => RemoteTreeNode,
      required: true
    },
    selectedUrl: {
      type: String,
      default: ''
    },
    onToggle: {
      type: Function as unknown as () => (node: RemoteTreeNode) => void,
      required: true
    },
    onCopy: {
      type: Function as unknown as () => (url: string) => void,
      required: true
    },
    onOpenFile: {
      type: Function as unknown as () => (url: string) => void,
      required: true
    },
    onHistory: {
      type: Function as unknown as () => (url: string) => void,
      required: true
    },
    onContextMenu: {
      type: Function as unknown as () => (event: MouseEvent, node: RemoteTreeNode) => void,
      required: true
    }
  },
  setup(props): () => VNodeChild {
    return (): VNodeChild =>
      h('div', { class: 'remote-tree-node' }, [
        h(
          'div',
          {
            class: ['remote-tree-row', { active: props.node.url === props.selectedUrl }],
            style: { '--tree-depth': String(props.node.depth) },
            onDblclick: () => props.onToggle(props.node),
            onContextmenu: (event: MouseEvent) => props.onContextMenu(event, props.node)
          },
          [
            h('span', { class: 'remote-name' }, [
              h(
                'button',
                {
                  class: ['remote-expand', { hidden: props.node.kind !== 'dir' }],
                  title: props.node.expanded ? '收起目录' : '展开目录',
                  onClick: () => props.onToggle(props.node)
                },
                props.node.loading ? '...' : props.node.expanded ? '▾' : '▸'
              ),
              h(
                'span',
                { class: ['remote-kind', props.node.kind] },
                props.node.kind === 'dir' ? h(Folder, { size: 16 }) : h(FileText, { size: 16 })
              ),
              h('strong', { title: props.node.name }, props.node.name)
            ]),
            h('span', props.node.kind === 'dir' ? '目录' : formatBytes(props.node.size)),
            h('span', props.node.revision ? `r${props.node.revision}` : '-'),
            h('span', { title: props.node.author || '-' }, props.node.author || '-'),
            h('time', { datetime: props.node.date }, props.node.date ? formatDate(props.node.date) : '-'),
            h('span', { class: 'remote-actions' }, [
                  props.node.kind === 'dir'
                ? h(
                    'button',
                    {
                      class: 'btn-icon remote-open-action',
                      title: props.node.expanded ? '收起目录' : '打开目录',
                      onClick: () => props.onToggle(props.node)
                    },
                    [h(FolderOpen, { size: 13 }), h('span', '打开')]
                  )
                : [
                    h(
                      'button',
                      {
                        class: 'btn-icon remote-open-action',
                        title: '用 VSCode 打开',
                        onClick: () => props.onOpenFile(props.node.url)
                      },
                      [h(Code2, { size: 13 }), h('span', '打开')]
                    ),
                    h(
                      'button',
                      {
                        class: 'btn-icon remote-history-action',
                        title: '查看文件历史',
                        onClick: () => props.onHistory(props.node.url)
                      },
                      [h(History, { size: 13 }), h('span', '历史')]
                    )
                  ]
            ])
          ]
        ),
        props.node.expanded
          ? h(
              'div',
              { class: 'remote-tree-children' },
              props.node.children.map((child: RemoteTreeNode) =>
                h(RemoteTreeNodeView, {
                  key: child.url,
                  node: child,
                  selectedUrl: props.selectedUrl,
                  onToggle: props.onToggle,
                  onCopy: props.onCopy,
                  onOpenFile: props.onOpenFile,
                  onHistory: props.onHistory,
                  onContextMenu: props.onContextMenu
                })
              )
            )
          : null
      ]);
  }
});

const selectedRepository = computed(() => store.selectedRepository);
const changedItems = computed(() => store.changedItems);
const conflicts = computed(() => store.conflicts);
const selectedSvnLog = computed(() => store.selectedSvnLog);
const remoteUpdateItems = computed(() => changedItems.value.filter((item) => isRemoteUpdateItem(item)));
const localChangeItems = computed(() => changedItems.value.filter((item) => !isRemoteUpdateItem(item)));
const selectedChangeItems = computed(() => changedItems.value.filter((item) => store.selectedPaths.includes(item.path)));
const selectedRemoteUpdateItems = computed(() => selectedChangeItems.value.filter((item) => isRemoteUpdateItem(item)));
const selectedCommitItems = computed(() => selectedChangeItems.value.filter((item) => isCommittableItem(item)));
const canCommit = computed(() => selectedRepository.value && selectedCommitItems.value.length > 0 && commitMessage.value.trim().length > 0 && changeActionMode.value === 'commit');
const canUpdateSelected = computed(() => selectedRepository.value && selectedRemoteUpdateItems.value.length > 0);
const canSelectAllChanges = computed(() => (changeActionMode.value === 'update' ? remoteUpdateItems.value.length > 0 : localChangeItems.value.some(isSelectableChange)));
const dependencyHealth = computed(() => {
  if (!store.dependencies) return '检测中';
  const missing = [
    store.dependencies.svn.status === 'missing' ? 'SVN' : '',
    store.dependencies.vscode.status === 'missing' ? 'VSCode' : ''
  ].filter(Boolean);
  return missing.length ? `${missing.join('、')} 未就绪` : '环境正常';
});
watch(
  () => store.credentials[0]?.id,
  (id) => {
    if (!repoForm.credentialId && id) repoForm.credentialId = id;
  }
);

watch(
  () => [mainTab.value, selectedRepository.value?.id] as const,
  ([tab, repositoryId]) => {
    if (tab === 'remote' && repositoryId) void store.openRemoteRoot();
  }
);

watch(
  () => selectedRepository.value?.id,
  (repositoryId, previousRepositoryId) => {
    if (repositoryId && previousRepositoryId && repositoryId !== previousRepositoryId) {
      changeActionMode.value = 'commit';
      remoteStatusChecking.value = false;
    }
  }
);

watch(
  () => store.loading,
  (loading) => {
    if (cancelButtonTimer) {
      window.clearTimeout(cancelButtonTimer);
      cancelButtonTimer = null;
    }
    showCancelButton.value = false;
    if (!loading) return;
    cancelButtonTimer = window.setTimeout(() => {
      showCancelButton.value = store.loading;
      cancelButtonTimer = null;
    }, 3000);
  }
);

let unsubscribeAppMenu: (() => void) | null = null;

onMounted(() => {
  void store.bootstrap();
  unsubscribeAppMenu = window.svnDesktop.appMenu.onCommand((command) => {
    void handleAppMenuCommand(command);
  });
});

onUnmounted(() => {
  if (cancelButtonTimer) {
    window.clearTimeout(cancelButtonTimer);
    cancelButtonTimer = null;
  }
  unsubscribeAppMenu?.();
  unsubscribeAppMenu = null;
});

async function handleAppMenuCommand(command: AppMenuCommand): Promise<void> {
  if (command === 'open-settings') {
    await resetAppSettingsForm();
    return;
  }
  if (command === 'add-working-copy') {
    resetRepoForm('working-copy');
    return;
  }
  if (command === 'checkout-repository') {
    resetRepoForm('checkout');
    return;
  }
  if (command === 'open-local-path') {
    await store.openLocalPath();
    return;
  }
  if (command === 'open-vscode') {
    await store.openVSCode();
    return;
  }
  if (command === 'refresh-status') {
    mainTab.value = 'changes';
    await refreshCurrentStatus(false);
    return;
  }
  if (command === 'refresh-remote-status') {
    mainTab.value = 'changes';
    await refreshCurrentStatus(true);
    return;
  }
  if (command === 'update-working-copy') {
    await store.updateWorkingCopy();
    return;
  }
  if (command === 'cleanup-working-copy') {
    await store.cleanup();
    return;
  }
  if (command === 'commit-selected') {
    mainTab.value = 'changes';
    if (!canCommit.value) {
      store.toast('info', '请选择文件并填写提交信息。');
      return;
    }
    await commitSelected();
    return;
  }
  if (command === 'show-changes') {
    mainTab.value = 'changes';
    return;
  }
  if (command === 'show-conflicts') {
    mainTab.value = 'conflicts';
    return;
  }
  if (command === 'show-remote') {
    await showRemoteTab();
    return;
  }
  if (command === 'show-history') {
    mainTab.value = 'history';
    await store.refreshSvnLogs();
    return;
  }
  if (command === 'show-operation-logs') {
    mainTab.value = 'logs';
    await store.reloadLogs();
  }
}

function statusLabel(status: SvnStatusItem['item']): string {
  const labels: Record<SvnStatusItem['item'], string> = {
    normal: '正常',
    modified: '本地修改',
    added: '新增',
    deleted: '删除',
    unversioned: '未纳管',
    conflicted: '冲突',
    missing: '缺失',
    replaced: '替换',
    ignored: '忽略',
    external: '外部',
    incomplete: '不完整',
    unknown: '未知'
  };
  return labels[status];
}

function itemStatusLabel(item: SvnStatusItem): string {
  if (item.remoteItem) return '远端更新';
  return statusLabel(item.item);
}

function statusClass(status: SvnStatusItem['item']): string {
  if (status === 'conflicted' || status === 'missing' || status === 'incomplete') return 'danger';
  if (status === 'unversioned' || status === 'added') return 'new';
  if (status === 'deleted' || status === 'replaced') return 'warn';
  return 'changed';
}

function itemStatusClass(item: SvnStatusItem): string {
  if (item.remoteItem) return 'remote';
  return statusClass(item.item);
}

function isRemoteUpdateItem(item: SvnStatusItem): boolean {
  return Boolean(item.remoteItem);
}

function isCommittableItem(item: SvnStatusItem): boolean {
  return !isRemoteUpdateItem(item) && item.item !== 'normal' && item.item !== 'conflicted';
}

function isSelectableChange(item: SvnStatusItem): boolean {
  return isRemoteUpdateItem(item) || isCommittableItem(item);
}

function logPathActionLabel(action: string): string {
  const labels: Record<string, string> = {
    A: '新增',
    D: '删除',
    M: '修改',
    R: '替换'
  };
  return labels[action] ?? (action || '-');
}

function logPathActionClass(action: string): string {
  if (action === 'A') return 'new';
  if (action === 'D') return 'danger';
  if (action === 'M') return 'changed';
  return 'warn';
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    status: '刷新状态',
    update: '更新工作副本',
    add: '加入版本控制',
    delete: '标记删除',
    revert: '还原改动',
    cleanup: '清理锁定',
    commit: '提交',
    resolve: '解决冲突',
    log: '读取 SVN 日志',
    'open-vscode': '打开 VSCode',
    'diff-vscode': '打开文件对比',
    'diff-revision-vscode': '打开提交对比',
    checkout: '检出仓库',
    'checkout-legacy': '检出仓库',
    'test-connection': '测试连接',
    'install-svn': '安装 SVN'
  };
  return labels[operation] ?? operation;
}

function logResultText(log: OperationLog): string {
  if (log.exitCode === null) return '未完成';
  return log.exitCode === 0 ? '成功' : '失败';
}

function logResultClass(log: OperationLog): string {
  if (log.exitCode === null) return 'warn';
  return log.exitCode === 0 ? 'new' : 'danger';
}

function logSummary(log: OperationLog): string {
  const text = latestLogText(log).replace(/\s+/g, ' ').trim();
  if (!text || text === '无输出') return log.exitCode === 0 ? '操作已完成。' : '没有可读输出。';
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function toggleOperationLog(id: string): void {
  expandedOperationLogId.value = expandedOperationLogId.value === id ? null : id;
}

async function clearOperationLogs(): Promise<void> {
  const scope = selectedRepository.value ? `当前仓库“${selectedRepository.value.name}”` : '全部';
  if (!window.confirm(`清除${scope}的操作日志？这个操作不会影响 SVN 提交记录。`)) return;
  expandedOperationLogId.value = null;
  await store.clearLogs();
}

function depClass(status?: 'found' | 'missing'): string {
  if (!store.dependencies) return 'pending';
  return status === 'found' ? 'success' : 'danger';
}

function depText(status?: 'found' | 'missing', foundText = '已安装'): string {
  if (!store.dependencies) return '检测中';
  return status === 'found' ? foundText : '缺失';
}

function formatDate(value?: string | null): string {
  if (!value) return '无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function directoryName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function isPathSelected(path: string): boolean {
  return store.selectedPaths.includes(path);
}

function remoteBreadcrumbs(): Array<{ label: string; url: string }> {
  const repo = selectedRepository.value;
  const currentUrl = store.remoteUrl || repo?.remoteUrl || '';
  if (!repo || !currentUrl) return [];
  const rootUrl = repo.remoteUrl.replace(/\/+$/, '');
  if (!currentUrl.startsWith(rootUrl)) return [{ label: currentUrl, url: currentUrl }];
  const relative = currentUrl.slice(rootUrl.length).replace(/^\/+|\/+$/g, '');
  const parts = relative ? relative.split('/') : [];
  return [
    { label: repo.name || '远程根目录', url: rootUrl },
    ...parts.map((part, index) => ({
      label: decodeURIComponent(part),
      url: `${rootUrl}/${parts.slice(0, index + 1).join('/')}`
    }))
  ];
}

function formatBytes(value?: number): string {
  if (value == null || Number.isNaN(value)) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function truncateMiddle(value: string, max = 34): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.58);
  const tail = Math.floor((max - 1) * 0.42);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function credentialSelectLabel(credential: CredentialProfile): string {
  const name = truncateMiddle(credential.name, 18);
  const username = truncateMiddle(credential.username, 22);
  return `${name} / ${username}`;
}

function resetCredentialForm(credential?: CredentialProfile): void {
  showCredentialList.value = false;
  credentialForm.id = credential?.id ?? '';
  credentialForm.name = credential?.name ?? '';
  credentialForm.matchUrl = credential?.matchUrl ?? '';
  credentialForm.username = credential?.username ?? '';
  credentialForm.password = '';
  showCredentialForm.value = true;
}

function openCredentialList(): void {
  showCredentialList.value = true;
}

async function removeCredentialFromList(credential: CredentialProfile): Promise<void> {
  if (!window.confirm(`删除账号“${credential.name}”？已绑定仓库需要重新选择账号。`)) return;
  await store.removeCredential(credential.id);
}

async function saveCredential(): Promise<void> {
  await store.saveCredential({
    id: credentialForm.id || undefined,
    name: credentialForm.name,
    matchUrl: credentialForm.matchUrl,
    username: credentialForm.username,
    password: credentialForm.password
  });
  if (!repoForm.credentialId && store.credentials[0]) repoForm.credentialId = store.credentials[0].id;
  showCredentialForm.value = false;
  showCredentialList.value = true;
}

async function removeCredentialFromForm(): Promise<void> {
  if (!credentialForm.id) return;
  if (!window.confirm(`删除账号“${credentialForm.name}”？已绑定仓库需要重新选择账号。`)) return;
  await store.removeCredential(credentialForm.id);
  showCredentialForm.value = false;
  showCredentialList.value = true;
}

function resetRepoForm(mode: RepoMode): void {
  repoMode.value = mode;
  repoForm.name = '';
  repoForm.remoteUrl = '';
  repoForm.localPath = '';
  repoForm.targetDir = '';
  repoForm.revision = '';
  repoForm.credentialId = store.credentials[0]?.id ?? '';
  repoForm.legacyTls = false;
  repoForm.trustServerCertFailures = false;
  showRepoForm.value = true;
}

function resetRepoSettingsForm(): void {
  const repo = selectedRepository.value;
  if (!repo) return;
  repoSettingsForm.id = repo.id;
  repoSettingsForm.name = repo.name;
  repoSettingsForm.remoteUrl = repo.remoteUrl;
  repoSettingsForm.localPath = repo.localPath;
  repoSettingsForm.credentialId = repo.credentialId ?? '';
  repoSettingsForm.legacyTls = repo.legacyTls;
  repoSettingsForm.trustServerCertFailures = repo.trustServerCertFailures;
  showRepoSettingsForm.value = true;
}

async function resetAppSettingsForm(): Promise<void> {
  await store.loadSettings();
  appSettingsForm.svnPath = store.settings?.svnPath ?? '';
  appSettingsForm.vscodeCliPath = store.settings?.vscodeCliPath ?? '';
  showAppSettingsForm.value = true;
}

async function showRemoteTab(): Promise<void> {
  mainTab.value = 'remote';
}

async function copyRemoteUrl(url = store.remoteUrl): Promise<void> {
  if (!url) return;
  await navigator.clipboard.writeText(url);
  store.toast('success', '远程 URL 已复制。');
}

function checkoutRemoteUrl(url = store.remoteUrl): void {
  const repo = selectedRepository.value;
  if (!repo || !url) return;
  resetRepoForm('checkout');
  repoForm.remoteUrl = url;
  repoForm.credentialId = repo.credentialId ?? repoForm.credentialId;
  repoForm.legacyTls = repo.legacyTls;
  repoForm.trustServerCertFailures = repo.trustServerCertFailures;
  const name = decodeURIComponent(url.replace(/\/+$/, '').split('/').pop() || repo.name);
  repoForm.name = name;
}

function checkoutRevision(revision: string): void {
  const repo = selectedRepository.value;
  if (!repo) return;
  resetRepoForm('checkout');
  repoForm.name = `${repo.name}-r${revision}`;
  repoForm.remoteUrl = repo.remoteUrl;
  repoForm.revision = revision;
  repoForm.credentialId = repo.credentialId ?? repoForm.credentialId;
  repoForm.legacyTls = repo.legacyTls;
  repoForm.trustServerCertFailures = repo.trustServerCertFailures;
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

function openContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  const enabledItems = items.filter((item) => !item.disabled);
  if (enabledItems.length === 0) return;
  event.preventDefault();
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    items: enabledItems
  };
}

async function runContextMenuItem(item: ContextMenuItem): Promise<void> {
  closeContextMenu();
  await item.action();
}

function openChangeContextMenu(event: MouseEvent, item: SvnStatusItem): void {
  openContextMenu(event, [
    { label: '更新', action: () => confirmUpdatePath(item) },
    { label: '对比', action: () => store.diffVSCode(item.path), disabled: isRemoteUpdateItem(item) || item.item === 'unversioned' },
    { label: '加入版本控制', action: () => store.addPath(item.path), disabled: isRemoteUpdateItem(item) || item.item !== 'unversioned' },
    { label: '忽略', action: () => store.ignorePath(item.path), disabled: isRemoteUpdateItem(item) || item.item !== 'unversioned' },
    { label: '放弃改动', action: () => confirmRevert(item), disabled: isRemoteUpdateItem(item) || item.item === 'unversioned' },
    { label: '删除', action: () => confirmDeletePath(item), disabled: isRemoteUpdateItem(item) }
  ]);
}

function openRemoteContextMenu(event: MouseEvent, node: RemoteTreeNode): void {
  openContextMenu(event, [
    { label: node.kind === 'dir' ? '打开目录' : '打开文件', action: () => store.toggleRemoteNode(node) },
    { label: '查看历史', action: () => store.loadRemoteFileHistory(node.url), disabled: node.kind !== 'file' },
    { label: '复制 URL', action: () => copyRemoteUrl(node.url) },
    { label: '检出为新副本', action: () => checkoutRemoteUrl(node.url), disabled: node.kind !== 'dir' }
  ]);
}

function openConflictContextMenu(event: MouseEvent, item: SvnStatusItem): void {
  openContextMenu(event, [
    { label: 'VSCode 合并', action: () => store.mergeConflictVSCode(item.path) },
    { label: '对比', action: () => store.diffVSCode(item.path) },
    { label: '选择本地版本', action: () => store.resolve(item.path, 'mine-full') },
    { label: '选择远程版本', action: () => store.resolve(item.path, 'theirs-full') },
    { label: '标记手工完成', action: () => store.resolve(item.path, 'working') }
  ]);
}

async function refreshCurrentStatus(showUpdates = false): Promise<void> {
  store.clearSelection();
  if (!showUpdates) {
    remoteStatusChecking.value = false;
    changeActionMode.value = 'commit';
    await store.refreshStatus(false);
    if (store.notice?.tone === 'error') return;
    store.toast('success', '刷新成功。');
    return;
  }
  remoteStatusChecking.value = true;
  try {
    await store.refreshStatus(true);
    if (store.notice?.tone === 'error') return;
    changeActionMode.value = 'update';
    const remoteChangedCount = store.statusItems.filter((item) => item.remoteItem).length;
    store.toast('success', remoteChangedCount ? `远端有 ${remoteChangedCount} 个更新。` : '远端暂无更新。');
  } finally {
    remoteStatusChecking.value = false;
  }
}

async function testConnection(): Promise<void> {
  const result = await window.svnDesktop.repositories.testConnection({
    remoteUrl: repoForm.remoteUrl,
    credentialId: repoForm.credentialId,
    legacyTls: repoForm.legacyTls,
    trustServerCertFailures: repoForm.trustServerCertFailures
  });
  if (result.ok) {
    store.toast('success', '连接测试通过。');
  } else {
    store.toast('error', `${result.error?.message ?? '连接失败'} ${result.error?.code ? `(${result.error.code})` : ''}`);
    await store.reloadLogs();
  }
}

async function saveRepository(): Promise<void> {
  if (repoMode.value === 'working-copy') {
    await store.addWorkingCopy({
      name: repoForm.name,
      localPath: repoForm.localPath,
      remoteUrl: repoForm.remoteUrl || undefined,
      credentialId: repoForm.credentialId || null,
      legacyTls: repoForm.legacyTls,
      trustServerCertFailures: repoForm.trustServerCertFailures
    });
  } else {
    const conflict = findCheckoutPathConflict(repoForm.targetDir);
    if (conflict) {
      store.toast('error', `目标目录不能和已有工作副本“${conflict.name}”相同，也不能放在它的目录里面。`);
      return;
    }
    await store.checkout({
      name: repoForm.name,
      remoteUrl: repoForm.remoteUrl,
      targetDir: repoForm.targetDir,
      credentialId: repoForm.credentialId,
      revision: repoForm.revision || undefined,
      legacyTls: repoForm.legacyTls,
      trustServerCertFailures: repoForm.trustServerCertFailures
    });
  }
  showRepoForm.value = false;
}

function findCheckoutPathConflict(targetDir: string): { name: string } | null {
  const target = normalizeLocalPath(targetDir);
  if (!target) return null;
  return store.repositories.find((repo) => {
    const existing = normalizeLocalPath(repo.localPath);
    return Boolean(existing && (target === existing || target.startsWith(`${existing}/`)));
  }) ?? null;
}

function normalizeLocalPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/\/+/g, '/');
}

async function saveRepoSettings(): Promise<void> {
  await store.updateRepositorySettings({
    id: repoSettingsForm.id,
    name: repoSettingsForm.name,
    remoteUrl: repoSettingsForm.remoteUrl,
    localPath: repoSettingsForm.localPath,
    svnPath: null,
    credentialId: repoSettingsForm.credentialId || null,
    legacyTls: repoSettingsForm.legacyTls,
    trustServerCertFailures: repoSettingsForm.trustServerCertFailures
  });
  showRepoSettingsForm.value = false;
}

async function saveAppSettings(): Promise<void> {
  await store.saveSettings({
    svnPath: appSettingsForm.svnPath || null,
    vscodeCliPath: appSettingsForm.vscodeCliPath || null
  });
  showAppSettingsForm.value = false;
}

function resetAppSettingsToDefault(): void {
  if (!window.confirm('恢复默认路径设置？\n\n这会清除手动填写的 SVN 路径和 VSCode CLI 路径，保存后将重新使用自动检测结果。')) return;
  appSettingsForm.svnPath = '';
  appSettingsForm.vscodeCliPath = '';
}

async function chooseDirectory(target: 'localPath' | 'targetDir' | 'repoLocalPath'): Promise<void> {
  const path = await window.svnDesktop.dependencies.chooseDirectory();
  if (!path) return;
  if (target === 'localPath') repoForm.localPath = path;
  if (target === 'targetDir') repoForm.targetDir = path;
  if (target === 'repoLocalPath') repoSettingsForm.localPath = path;
}

async function chooseFile(target: 'appSvnPath' | 'appVscodePath'): Promise<void> {
  const path = await window.svnDesktop.dependencies.chooseFile();
  if (!path) return;
  if (target === 'appSvnPath') appSettingsForm.svnPath = path;
  if (target === 'appVscodePath') appSettingsForm.vscodeCliPath = path;
}

async function removeSelectedRepository(): Promise<void> {
  const repo = selectedRepository.value;
  if (!repo) return;
  if (!window.confirm(`移除项目“${repo.name}”？\n\n本地文件不会被删除。如果要删除本地文件，请手工删除。`)) return;
  await store.removeRepository(repo.id);
  showRepoSettingsForm.value = false;
}

function pathActionName(item: SvnStatusItem): string {
  return item.relativePath || item.path;
}

function confirmUpdatePath(item: SvnStatusItem): void {
  pendingPathAction.value = {
    kind: 'update',
    item,
    title: '更新这个路径',
    description: '从 SVN 拉取这个文件或目录的最新版本。本地修改会尝试自动合并；如果无法合并，会进入冲突状态。',
    confirmText: '更新',
    tone: 'primary'
  };
}

function confirmDeletePath(item: SvnStatusItem): void {
  pendingPathAction.value = {
    kind: 'delete',
    item,
    title: '删除这个路径',
    description: '这会从本地工作副本删除文件或目录，并标记为待提交的删除。提交后服务器上的对应路径也会删除。',
    confirmText: '删除',
    tone: 'danger'
  };
}

function confirmRevert(item: SvnStatusItem): void {
  pendingPathAction.value = {
    kind: 'revert',
    item,
    title: '还原本地改动',
    description: '这会放弃这个路径上的本地修改，恢复到工作副本中的 SVN 版本。未提交的改动通常无法从 App 内恢复。',
    confirmText: '还原',
    tone: 'danger',
    recursive: false
  };
}

async function runPendingPathAction(): Promise<void> {
  const action = pendingPathAction.value;
  if (!action) return;
  pendingPathAction.value = null;
  if (action.kind === 'update') await store.updatePath(action.item.path, changeActionMode.value === 'update');
  if (action.kind === 'delete') await store.deletePath(action.item.path);
  if (action.kind === 'revert') await store.revertPath(action.item.path, Boolean(action.recursive));
}

async function commitSelected(): Promise<void> {
  await store.commit(commitMessage.value);
  if (!store.notice || store.notice.tone !== 'error') commitMessage.value = '';
}

async function updateSelectedRemoteItems(): Promise<void> {
  const targets = [...selectedRemoteUpdateItems.value];
  await store.updatePaths(targets.map((item) => item.path));
}

function selectAllVisibleChanges(): void {
  const targets = changeActionMode.value === 'update'
    ? remoteUpdateItems.value
    : localChangeItems.value.filter(isSelectableChange);
  store.selectedPaths = targets.map((item) => item.path);
}

function latestLogText(log: OperationLog): string {
  return log.stderr || log.stdout || '无输出';
}
</script>

<template>
  <div class="app-frame">
    <header class="window-titlebar">
      <div class="titlebar-brand">
        <img :src="svnLogoUrl" alt="" />
        <strong>RelaxSVN</strong>
      </div>
      <button class="btn-icon titlebar-settings" title="环境与应用设置" @click="resetAppSettingsForm">
        <Settings :size="20" />
      </button>
    </header>
    <main class="app-shell" @click="closeContextMenu">
      <aside class="app-sidebar">
        <header class="sidebar-header">
          <div class="sidebar-brand">
            <img :src="svnLogoUrl" alt="" />
            <div>
              <p class="label">Apple Silicon</p>
              <h1>RelaxSVN</h1>
            </div>
          </div>
        </header>

        <section class="sidebar-section repo-section">
          <div class="section-title repo-actions-title">
            <div class="icon-group">
              <button class="repo-action repo-action-copy" title="添加本地副本" @click="resetRepoForm('working-copy')">
                <Plus :size="16" />
                <span>添加本地副本</span>
              </button>
              <button class="repo-action repo-action-checkout" title="检出远程仓库" @click="resetRepoForm('checkout')">
                <Download :size="16" />
                <span>检出远程仓库</span>
              </button>
            </div>
          </div>
          <div class="nav-list">
            <button
              v-for="repo in store.repositories"
              :key="repo.id"
              :class="['repo-item', { active: repo.id === store.selectedRepositoryId }]"
              @click="store.selectRepository(repo.id)"
            >
              <span class="repo-icon"><Folder :size="16" /></span>
              <span class="repo-copy">
                <strong>{{ repo.name }}</strong>
                <small>{{ directoryName(repo.localPath) }}</small>
              </span>
              <ChevronRight :size="16" />
            </button>
            <div v-if="store.repositories.length === 0" class="empty-state compact">
              <Folder :size="20" />
              <strong>还没有仓库</strong>
              <span>添加已有工作副本，或从远程检出。</span>
            </div>
          </div>
        </section>

        <section class="sidebar-section account-section">
          <button class="account-entry" @click="openCredentialList">
            <span class="account-entry-icon"><KeyRound :size="16" /></span>
            <span>
              <strong>账号</strong>
              <small>{{ store.credentials.length }} 个账号配置</small>
            </span>
            <ChevronRight :size="16" />
          </button>
        </section>

      </aside>

      <section class="workspace">
      <header class="workspace-header">
        <div class="title-stack workspace-title">
          <p v-if="!selectedRepository" class="label">{{ dependencyHealth }}</p>
          <div class="workspace-title-row">
            <h2>{{ selectedRepository?.name || '工作台' }}</h2>
            <button
              v-if="selectedRepository"
              class="title-settings-button"
              title="项目设置"
              @click="resetRepoSettingsForm"
            >
              <Wrench :size="15" />
              项目设置
            </button>
          </div>
        </div>
        <div class="toolbar">
          <button class="btn-secondary toolbar-refresh" :disabled="!selectedRepository || store.loading" @click="refreshCurrentStatus(false)">
            <RefreshCw :size="16" />
            刷新本地状态
          </button>
          <button
            class="btn-secondary toolbar-remote"
            title="检查远程更新，不修改本地文件"
            :disabled="!selectedRepository || store.loading"
            @click="refreshCurrentStatus(true)"
          >
            <ShieldCheck :size="16" />
            检查远程更新
          </button>
          <button class="btn-secondary toolbar-update" :disabled="!selectedRepository || store.loading" @click="store.updateWorkingCopy">
            <Download :size="16" />
            更新
          </button>
          <button class="btn-secondary toolbar-cleanup" title="清理 SVN 工作副本锁定和未完成操作" :disabled="!selectedRepository || store.loading" @click="store.cleanup">
            <Eraser :size="16" />
            清理锁定
          </button>
          <button class="btn-secondary toolbar-folder" :disabled="!selectedRepository" @click="store.openLocalPath()">
            <FolderOpen :size="16" />
            打开目录
          </button>
          <button class="btn-secondary toolbar-code" :disabled="!selectedRepository" @click="store.openVSCode()">
            <Code2 :size="16" />
            VSCode打开
          </button>
        </div>
        <button v-if="showCancelButton" class="btn-secondary toolbar-cancel" @click="store.cancelActiveTask">
          <X :size="16" />
          取消操作
        </button>
      </header>

      <section v-if="!selectedRepository" class="surface welcome-surface">
        <Folder :size="28" />
        <h3>连接一个 SVN 工作副本开始</h3>
        <p>添加已有目录或从远程仓库检出。连接、账号和旧 TLS 配置都通过弹窗完成，主工作台保持固定。</p>
        <div class="inline-actions">
          <button class="btn-primary" @click="resetRepoForm('working-copy')">
            <Plus :size="16" />
            添加工作副本
          </button>
          <button class="btn-secondary" @click="resetRepoForm('checkout')">
            <Download :size="16" />
            检出仓库
          </button>
        </div>
      </section>

      <template v-else>
      <nav class="tabs" aria-label="工作区视图">
        <button :class="{ active: mainTab === 'changes' }" @click="mainTab = 'changes'">
          <GitCommitVertical :size="16" />
          变更
          <span>{{ changedItems.length }}</span>
        </button>
        <button :class="{ active: mainTab === 'conflicts' }" @click="mainTab = 'conflicts'">
          <AlertTriangle :size="16" />
          冲突
          <span>{{ conflicts.length }}</span>
        </button>
        <button :class="{ active: mainTab === 'remote' }" @click="showRemoteTab">
          <FolderOpen :size="16" />
          远程目录
        </button>
        <button :class="{ active: mainTab === 'history' }" @click="mainTab = 'history'; store.refreshSvnLogs()">
          <History :size="16" />
          提交记录
        </button>
        <button :class="{ active: mainTab === 'logs' }" @click="mainTab = 'logs'; store.reloadLogs()">
          <CalendarDays :size="16" />
          操作日志
        </button>
      </nav>

      <section v-if="mainTab === 'changes'" class="change-tab">
        <div class="surface work-panel change-surface">
          <div class="surface-header change-header">
            <div>
              <h3>变更列表</h3>
              <p>{{ changedItems.length ? (changeActionMode === 'update' ? '选择要更新到本地的文件' : '选择要提交的文件，冲突文件需先处理') : '当前工作副本是干净的' }}</p>
            </div>
            <div class="inline-actions">
              <button class="btn-secondary selection-action select-all" :disabled="!canSelectAllChanges" @click="selectAllVisibleChanges">
                <Check :size="15" />
                全选
              </button>
              <button class="btn-secondary selection-action clear-selection" :disabled="store.selectedPaths.length === 0" @click="store.clearSelection">
                <X :size="15" />
                不选
              </button>
            </div>
          </div>

          <div v-if="changeActionMode === 'update'" class="change-table">
            <div
              v-for="item in remoteUpdateItems"
              :key="item.path"
              class="change-row"
              @contextmenu.prevent="openChangeContextMenu($event, item)"
            >
              <label class="check-cell" title="选择要更新的文件">
                <ElCheckbox
                  :model-value="isPathSelected(item.path)"
                  @change="store.togglePath(item.path)"
                />
              </label>
              <span class="status-pill remote">远端更新</span>
              <div class="file-copy">
                <strong>{{ item.relativePath || item.path }}</strong>
                <small>{{ item.remoteRevision ? `${item.path} · 远端 r${item.remoteRevision}` : item.path }}</small>
              </div>
              <div class="row-actions">
                <button class="btn-icon action-update" aria-label="更新" @click="confirmUpdatePath(item)">
                  <Download :size="13" />
                  <span>更新</span>
                </button>
              </div>
            </div>
            <div v-if="remoteStatusChecking" class="empty-state">
              <RefreshCw :size="38" />
              <strong>正在检查远程更新</strong>
              <span>正在向 SVN 服务器读取远程状态。</span>
            </div>
            <div v-else-if="remoteUpdateItems.length === 0" class="empty-state">
              <ShieldCheck :size="38" />
              <strong>没有远程更新</strong>
              <span>远程状态已刷新，当前没有需要更新到本地的文件。</span>
            </div>
          </div>

          <div v-else class="change-table">
            <div
              v-for="item in localChangeItems"
              :key="item.path"
              class="change-row"
              @contextmenu.prevent="openChangeContextMenu($event, item)"
            >
              <label class="check-cell" :title="isSelectableChange(item) ? '选择文件' : '此项不能提交'">
                <ElCheckbox
                  :model-value="isPathSelected(item.path)"
                  :disabled="!isSelectableChange(item)"
                  @change="store.togglePath(item.path)"
                />
              </label>
              <span :class="['status-pill', itemStatusClass(item)]">{{ itemStatusLabel(item) }}</span>
              <div class="file-copy">
                <strong>{{ item.relativePath || item.path }}</strong>
                <small>{{ item.path }}</small>
              </div>
              <div class="row-actions">
                <button v-if="item.item === 'unversioned'" class="btn-icon action-add" aria-label="加入版本控制" @click="store.addPath(item.path)">
                  <Check :size="13" />
                  <span>加入</span>
                </button>
                <button v-if="item.item === 'unversioned'" class="btn-icon action-ignore" aria-label="忽略" @click="store.ignorePath(item.path)">
                  <Eraser :size="13" />
                  <span>忽略</span>
                </button>
                <button class="btn-icon action-update" aria-label="更新" @click="confirmUpdatePath(item)">
                  <Download :size="13" />
                  <span>更新</span>
                </button>
                <button class="btn-icon action-diff" aria-label="对比" @click="store.diffVSCode(item.path)">
                  <Code2 :size="13" />
                  <span>对比</span>
                </button>
                <button class="btn-icon action-revert" aria-label="放弃" @click="confirmRevert(item)">
                  <Undo2 :size="13" />
                  <span>放弃</span>
                </button>
                <button class="btn-icon action-delete" aria-label="删除" @click="confirmDeletePath(item)">
                  <X :size="13" />
                  <span>删除</span>
                </button>
              </div>
            </div>
            <div v-if="changedItems.length === 0" class="empty-state">
              <ShieldCheck :size="38" />
              <strong>没有本地变更</strong>
              <span>刷新状态或检查远端更新后再继续。</span>
            </div>
          </div>
        </div>

        <aside v-if="changeActionMode === 'update'" class="remote-update-surface">
          <div>
            <strong>远程更新</strong>
            <span>选中的文件只需要更新到本地，不需要填写提交信息。</span>
          </div>
          <button class="btn-primary" :disabled="store.loading || !canUpdateSelected" @click="updateSelectedRemoteItems">
            <Download :size="17" />
            更新 {{ selectedRemoteUpdateItems.length }} 个文件
          </button>
        </aside>

        <aside v-else class="commit-surface">
          <ElInput v-model="commitMessage" placeholder="写下这次提交的变更内容" />
          <div class="commit-actions">
            <button class="btn-primary" :disabled="store.loading || !canCommit" @click="commitSelected">
              <GitCommitVertical :size="17" />
              提交 {{ selectedCommitItems.length }} 个文件
            </button>
          </div>
        </aside>
      </section>

      <section v-if="mainTab === 'conflicts'" class="change-tab conflict-tab">
        <div class="surface work-panel conflict-surface">
          <div class="surface-header conflict-header">
            <div>
              <h3>冲突处理</h3>
              <p>优先用 VSCode 对比，再选择本地、远程或手工处理完成</p>
            </div>
          </div>
          <div class="conflict-table">
            <article
              v-for="item in conflicts"
              :key="item.path"
              class="conflict-row"
              @contextmenu.prevent="openConflictContextMenu($event, item)"
            >
              <div>
                <span class="status-pill danger">{{ statusLabel(item.item) }}</span>
                <strong>{{ item.relativePath || item.path }}</strong>
                <small>{{ item.treeConflict || item.path }}</small>
              </div>
              <div class="inline-actions">
                <button class="btn-secondary" @click="store.resolve(item.path, 'mine-full')">本地版本</button>
                <button class="btn-secondary" @click="store.resolve(item.path, 'theirs-full')">远程版本</button>
                <button class="btn-secondary" @click="store.resolve(item.path, 'working')">手工完成</button>
                <button class="btn-secondary" @click="store.mergeConflictVSCode(item.path)">
                  <Code2 :size="15" />
                  VSCode 合并
                </button>
                <button class="btn-ghost" @click="store.diffVSCode(item.path)">
                  <Code2 :size="15" />
                  对比
                </button>
              </div>
            </article>
            <div v-if="conflicts.length === 0" class="empty-state">
              <ShieldCheck :size="38" />
              <strong>没有冲突</strong>
              <span>更新或提交前会继续检测冲突状态。</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="mainTab === 'remote'" class="surface remote-surface">
        <div class="surface-header remote-header">
          <div>
            <h3>远程目录</h3>
            <p>{{ store.remoteUrl || selectedRepository.remoteUrl }}</p>
          </div>
          <div class="inline-actions">
            <button class="btn-secondary" :disabled="store.loading" @click="store.refreshRemote">
              <RefreshCw :size="15" />
              刷新
            </button>
            <button class="btn-secondary" :disabled="!store.remoteUrl" @click="copyRemoteUrl()">
              <Copy :size="15" />
              复制 URL
            </button>
            <button class="btn-primary" :disabled="!store.remoteUrl" @click="checkoutRemoteUrl()">
              <Download :size="15" />
              检出为新副本
            </button>
          </div>
        </div>

        <nav class="remote-breadcrumbs" aria-label="远程路径">
          <button
            v-for="crumb in remoteBreadcrumbs()"
            :key="crumb.url"
            :class="{ active: crumb.url === store.remoteUrl }"
            @click="store.openRemoteUrl(crumb.url)"
          >
            {{ crumb.label }}
          </button>
        </nav>

        <div class="remote-tree">
          <header class="remote-tree-head">
            <span>名称</span>
            <span>类型/大小</span>
            <span>版本</span>
            <span>作者</span>
            <span>时间</span>
            <span>操作</span>
          </header>
          <RemoteTreeNodeView
            v-for="node in store.remoteTree"
            :key="node.url"
            :node="node"
            :selected-url="store.selectedRemoteUrl"
            :on-toggle="store.toggleRemoteNode"
            :on-copy="copyRemoteUrl"
            :on-open-file="store.openRemoteFile"
            :on-history="store.loadRemoteFileHistory"
            :on-context-menu="openRemoteContextMenu"
          />
          <div v-if="store.remoteTree.length === 0" class="empty-state">
            <FolderOpen :size="24" />
            <strong>远程目录为空</strong>
            <span>刷新远程仓库，或检查当前路径是否可访问。</span>
          </div>
        </div>
      </section>

      <section v-if="mainTab === 'history'" class="surface list-surface">
        <div class="surface-header history-header">
          <div>
            <h3>提交记录</h3>
            <p>最近 {{ store.svnLogs.length }} 条提交记录</p>
          </div>
        </div>
        <template v-for="entry in store.svnLogs" :key="entry.revision">
        <article
          :class="['history-row', { active: selectedSvnLog?.revision === entry.revision }]"
          @click="store.selectSvnLog(entry.revision)"
        >
          <strong class="history-revision">
            r{{ entry.revision }}
            <el-icon>
              <CaretBottom v-if="selectedSvnLog?.revision === entry.revision" />
              <CaretRight v-else />
            </el-icon>
          </strong>
          <span>{{ entry.author || '-' }}</span>
          <time :datetime="entry.date">{{ formatDate(entry.date) }}</time>
          <p :title="entry.message || '无提交备注'">{{ entry.message || '无提交备注' }}</p>
          <button
            class="history-checkout-button"
            title="检出此版本为新的工作副本"
            @click.stop="checkoutRevision(entry.revision)"
          >
            <Download :size="13" />
            检出此版本
          </button>
        </article>
        <section v-if="selectedSvnLog?.revision === entry.revision" class="history-detail" aria-label="提交文件列表">
          <header class="history-detail-header">
            <h4>r{{ entry.revision }} 提交内容</h4>
            <span>{{ entry.paths.length }} 个文件或目录</span>
          </header>
          <div v-if="entry.paths.length > 0" class="history-path-list">
            <div
              v-for="path in entry.paths"
              :key="`${entry.revision}-${path.path}`"
              class="history-path-row"
              @dblclick="store.diffRevisionPath(entry.revision, path)"
            >
              <span :class="['status-pill', logPathActionClass(path.action)]">{{ logPathActionLabel(path.action) }}</span>
              <strong>{{ path.kind === 'dir' ? '目录' : '文件' }}</strong>
              <code :title="path.path">{{ path.path }}</code>
              <button
                v-if="path.kind !== 'dir'"
                class="btn-icon history-diff-button"
                title="对比提交前后"
                @click.stop="store.diffRevisionPath(entry.revision, path)"
              >
                <Code2 :size="14" />
                <span>对比</span>
              </button>
            </div>
          </div>
          <div v-else class="empty-state compact">
            <History :size="20" />
            <strong>没有路径明细</strong>
            <span>这条日志没有返回 changed paths。</span>
          </div>
        </section>
        </template>
        <div v-if="store.svnLogs.length === 0" class="empty-state">
          <History :size="24" />
          <strong>暂无提交记录</strong>
          <span>选择仓库后刷新日志。</span>
        </div>
      </section>

      <section v-if="mainTab === 'logs'" class="surface list-surface">
        <div class="surface-header operation-header">
          <div>
            <h3>操作日志</h3>
            <p>命令、输出和错误信息已做脱敏处理</p>
          </div>
          <button class="btn-danger" :disabled="store.logs.length === 0" @click="clearOperationLogs">
            <Trash2 :size="15" />
            清除日志
          </button>
        </div>
        <article
          v-for="log in store.logs"
          :key="log.id"
          :class="['operation-row', { active: expandedOperationLogId === log.id }]"
          @click="toggleOperationLog(log.id)"
        >
          <div class="operation-main">
            <strong>
              {{ operationLabel(log.operation) }}
              <small>{{ formatDate(log.startedAt) }}</small>
            </strong>
            <p>{{ logSummary(log) }}</p>
          </div>
          <div class="operation-status">
            <span :class="['status-pill', logResultClass(log)]">{{ logResultText(log) }}</span>
            <el-icon>
              <CaretBottom v-if="expandedOperationLogId === log.id" />
              <CaretRight v-else />
            </el-icon>
          </div>
          <div v-if="expandedOperationLogId === log.id" class="operation-detail" @click.stop>
            <label>
              <span>完整命令</span>
              <code>{{ log.command }}</code>
            </label>
            <label>
              <span>原始输出</span>
              <pre>{{ latestLogText(log) }}</pre>
            </label>
          </div>
        </article>
        <div v-if="store.logs.length === 0" class="empty-state">
          <Terminal :size="24" />
          <strong>暂无操作日志</strong>
          <span>执行 SVN 操作后会显示在这里。</span>
        </div>
      </section>
      </template>
    </section>

    <div v-if="store.notice" :class="['toast', store.notice.tone, store.notice.placement]">
      <Info :size="16" />
      <span>{{ store.notice.text }}</span>
    </div>

    <div
      v-if="contextMenu"
      class="context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button
        v-for="item in contextMenu.items"
        :key="item.label"
        @click="runContextMenuItem(item)"
      >
        {{ item.label }}
      </button>
    </div>

    <div
      v-if="showRepoForm || showCredentialList || showCredentialForm || showRepoSettingsForm || showAppSettingsForm || pendingPathAction || store.remoteFileHistoryUrl || store.lastError"
      class="modal-layer"
      @click.self="showRepoForm = false; showCredentialList = false; showCredentialForm = false; showRepoSettingsForm = false; showAppSettingsForm = false; pendingPathAction = null; store.closeRemoteFileHistory(); store.clearError()"
    >
      <section v-if="showRepoForm" class="modal-card large" role="dialog" aria-modal="true" aria-label="添加仓库">
        <header class="modal-header">
          <div>
            <h2>{{ repoMode === 'working-copy' ? '添加工作副本' : '检出仓库' }}</h2>
            <p>将会保存连接信息，方便以后使用。</p>
          </div>
          <button class="btn-icon" title="关闭" @click="showRepoForm = false">
            <X :size="18" />
          </button>
        </header>
        <div class="form-grid">
          <label>
            <span>名称</span>
            <ElInput v-model="repoForm.name" placeholder="Project A" />
          </label>
          <label v-if="repoMode === 'working-copy'">
            <span>本地路径</span>
            <div class="field-with-button">
              <ElInput v-model="repoForm.localPath" placeholder="/Users/ww/work/project-a" />
              <button class="btn-secondary" @click="chooseDirectory('localPath')">
                <FolderOpen :size="15" />
                选择
              </button>
            </div>
          </label>
          <label v-else>
            <span>目标目录</span>
            <div class="field-with-button">
              <ElInput v-model="repoForm.targetDir" placeholder="/Users/ww/work/project-a" />
              <button class="btn-secondary" @click="chooseDirectory('targetDir')">
                <FolderOpen :size="15" />
                选择
              </button>
            </div>
          </label>
          <label>
            <span>远程 URL</span>
            <ElInput v-model="repoForm.remoteUrl" placeholder="https://svn.example.com/project-a" />
          </label>
          <label v-if="repoMode === 'checkout'">
            <span>版本号（可选）</span>
            <ElInput v-model="repoForm.revision" placeholder="留空检出最新版" />
          </label>
          <label>
            <span>账号</span>
            <ElSelect
              v-model="repoForm.credentialId"
              class="credential-select"
              fit-input-width
              popper-class="credential-select-dropdown"
            >
              <ElOption label="不使用账号" value="" />
              <ElOption
                v-for="credential in store.credentials"
                :key="credential.id"
                :label="credentialSelectLabel(credential)"
                :value="credential.id"
              />
            </ElSelect>
          </label>
          <div class="checkbox-row">
            <ElCheckbox v-model="repoForm.legacyTls" class="checkbox-line">允许旧 TLS 重试</ElCheckbox>
            <ElCheckbox v-model="repoForm.trustServerCertFailures" class="checkbox-line">接受旧证书错误重试</ElCheckbox>
          </div>
          <p class="form-note">旧 SVN 服务如果同时存在 TLS 版本过低、证书过期或自签名，需要两个选项都开启。</p>
        </div>
        <footer class="modal-footer">
          <button class="btn-secondary" :disabled="!repoForm.remoteUrl || !repoForm.credentialId" @click="testConnection">测试连接</button>
          <div>
            <button class="btn-secondary" @click="showRepoForm = false">取消</button>
            <button class="btn-primary" :disabled="store.loading" @click="saveRepository">保存</button>
          </div>
        </footer>
      </section>

      <section v-if="showCredentialList" class="modal-card large" role="dialog" aria-modal="true" aria-label="账号管理">
        <header class="modal-header">
          <div>
            <h2>账号管理</h2>
            <p>维护 SVN 登录账号。账号由 App 保存，不写入 SVN Keychain。</p>
          </div>
          <button class="btn-icon modal-close-button" title="关闭" @click="showCredentialList = false">
            <X :size="18" />
          </button>
        </header>
        <div class="list-toolbar">
          <button class="btn-primary" @click="resetCredentialForm()">
            <Plus :size="16" />
            添加账号
          </button>
        </div>
        <div v-if="store.credentials.length > 0" class="credential-table">
          <div class="credential-row header">
            <span>名称</span>
            <span>用户名</span>
            <span>匹配地址</span>
            <span>操作</span>
          </div>
          <div v-for="credential in store.credentials" :key="credential.id" class="credential-row">
            <strong>{{ credential.name }}</strong>
            <span>{{ credential.username }}</span>
            <code>{{ credential.matchUrl || '-' }}</code>
            <div class="table-actions">
              <button class="account-action account-action-edit" title="编辑账号" @click="resetCredentialForm(credential)">
                <Pencil :size="15" />
                <span>编辑</span>
              </button>
              <button class="account-action account-action-delete" title="删除账号" @click="removeCredentialFromList(credential)">
                <Trash2 :size="15" />
                <span>删除</span>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="empty-state compact">
          <KeyRound :size="20" />
          <strong>未保存账号</strong>
          <span>点击添加账号创建第一个 SVN 登录配置。</span>
        </div>
      </section>

      <section v-if="showCredentialForm" class="modal-card" role="dialog" aria-modal="true" aria-label="账号配置">
        <header class="modal-header">
          <div>
            <h2>{{ credentialForm.id ? '编辑账号' : '新增账号' }}</h2>
            <p>密码仅由 App 保存，不传给 SVN 认证缓存。</p>
          </div>
          <button class="btn-icon modal-close-button" title="关闭" @click="showCredentialForm = false">
            <X :size="18" />
          </button>
        </header>
        <div class="form-grid single">
          <label>
            <span>名称</span>
            <ElInput v-model="credentialForm.name" placeholder="公司 SVN" />
          </label>
          <label>
            <span>匹配地址</span>
            <ElInput v-model="credentialForm.matchUrl" placeholder="https://svn.example.com" />
          </label>
          <label>
            <span>用户名</span>
            <ElInput v-model="credentialForm.username" placeholder="user" />
          </label>
          <label>
            <span>密码</span>
            <ElInput v-model="credentialForm.password" type="password" show-password placeholder="输入密码" />
          </label>
        </div>
        <footer class="modal-footer">
          <button
            v-if="credentialForm.id"
            class="btn-danger"
            @click="removeCredentialFromForm"
          >
            <Trash2 :size="15" />
            删除
          </button>
          <span v-else></span>
          <div>
            <button class="btn-secondary" @click="showCredentialForm = false">取消</button>
            <button class="btn-primary" :disabled="store.loading" @click="saveCredential">保存</button>
          </div>
        </footer>
      </section>

      <section v-if="showRepoSettingsForm" class="modal-card large" role="dialog" aria-modal="true" aria-label="仓库设置">
        <header class="modal-header">
          <div>
            <h2>仓库设置</h2>
            <p>修改当前项目配置。移除项目只会删除 App 里的记录。</p>
          </div>
          <button class="btn-icon" title="关闭" @click="showRepoSettingsForm = false">
            <X :size="18" />
          </button>
        </header>
        <div class="form-grid">
          <label>
            <span>名称</span>
            <ElInput v-model="repoSettingsForm.name" />
          </label>
          <label>
            <span>本地路径</span>
            <div class="field-with-button">
              <ElInput v-model="repoSettingsForm.localPath" />
              <button class="btn-secondary" @click="chooseDirectory('repoLocalPath')">
                <FolderOpen :size="15" />
                选择
              </button>
            </div>
          </label>
          <label>
            <span>远程 URL</span>
            <ElInput v-model="repoSettingsForm.remoteUrl" />
          </label>
          <label>
            <span>账号</span>
            <ElSelect
              v-model="repoSettingsForm.credentialId"
              class="credential-select"
              fit-input-width
              popper-class="credential-select-dropdown"
            >
              <ElOption label="不使用账号" value="" />
              <ElOption
                v-for="credential in store.credentials"
                :key="credential.id"
                :label="credentialSelectLabel(credential)"
                :value="credential.id"
              />
            </ElSelect>
          </label>
          <div class="checkbox-row">
            <ElCheckbox v-model="repoSettingsForm.legacyTls" class="checkbox-line">允许旧 TLS 重试</ElCheckbox>
            <ElCheckbox v-model="repoSettingsForm.trustServerCertFailures" class="checkbox-line">接受旧证书错误重试</ElCheckbox>
          </div>
          <p class="form-note">旧 SVN 服务如果同时存在 TLS 版本过低、证书过期或自签名，需要两个选项都开启。</p>
        </div>
        <footer class="modal-footer">
          <button class="btn-danger" @click="removeSelectedRepository">移除项目</button>
          <div>
            <button class="btn-secondary" @click="showRepoSettingsForm = false">取消</button>
            <button class="btn-primary" :disabled="store.loading" @click="saveRepoSettings">保存</button>
          </div>
        </footer>
      </section>

      <section v-if="showAppSettingsForm" class="modal-card large" role="dialog" aria-modal="true" aria-label="应用设置">
        <header class="modal-header">
          <div>
            <h2>环境与应用设置</h2>
            <p>RelaxSVN 调用系统里的 SVN 和 VSCode CLI，不内置这些工具。</p>
          </div>
          <button class="btn-icon modal-close-button" title="关闭" @click="showAppSettingsForm = false">
            <X :size="18" />
          </button>
        </header>
        <section class="environment-summary">
          <header>
            <h3>环境</h3>
            <button class="btn-secondary" :disabled="store.loading" @click="store.refreshDependencies">
              <RefreshCw :size="15" />
              重新检测
            </button>
          </header>
          <div class="environment-note">
            <p>使用前请先安装 SVN 和 Visual Studio Code。</p>
            <span>SVN 用于更新、提交、检出等版本控制操作；VSCode 用于打开项目、文件对比和冲突合并。SVN 可通过 Homebrew 一键安装。</span>
          </div>
          <div class="env-list">
            <div class="env-row">
              <span :class="['status-dot', depClass(store.dependencies?.svn.status)]"></span>
              <span>SVN</span>
              <strong>{{ store.dependencies?.svn.version || '-' }}</strong>
            </div>
            <div class="env-row">
              <span :class="['status-dot', depClass(store.dependencies?.brew.status)]"></span>
              <span>Homebrew</span>
              <strong>{{ depText(store.dependencies?.brew.status) }}</strong>
            </div>
            <div class="env-row">
              <span :class="['status-dot', depClass(store.dependencies?.vscode.status)]"></span>
              <span>VSCode</span>
              <strong>{{ depText(store.dependencies?.vscode.status) }}</strong>
            </div>
          </div>
          <p
            v-if="store.dependencies?.svn.status === 'missing' && store.dependencies?.brew.status === 'missing'"
            class="environment-warning"
          >
            未检测到 SVN 和 Homebrew。请先安装 Homebrew，或在下方手动指定已有的 svn 可执行文件路径。
          </p>
          <p
            v-if="store.dependencies?.vscode.status === 'missing'"
            class="environment-warning muted"
          >
            未检测到 VSCode。安装 Visual Studio Code 后，可在命令面板启用 code 命令，或在下方手动选择 CLI 路径。
          </p>
          <button
            v-if="store.dependencies?.svn.status === 'missing'"
            class="btn-primary full"
            :disabled="store.loading || store.dependencies?.brew.status !== 'found'"
            @click="store.installSvn"
          >
            <Download :size="16" />
            通过 Homebrew 一键安装 SVN
          </button>
        </section>
        <div class="form-grid single">
          <label>
            <span>SVN 路径</span>
            <div class="field-with-button">
              <ElInput v-model="appSettingsForm.svnPath" placeholder="/opt/homebrew/bin/svn" />
              <button class="btn-secondary" @click="chooseFile('appSvnPath')">
                <FolderOpen :size="15" />
                选择
              </button>
            </div>
          </label>
          <label>
            <span>VSCode CLI 路径</span>
            <div class="field-with-button">
              <ElInput v-model="appSettingsForm.vscodeCliPath" placeholder="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" />
              <button class="btn-secondary" @click="chooseFile('appVscodePath')">
                <FolderOpen :size="15" />
                选择
              </button>
            </div>
          </label>
        </div>
        <footer class="modal-footer">
          <button
            class="btn-secondary"
            @click="resetAppSettingsToDefault"
          >
            恢复默认
          </button>
          <div>
            <button class="btn-secondary" @click="showAppSettingsForm = false">取消</button>
            <button class="btn-primary" :disabled="store.loading" @click="saveAppSettings">保存</button>
          </div>
        </footer>
      </section>

      <section v-if="pendingPathAction" class="modal-card" role="dialog" aria-modal="true" aria-label="确认路径操作">
        <header class="modal-header">
          <div>
            <h2>{{ pendingPathAction.title }}</h2>
            <p>{{ pendingPathAction.description }}</p>
          </div>
          <button class="btn-icon" title="关闭" @click="pendingPathAction = null">
            <X :size="18" />
          </button>
        </header>
        <div class="confirm-detail">
          <span>目标路径</span>
          <code>{{ pathActionName(pendingPathAction.item) }}</code>
        </div>
        <ElCheckbox v-if="pendingPathAction.kind === 'revert'" v-model="pendingPathAction.recursive" class="checkbox-line confirm-checkbox">
          递归还原目录内容
        </ElCheckbox>
        <footer class="modal-footer">
          <span></span>
          <div>
            <button class="btn-ghost" @click="pendingPathAction = null">取消</button>
            <button
              :class="pendingPathAction.tone === 'danger' ? 'btn-danger' : 'btn-primary'"
              :disabled="store.loading"
              @click="runPendingPathAction"
            >
              {{ pendingPathAction.confirmText }}
            </button>
          </div>
        </footer>
      </section>

      <section v-if="store.remoteFileHistoryUrl" class="modal-card large" role="dialog" aria-modal="true" aria-label="远程文件历史">
        <header class="modal-header">
          <div>
            <h2>文件历史</h2>
            <p>{{ store.remoteFileHistoryUrl }}</p>
          </div>
          <button class="btn-icon" title="关闭" @click="store.closeRemoteFileHistory()">
            <X :size="18" />
          </button>
        </header>
        <div class="file-history-list">
          <div class="file-history-row header">
            <span>版本</span>
            <span>作者</span>
            <span>时间</span>
            <span>说明</span>
            <span>操作</span>
          </div>
          <div v-if="store.remoteFileHistoryLoading" class="empty-state compact">
            <History :size="20" />
            <strong>正在读取历史</strong>
            <span>正在从远程仓库读取这个文件的提交记录。</span>
          </div>
          <div
            v-for="entry in store.remoteFileHistory"
            :key="entry.revision"
            class="file-history-row"
          >
            <strong>r{{ entry.revision }}</strong>
            <span>{{ entry.author || '-' }}</span>
            <time :datetime="entry.date">{{ formatDate(entry.date) }}</time>
            <p :title="entry.message || '无提交备注'">{{ entry.message || '无提交备注' }}</p>
            <button class="btn-secondary" @click="store.openRemoteFile(`${store.remoteFileHistoryUrl}@${entry.revision}`)">
              <Code2 :size="14" />
              打开
            </button>
          </div>
          <div v-if="!store.remoteFileHistoryLoading && store.remoteFileHistory.length === 0" class="empty-state compact">
            <History :size="20" />
            <strong>没有历史</strong>
            <span>这个远程文件暂时没有返回提交记录。</span>
          </div>
        </div>
      </section>

      <section v-if="store.lastError" class="modal-card" role="dialog" aria-modal="true" aria-label="错误详情">
        <header class="modal-header">
          <div>
            <h2>错误详情</h2>
            <p>{{ store.lastError.message }}</p>
          </div>
          <button class="btn-icon" title="关闭" @click="store.clearError()">
            <X :size="18" />
          </button>
        </header>
        <div class="error-detail">
          <label v-if="store.lastError.command">
            <span>命令</span>
            <code>{{ store.lastError.command }}</code>
          </label>
          <label>
            <span>原始输出</span>
            <pre>{{ store.lastError.raw }}</pre>
          </label>
        </div>
        <footer class="modal-footer">
          <span></span>
          <button class="btn-primary" @click="store.clearError()">知道了</button>
        </footer>
      </section>
    </div>

  </main>
  </div>
</template>
