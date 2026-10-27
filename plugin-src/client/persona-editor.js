import * as React from 'react';
import { createPortal } from 'react-dom';
import { h } from './i18n.js';
import { PERSONA_ENDPOINTS, MAX_PERSONA_CHARS } from '../../src/channels/discord/persona-endpoints.mjs';

const NAME_LIMIT = 40;

function PersonaIcon({ kind = 'sliders' }) {
  const path = kind === 'close' ? 'M6 6l12 12M6 18 18 6'
    : kind === 'chevron' ? 'm9 5 7 7-7 7'
      : kind === 'plus' ? 'M12 5v14M5 12h14'
        : 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-3M14 20H3M14 2v4M8 10v4M18 18v4';
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, h('path', { d: path }));
}

/** Every `ok: false` answer from the card RPC becomes a thrown error with the server message. */
function unwrap(result, fallback) {
  if (result?.ok !== true) throw new Error(result?.error?.message || fallback);
  return result.value ?? {};
}

function listOf(value) {
  const items = Array.isArray(value?.items) ? value.items.filter((item) => item && typeof item.id === 'string') : [];
  return {
    items: items.map((item) => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : '未命名',
      chars: Number.isFinite(item.chars) ? item.chars : 0,
    })),
    activeId: typeof value?.activeId === 'string' ? value.activeId : null,
    epoch: Number.isSafeInteger(value?.epoch) ? value.epoch : 0,
  };
}

function PersonaDialog({ id, rpcCall, onClose, returnFocusRef, onActivated }) {
  const [items, setItems] = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [name, setName] = React.useState('');
  const [text, setText] = React.useState('');
  const [baseline, setBaseline] = React.useState({ name: '', text: '' });
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const dialogRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const titleId = React.useId();
  const helpId = React.useId();
  const nameId = React.useId();
  const fieldId = React.useId();

  React.useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.focus?.();
    const keepFocus = (event) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target)) dialogRef.current.focus();
    };
    globalThis.document?.addEventListener?.('focusin', keepFocus);
    return () => {
      mountedRef.current = false;
      globalThis.document?.removeEventListener?.('focusin', keepFocus);
      queueMicrotask(() => returnFocusRef.current?.focus?.());
    };
  }, [returnFocusRef]);

  const select = React.useCallback(async (personaId) => {
    const value = unwrap(await rpcCall(PERSONA_ENDPOINTS.get, { id: personaId }), '读取这个人格失败，请重试。');
    if (!mountedRef.current) return;
    const nextName = typeof value.name === 'string' ? value.name : '';
    const nextText = typeof value.text === 'string' ? value.text : '';
    setSelectedId(personaId);
    setName(nextName);
    setText(nextText);
    setBaseline({ name: nextName, text: nextText });
    setNotice(null);
  }, [rpcCall]);

  const refresh = React.useCallback(async (preferredId = null) => {
    const listed = listOf(unwrap(await rpcCall(PERSONA_ENDPOINTS.list, {}), '读取人格清單失败，请重试。'));
    setItems(listed.items);
    setActiveId(listed.activeId);
    const nextId = preferredId ?? listed.activeId ?? listed.items[0]?.id ?? null;
    if (nextId) await select(nextId);
    else {
      setSelectedId(null);
      setName('');
      setText('');
      setBaseline({ name: '', text: '' });
    }
    setLoaded(true);
    return listed;
  }, [rpcCall, select]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (cause) {
        if (!cancelled && mountedRef.current) setError(cause?.message ?? '读取人格失败，请重试。');
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  /** Run one mutating RPC with the shared busy/error shell, then refresh the list. */
  const mutate = async (run, fallback, preferredId = undefined) => {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const value = await run();
      if (mountedRef.current) await refresh(preferredId === undefined ? null : preferredId);
      return value;
    } catch (cause) {
      if (mountedRef.current) setError(cause?.message ?? fallback);
      return null;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const dirty = loaded && selectedId !== null && (name !== baseline.name || text !== baseline.text);
  const isActive = selectedId !== null && selectedId === activeId;
  // A blank persona has nothing to inject, so activating it only retires the
  // bound Session and loses the current voice. Block it in the UI too; the
  // library refuses it as well, so the rule holds without the dialog.
  const blank = text.trim() === '';

  const saveSelected = () => mutate(async () => {
    unwrap(await rpcCall(PERSONA_ENDPOINTS.save, { id: selectedId, name, text }), '人格保存失败，请重试。');
    setBaseline({ name, text });
    setNotice('已儲存');
    return true;
  }, '人格保存失败，请重试。', selectedId);

  const activateSelected = () => mutate(async () => {
    // Switching to a blank body is allowed — it means "no persona段" — but it is
    // announced first, because the effect is the bot losing its voice.
    if (text.trim() === '' && activeId !== null && activeId !== selectedId
      && globalThis.confirm
      && !globalThis.confirm('切成「無人格」？切換後不再注入任何人設。')) {
      return null;
    }
    if (dirty) unwrap(await rpcCall(PERSONA_ENDPOINTS.save, { id: selectedId, name, text }), '人格保存失败，请重试。');
    setBaseline({ name, text });
    unwrap(await rpcCall(PERSONA_ENDPOINTS.activate, { id: selectedId }), '切换人格失败，请重试。');
    setActiveId(selectedId);
    setNotice(`已切換 · 上一段對話的摘要會在下一則訊息後生成`);
    onActivated?.(name);
    return true;
  }, '切换人格失败，请重试。', selectedId);

  const createPersona = () => mutate(async () => {
    const value = unwrap(await rpcCall(PERSONA_ENDPOINTS.create, { name: `人格 ${items.length + 1}`, text: '' }), '新增人格失败，请重试。');
    if (typeof value.id === 'string') setNotice('已新增');
    return typeof value.id === 'string' ? value.id : null;
  }, '新增人格失败，请重试。');

  const removeSelected = () => {
    if (isActive || busy) return;
    const label = items.find((item) => item.id === selectedId)?.name ?? '这个人格';
    const confirmed = globalThis.confirm ? globalThis.confirm(`删除人格「${label}」？`) : true;
    if (!confirmed) return;
    void mutate(async () => {
      unwrap(await rpcCall(PERSONA_ENDPOINTS.delete, { id: selectedId }), '删除人格失败，请重试。');
      setNotice('已删除');
      return true;
    }, '删除人格失败，请重试。');
  };

  const content = h('div', {
    className: 'dim-contextBackdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose(); },
  }, h('section', {
    id,
    ref: dialogRef,
    className: 'dim-contextDialog dim-contextPersonaDialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': helpId,
    'aria-busy': busy,
    tabIndex: -1,
    onKeyDown: (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
  },
  h('header', { className: 'dim-contextHeader' },
    h('div', { className: 'dim-contextHeaderTitle' },
      h('h3', { id: titleId }, '人格'),
      h('span', { id: helpId, className: 'dim-contextHelp dim-contextHeaderHelp' },
        'Discord 群里使用的人格文本，最多 ', String(MAX_PERSONA_CHARS),
        ' 字；0 字代表「無人格」，不注入任何人設。切换后从下一条消息起生效。')),
    h('button', {
      type: 'button', className: 'dim-contextClose', 'aria-label': '关闭弹窗',
      disabled: busy, onClick: onClose,
    }, h(PersonaIcon, { kind: 'close' }))),
  h('div', { className: 'dim-contextPersonaLayout' },
    h('div', { className: 'dim-contextPersonaSide' },
      h('div', { className: 'dim-contextPersonaSideHeader' },
        h('span', null, '人格清單'),
        h('button', {
          type: 'button', className: 'dim-contextPersonaAdd',
          disabled: !loaded || busy, onClick: () => { void createPersona(); },
        }, h(PersonaIcon, { kind: 'plus' }), '新增')),
      h('ul', { className: 'dim-contextPersonaList', 'aria-label': '人格清單' },
        items.map((item) => h('li', { key: item.id },
          h('button', {
            type: 'button',
            className: 'dim-contextPersonaItem',
            'data-selected': item.id === selectedId,
            'aria-pressed': item.id === selectedId,
            disabled: busy,
            onClick: () => { void (async () => {
              if (item.id === selectedId) return;
              setError(null);
              try { await select(item.id); } catch (cause) {
                if (mountedRef.current) setError(cause?.message ?? '读取这个人格失败，请重试。');
              }
            })(); },
          },
          h('span', { className: 'dim-contextPersonaName' }, item.chars === 0 ? '無人格（不注入）' : item.name),
          h('span', { className: 'dim-contextPersonaMeta' },
            item.id === activeId ? h('span', { className: 'dim-contextStatus', 'data-active': 'true' }, '使用中') : null,
            String(item.chars))))))) ,
    h('div', { className: 'dim-contextPersonaMain' },
      h('label', { htmlFor: nameId, className: 'dim-contextLabel' }, '名稱'),
      h('input', {
        id: nameId,
        className: 'dim-contextPersonaInput',
        value: name,
        maxLength: NAME_LIMIT,
        disabled: !loaded || selectedId === null || busy,
        onChange: (event) => setName(event.target.value),
      }),
      h('label', { htmlFor: fieldId, className: 'dim-contextLabel' }, '人格文本'),
      h('textarea', {
        id: fieldId,
        className: 'dim-contextPersonaText',
        value: text,
        rows: 14,
        maxLength: MAX_PERSONA_CHARS,
        spellCheck: false,
        disabled: !loaded || selectedId === null || busy,
        placeholder: loaded ? '寫上這個人物的設定；留空就是「無人格」，不注入任何人設。' : '正在读取人格…',
        onChange: (event) => setText(event.target.value),
      }))) ,
  blank ? h('p', { className: 'dim-contextPersonaEmptyHint' },
    '這個人物是空的：切成它等於「無人格」，下一句起不再帶任何人設。') : null,
  error ? h('p', { className: 'dim-contextError', role: 'alert' }, error) : null,
  notice ? h('p', { className: 'dim-contextNotice', role: 'status' }, notice) : null,
  h('footer', { className: 'dim-contextFooter' },
    h('button', {
      type: 'button', disabled: busy || selectedId === null || isActive,
      onClick: removeSelected,
    }, '删除'),
    h('button', { type: 'button', disabled: busy, onClick: onClose }, '关闭'),
    h('button', {
      type: 'button', className: 'dim-contextActivate',
      disabled: busy || selectedId === null || isActive,
      onClick: () => { void activateSelected(); },
    }, isActive ? '使用中' : blank ? '切成無人格' : '切換到這個人'),
    h('button', {
      type: 'button', className: 'dim-contextSave',
      disabled: busy || !loaded || !dirty,
      onClick: () => { void saveSelected(); },
    }, busy ? '保存中…' : '保存'))));

  return globalThis.document?.body ? createPortal(content, globalThis.document.body) : content;
}

/** Editable Discord persona library, shown in the bot card as a row that opens a dialog. */
export function PersonaEditor({ rpcCall }) {
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState('未设置');
  const [active, setActive] = React.useState(false);
  const entryRef = React.useRef(null);
  const dialogId = React.useId();
  const statusId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = listOf(unwrap(await rpcCall(PERSONA_ENDPOINTS.list, {}), '读取人格清單失败，请重试。'));
        if (cancelled) return;
        const current = listed.items.find((item) => item.id === listed.activeId);
        setLabel(current ? current.name : '未设置');
        setActive(current !== undefined);
      } catch {
        if (!cancelled) setLabel('读取失败');
      }
    })();
    return () => { cancelled = true; };
  }, [rpcCall]);

  const onActivated = (nextName) => {
    if (nextName) setLabel(nextName);
    setActive(true);
  };

  return h(React.Fragment, null,
    h('button', {
      type: 'button', ref: entryRef, className: 'dim-contextEntry',
      'aria-label': '目前人格', 'aria-describedby': statusId,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined,
      onClick: () => setOpen(true),
    }, h(PersonaIcon),
    h('span', { className: 'dim-contextLabel' }, '目前人格'),
    h('span', {
      id: statusId, className: 'dim-contextStatus',
      'data-active': active, 'aria-live': 'polite',
    }, label),
    h(PersonaIcon, { kind: 'chevron' })),
    open ? h(PersonaDialog, {
      id: dialogId, rpcCall,
      onClose: () => setOpen(false),
      returnFocusRef: entryRef,
      onActivated,
    }) : null);
}
