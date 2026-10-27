import * as React from 'react';
import { h } from './i18n.js';
import { MEMBER_ENDPOINTS } from '../../src/channels/discord/member-endpoints.mjs';

const MAX_RENDERED = 300;
const MIN_BROWSER_LOADING_MS = 120;

function unwrapResult(result) {
  if (result?.ok === true) return result.value ?? {};
  const error = new Error(result?.error?.message || '无法读取服务器成员，请稍后重试。');
  error.code = result?.error?.code ?? null;
  throw error;
}

function initialsOf(member) {
  const source = member.displayName || member.username || member.id || '?';
  return String(source).trim().slice(0, 1).toUpperCase() || '?';
}

function matchesQuery(member, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [member.displayName, member.username, member.name, member.id]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function MemberAvatar({ member }) {
  const [broken, setBroken] = React.useState(false);
  if (!member.avatarUrl || broken) {
    return h('span', { className: 'dim-memberAvatar dim-memberAvatarFallback', 'aria-hidden': true },
      initialsOf(member));
  }
  return h('img', {
    className: 'dim-memberAvatar',
    src: member.avatarUrl,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerPolicy: 'no-referrer',
    onError: () => setBroken(true),
  });
}

function MemberRow({ member, selected, disabled, onToggle }) {
  const guildCount = Array.isArray(member.guildIds) ? member.guildIds.length : 0;
  return h('label', {
    className: 'dim-memberRow',
    'data-selected': selected ? 'true' : 'false',
    'data-disabled': disabled && !selected ? 'true' : 'false',
  },
  h(MemberAvatar, { member }),
  h('span', { className: 'dim-memberIdentity' },
    h('span', { className: 'dim-memberName' },
      member.displayName || member.username || member.id,
      member.username ? h('span', { className: 'dim-memberHandle' }, `@${member.username}`) : null),
    h('span', { className: 'dim-memberMeta' },
      h('code', { className: 'dim-memberId' }, member.id),
      guildCount > 0 ? h('span', { className: 'dim-memberGuilds' },
        guildCount > 1 ? `${guildCount} 个服务器` : '服务器成员') : null)),
  h('input', {
    type: 'checkbox',
    role: 'switch',
    className: 'dim-contextSwitch',
    checked: selected,
    disabled: disabled && !selected,
    'aria-label': `把 ${member.displayName || member.id} 加入白名单`,
    onChange: () => onToggle(member.id),
  }));
}

function Notice({ code, message, onRetry, busy }) {
  const intentRequired = code === 'members-intent-required';
  return h('div', { className: 'dim-memberNotice', role: 'alert', 'data-tone': 'error' },
    h('p', { className: 'dim-memberNoticeText' }, message || '读取成员失败。'),
    intentRequired ? h('p', { className: 'dim-memberNoticeHint' },
      '开启方法：Discord Developer Portal → 你的应用 → Bot → Privileged Gateway Intents → 打开 Server Members Intent → Save Changes，然后重启 dsh web。') : null,
    h('button', {
      type: 'button', className: 'dim-deliveryButton', disabled: busy, onClick: () => onRetry(true),
    }, '重试'));
}

export function MemberAllowlist({ account, rpcCall, selectedIds, onToggle, max, disabled }) {
  const [state, setState] = React.useState({
    status: 'idle', members: [], guilds: [], fetchedAt: 0, partial: false, error: null, code: null,
  });
  const [query, setQuery] = React.useState('');
  const [manualOpen, setManualOpen] = React.useState(false);
  const sequence = React.useRef(0);
  const mounted = React.useRef(true);

  React.useEffect(() => () => { mounted.current = false; }, []);

  const load = React.useCallback(async (force) => {
    const seq = ++sequence.current;
    setState((current) => ({ ...current, status: 'loading', error: null, code: null }));
    const startedAt = Date.now();
    try {
      const value = unwrapResult(await rpcCall(MEMBER_ENDPOINTS.list, {
        botId: account.botId,
        ...(force === true ? { force: true } : {}),
      }));
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_BROWSER_LOADING_MS) {
        await new Promise((resolve) => { setTimeout(resolve, MIN_BROWSER_LOADING_MS - elapsed); });
      }
      if (!mounted.current || seq !== sequence.current) return;
      setState({
        status: 'ready',
        members: Array.isArray(value.members) ? value.members : [],
        guilds: Array.isArray(value.guilds) ? value.guilds : [],
        fetchedAt: Number(value.fetchedAt) || Date.now(),
        partial: value.partial === true,
        error: null,
        code: null,
      });
    } catch (error) {
      if (!mounted.current || seq !== sequence.current) return;
      setState((current) => ({
        ...current, status: 'error', error: error?.message ?? '读取成员失败。', code: error?.code ?? null,
      }));
    }
  }, [account.botId, rpcCall]);

  React.useEffect(() => { void load(false); }, [load]);

  const memberById = React.useMemo(() => {
    const map = new Map();
    for (const member of state.members) map.set(member.id, member);
    return map;
  }, [state.members]);

  // Selected IDs that are not in the directory (manual IDs, ex-members) still need a removable row.
  const missingSelected = React.useMemo(
    () => [...selectedIds].filter((id) => !memberById.has(id)),
    [memberById, selectedIds],
  );

  const filtered = React.useMemo(() => {
    const rows = state.members.filter((member) => matchesQuery(member, query));
    rows.sort((a, b) => {
      const selectedDelta = Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id));
      if (selectedDelta !== 0) return selectedDelta;
      return (a.displayName || a.username || '').localeCompare(b.displayName || b.username || '', 'zh-Hans');
    });
    return rows;
  }, [query, selectedIds, state.members]);

  const visible = filtered.slice(0, MAX_RENDERED);
  const hiddenCount = filtered.length - visible.length;
  const selectedCount = selectedIds.size;
  const atLimit = selectedCount >= max;

  return h('div', { className: 'dim-memberPanel', 'aria-busy': state.status === 'loading' },
    h('div', { className: 'dim-memberToolbar' },
      h('div', { className: 'dim-memberCount' },
        h('strong', null, `${selectedCount}/${max}`),
        h('span', null, ' 已在白名单')),
      h('div', { className: 'dim-memberActions' },
        h('input', {
          type: 'search',
          className: 'dim-memberSearch',
          placeholder: '搜索名字、@用户名或 ID',
          'aria-label': '搜索服务器成员',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h('button', {
          type: 'button',
          className: 'dim-deliveryButton',
          disabled: state.status === 'loading' || disabled,
          onClick: () => void load(true),
        }, state.status === 'loading' ? '读取中…' : '刷新'))),

    state.status === 'error'
      ? h(Notice, { code: state.code, message: state.error, busy: false, onRetry: load })
      : state.status === 'loading' && state.members.length === 0
        ? h('p', { className: 'dim-memberLoading' }, '正在读取服务器成员…大型服务器可能需要几秒钟。')
        : [
          atLimit ? h('p', { className: 'dim-memberLimit', role: 'status' },
            `白名单已满 ${max} 人，先移除一个才能添加别人。`) : null,
          state.partial ? h('p', { className: 'dim-memberPartial', role: 'status' },
            '部分服务器读取失败，列表可能不完整；可以点「刷新」重试。') : null,
          visible.length === 0
            ? h('p', { className: 'dim-memberEmpty' },
              state.members.length === 0
                ? '没有读到任何成员。确认机器人已在服务器里，并已打开 Server Members Intent。'
                : '没有匹配的成员。')
            : h('div', { className: 'dim-memberList', role: 'list' },
              visible.map((member) => h(MemberRow, {
                key: member.id,
                member,
                selected: selectedIds.has(member.id),
                disabled: disabled || atLimit,
                onToggle,
              }))),
          hiddenCount > 0
            ? h('p', { className: 'dim-memberHidden' }, `还有 ${hiddenCount} 条未显示，输入关键字缩小范围。`)
            : null,
          hiddenCount === 0 && state.members.length > 0
            ? h('p', { className: 'dim-memberFetchedAt' },
              `已读取 ${state.members.length} 名成员 · ${new Date(state.fetchedAt).toLocaleTimeString()}`)
            : null,
        ],

    missingSelected.length > 0
      ? h('div', { className: 'dim-memberMissing' },
        h('p', { className: 'dim-memberMissingTitle' }, '不在成员列表里的已选 ID'),
        h('div', { className: 'dim-memberMissingList' }, missingSelected.map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'dim-memberMissingItem',
          disabled,
          onClick: () => onToggle(id),
          title: '从白名单移除',
        }, `${id} ×`)))) : null,

    h('div', { className: 'dim-memberManual' },
      h('button', {
        type: 'button',
        className: 'dim-memberManualToggle',
        'aria-expanded': manualOpen ? 'true' : 'false',
        onClick: () => setManualOpen((open) => !open),
      }, manualOpen ? '收起手动 ID 输入' : '手动添加用户 ID（备用）'),
      manualOpen ? h('p', { className: 'dim-memberManualHint' },
        '上面的成员列表会写进白名单文本框；不在服务器里或读取失败时，可以在「手动添加用户 ID」里一行一个直接填。') : null));
}
