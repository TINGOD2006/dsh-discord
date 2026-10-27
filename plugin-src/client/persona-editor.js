import * as React from 'react';
import { createPortal } from 'react-dom';
import { h } from './i18n.js';
import { PERSONA_ENDPOINTS, MAX_PERSONA_CHARS } from '../../src/channels/discord/persona-endpoints.mjs';

function PersonaIcon({ kind = 'sliders' }) {
  const path = kind === 'close' ? 'M6 6l12 12M6 18 18 6'
    : kind === 'chevron' ? 'm9 5 7 7-7 7'
      : 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-3M14 20H3M14 2v4M8 10v4M18 18v4';
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, h('path', { d: path }));
}

function readResult(result) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取人格设置，请稍后重试。');
  const value = result.value ?? {};
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    text,
    defaultText: typeof value.defaultText === 'string' ? value.defaultText : text,
    customized: value.customized === true,
    empty: value.empty === true || (value.customized === true && text === ''),
  };
}

function PersonaDialog({ id, rpcCall, onClose, returnFocusRef }) {
  const [persona, setPersona] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const dialogRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const titleId = React.useId();
  const helpId = React.useId();
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

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = readResult(await rpcCall(PERSONA_ENDPOINTS.get, {}));
        if (cancelled || !mountedRef.current) return;
        setPersona(loaded);
        setDraft(loaded.text);
      } catch (cause) {
        if (!cancelled && mountedRef.current) setError(cause?.message ?? '读取人格失败，请重试。');
      }
    })();
    return () => { cancelled = true; };
  }, [rpcCall]);

  const save = async (payload) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      readResult(await rpcCall(PERSONA_ENDPOINTS.set, payload));
      if (!mountedRef.current) return;
      onClose();
    } catch (cause) {
      if (mountedRef.current) setError(cause?.message ?? '人格保存失败，请重试。');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const ready = persona !== null;
  const dirty = ready && draft !== persona.text;
  const content = h('div', {
    className: 'dim-contextBackdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose(); },
  }, h('section', {
    id,
    ref: dialogRef,
    className: 'dim-contextDialog',
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
        ' 字；空白或未设置时都不注入人格；保存后重启 DSH 生效。')),
    h('button', {
      type: 'button', className: 'dim-contextClose', 'aria-label': '关闭弹窗',
      disabled: busy, onClick: onClose,
    }, h(PersonaIcon, { kind: 'close' }))),
  h('div', { className: 'dim-contextGuidance' },
    h('label', { htmlFor: fieldId, className: 'dim-contextLabel' }, '人格文本'),
    h('textarea', {
      id: fieldId,
      value: draft,
      rows: 12,
      maxLength: MAX_PERSONA_CHARS,
      spellCheck: false,
      disabled: !ready || busy,
      placeholder: ready ? '留空则不注入任何人格，Discord 回合不再带人格段。' : '正在读取人格…',
      onChange: (event) => setDraft(event.target.value),
    })),
  error ? h('p', { className: 'dim-contextError', role: 'alert' }, error) : null,
  h('footer', { className: 'dim-contextFooter' },
    h('button', {
      type: 'button', disabled: busy || !persona?.customized,
      onClick: () => { void save({ reset: true }); },
    }, '清空'),
    h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消'),
    h('button', {
      type: 'button', className: 'dim-contextSave',
      disabled: busy || !ready || !dirty,
      onClick: () => { void save({ text: draft }); },
    }, busy ? '保存中…' : '保存'))));

  return globalThis.document?.body ? createPortal(content, globalThis.document.body) : content;
}

/** Editable Discord persona, shown in the bot card as a row that opens a dialog. */
export function PersonaEditor({ rpcCall }) {
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState('未设置');
  const entryRef = React.useRef(null);
  const dialogId = React.useId();
  const statusId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = readResult(await rpcCall(PERSONA_ENDPOINTS.get, {}));
        if (!cancelled) setLabel(loaded.text ? '自定义' : loaded.customized ? '已清空' : '未设置');
      } catch {
        if (!cancelled) setLabel('读取失败');
      }
    })();
    return () => { cancelled = true; };
  }, [rpcCall]);

  return h(React.Fragment, null,
    h('button', {
      type: 'button', ref: entryRef, className: 'dim-contextEntry',
      'aria-label': '人格', 'aria-describedby': statusId,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined,
      onClick: () => setOpen(true),
    }, h(PersonaIcon),
    h('span', { className: 'dim-contextLabel' }, '人格'),
    h('span', {
      id: statusId, className: 'dim-contextStatus',
      'data-active': label === '自定义' || label === '已清空', 'aria-live': 'polite',
    }, label),
    h(PersonaIcon, { kind: 'chevron' })),
    open ? h(PersonaDialog, {
      id: dialogId, rpcCall,
      onClose: () => setOpen(false),
      returnFocusRef: entryRef,
    }) : null);
}
