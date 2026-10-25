import * as React from 'react';
import { h } from './i18n.js';
import { PERSONA_ENDPOINTS, MAX_PERSONA_CHARS } from '../../src/channels/discord/persona-endpoints.mjs';

function readResult(result) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取人格设置，请稍后重试。');
  const value = result.value ?? {};
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    text,
    defaultText: typeof value.defaultText === 'string' ? value.defaultText : text,
    customized: value.customized === true,
  };
}

/** Editable Discord persona, shown in the bot card and on the settings page. */
export function PersonaEditor({ rpcCall }) {
  const id = React.useId();
  const [persona, setPersona] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = readResult(await rpcCall(PERSONA_ENDPOINTS.get, {}));
        if (cancelled || !mounted.current) return;
        setPersona(loaded);
        setDraft(loaded.text);
      } catch (error) {
        if (!cancelled && mounted.current) setFeedback(error.message);
      }
    })();
    return () => { cancelled = true; mounted.current = false; };
  }, [rpcCall]);

  const save = async () => {
    if (busy || persona === null || draft === persona.text) return;
    setBusy(true);
    setFeedback(null);
    try {
      const saved = readResult(await rpcCall(PERSONA_ENDPOINTS.set, { text: draft }));
      if (!mounted.current) return;
      setPersona(saved);
      setDraft(saved.text);
      setFeedback('人格已保存，重启 DSH 后生效。');
    } catch (error) {
      if (mounted.current) setFeedback(error.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const saved = readResult(await rpcCall(PERSONA_ENDPOINTS.set, { reset: true }));
      if (!mounted.current) return;
      setPersona(saved);
      setDraft(saved.text);
      setFeedback('已恢复默认人格，重启 DSH 后生效。');
    } catch (error) {
      if (mounted.current) setFeedback(error.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const status = persona === null
    ? '正在读取人格…'
    : `${persona.customized ? '当前为自定义人格' : '当前为内置默认人格'}，最多 ${MAX_PERSONA_CHARS} 字；保存后重启 DSH 生效。`;

  return h('div', { className: 'dim-botGeneralRow dim-botGeneralPanelRow', 'aria-busy': busy },
    h('label', { className: 'dim-botGeneralTitle', htmlFor: `${id}-persona` }, '人格'),
    h('p', { className: 'dim-botGeneralHelp', id: `${id}-persona-help` }, status),
    h('textarea', {
      id: `${id}-persona`, className: 'dim-updateCommand', 'aria-label': '人格文本',
      'aria-describedby': `${id}-persona-help`, rows: 10, spellCheck: false,
      value: draft, disabled: busy || persona === null,
      onChange: (event) => setDraft(event.target.value),
    }),
    h('div', { className: 'dim-botGeneralActions' },
      h('button', {
        type: 'button', className: 'dim-deliveryButton', 'aria-busy': busy,
        disabled: busy || persona === null || !draft.trim() || draft === persona.text,
        onClick: () => void save(),
      }, '保存人格'),
      h('button', {
        type: 'button', className: 'dim-deliveryButton', 'aria-busy': busy,
        disabled: busy || !persona?.customized, onClick: () => void reset(),
      }, '恢复默认')),
    feedback ? h('p', {
      className: 'dim-accessFeedback', role: 'alert',
      'data-tone': /已/.test(feedback) ? 'success' : 'error',
    }, feedback) : null);
}
