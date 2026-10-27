import * as React from 'react';
import { h } from './i18n.js';
import { SET_MESSAGE_MODE_ENDPOINT, normalizeBusyMessageMode } from '../../src/channels/shared/message-mode.mjs';
import { normalizeFeishuStepCardPanels } from '../../src/channels/feishu/step-push-mode.mjs';
import { FEISHU_ENDPOINTS } from './channels/feishu/api.js';
import { PERSONA_ENDPOINTS, MAX_PERSONA_CHARS } from '../../src/channels/discord/persona-endpoints.mjs';
import { MAX_ALLOWLIST_SIZE, ALLOWLIST_ENDPOINTS } from '../../src/channels/discord/allowlist-endpoints.mjs';

function allowlistFromResult(result) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取白名单，请稍后重试。');
  const value = result.value ?? {};
  const ids = Array.isArray(value.ids) ? value.ids.filter((id) => typeof id === 'string') : [];
  return { ids, customized: value.customized === true };
}

function parseAllowlistDraft(draft) {
  return String(draft ?? '')
    .split(/[\s,，;；]+/)
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

function personaFromResult(result) {
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

function settingsFromResult(result, botId) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取通用设置，请稍后重试。');
  const bot = result.value?.bots?.find((entry) => entry.botId === botId);
  if (!bot) throw new Error('找不到要修改的机器人。');
  return {
    busyMessageMode: normalizeBusyMessageMode(bot.busyMessageMode),
    stepCardPanels: normalizeFeishuStepCardPanels(bot.stepCardPanels),
  };
}

export function BotGeneralSettingsPage({ channel, account, rpcCall }) {
  const modeId = React.useId();
  const [settings, setSettings] = React.useState(() => ({
    busyMessageMode: 'queue', stepCardPanels: normalizeFeishuStepCardPanels(),
  }));
  const [savedSettings, setSavedSettings] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const isDiscord = channel === 'discord';
  const [persona, setPersona] = React.useState(null);
  const [personaDraft, setPersonaDraft] = React.useState('');
  const [personaBusy, setPersonaBusy] = React.useState(false);
  const [personaFeedback, setPersonaFeedback] = React.useState(null);
  const [allowlist, setAllowlist] = React.useState(null);
  const [allowlistDraft, setAllowlistDraft] = React.useState('');
  const [allowlistBusy, setAllowlistBusy] = React.useState(false);
  const [allowlistFeedback, setAllowlistFeedback] = React.useState(null);
  const mounted = React.useRef(false);
  const inFlight = React.useRef(false);
  const mode = settings.busyMessageMode;

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const value = settingsFromResult(await rpcCall('connection.status', {}), account.botId);
      if (!mounted.current) return;
      setSettings(value);
      setSavedSettings(value);
      if (isDiscord) {
        try {
          const loaded = personaFromResult(await rpcCall(PERSONA_ENDPOINTS.get, {}));
          if (!mounted.current) return;
          setPersona(loaded);
          setPersonaDraft(loaded.text);
        } catch (error) {
          if (mounted.current) setPersonaFeedback(error.message);
        }
        try {
          const loaded = allowlistFromResult(await rpcCall(ALLOWLIST_ENDPOINTS.get, {}));
          if (!mounted.current) return;
          setAllowlist(loaded);
          setAllowlistDraft(loaded.ids.join('\n'));
        } catch (error) {
          if (mounted.current) setAllowlistFeedback(error.message);
        }
      }
    } catch (error) {
      if (mounted.current) setFeedback(error.message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [account.botId, isDiscord, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const save = async (field, value) => {
    if (inFlight.current || savedSettings === null || value === savedSettings[field]) return;
    inFlight.current = true;
    setSettings({ ...settings, [field]: value });
    setBusy(true);
    setFeedback(null);
    try {
      const endpoint = field === 'stepCardPanels' ? FEISHU_ENDPOINTS.setStepCardPanels : SET_MESSAGE_MODE_ENDPOINT;
      const saved = settingsFromResult(await rpcCall(endpoint, {
        botId: account.botId, [field]: value,
      }), account.botId);
      if (!mounted.current) return;
      setSettings(saved);
      setSavedSettings(saved);
    } catch (error) {
      if (mounted.current) {
        setSettings(savedSettings);
        setFeedback(error.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const savePersona = async () => {
    if (personaBusy || persona === null || personaDraft === persona.text) return;
    setPersonaBusy(true);
    setPersonaFeedback(null);
    try {
      const saved = personaFromResult(await rpcCall(PERSONA_ENDPOINTS.set, { text: personaDraft }));
      if (!mounted.current) return;
      setPersona(saved);
      setPersonaDraft(saved.text);
      setPersonaFeedback('人格已保存，重启 DSH 后生效。');
    } catch (error) {
      if (mounted.current) setPersonaFeedback(error.message);
    } finally {
      if (mounted.current) setPersonaBusy(false);
    }
  };

  const resetPersona = async () => {
    if (personaBusy) return;
    setPersonaBusy(true);
    setPersonaFeedback(null);
    try {
      const saved = personaFromResult(await rpcCall(PERSONA_ENDPOINTS.set, { reset: true }));
      if (!mounted.current) return;
      setPersona(saved);
      setPersonaDraft(saved.text);
      setPersonaFeedback('已恢复默认人格，重启 DSH 后生效。');
    } catch (error) {
      if (mounted.current) setPersonaFeedback(error.message);
    } finally {
      if (mounted.current) setPersonaBusy(false);
    }
  };

  const saveAllowlist = async () => {
    if (allowlistBusy || allowlist === null) return;
    const ids = parseAllowlistDraft(allowlistDraft);
    setAllowlistBusy(true);
    setAllowlistFeedback(null);
    try {
      const saved = allowlistFromResult(await rpcCall(ALLOWLIST_ENDPOINTS.set, { ids }));
      if (!mounted.current) return;
      setAllowlist(saved);
      setAllowlistDraft(saved.ids.join('\n'));
      setAllowlistFeedback('白名单已保存，30 秒内生效。');
    } catch (error) {
      if (mounted.current) setAllowlistFeedback(error.message);
    } finally {
      if (mounted.current) setAllowlistBusy(false);
    }
  };

  return h('section', { className: 'dim-botGeneralSettings', 'aria-label': '机器人通用设置', 'aria-busy': busy },
    h('div', { className: 'dim-botGeneralList' },
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: modeId }, '消息处理方式'),
          h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-description` }, mode === 'queue'
            ? '当前任务结束后处理新消息'
            : '将新消息补充到当前任务')),
        h('div', { className: 'dim-botGeneralControl' },
          h('select', {
            id: modeId, value: mode, disabled: busy || savedSettings === null,
            'aria-label': '消息处理方式',
            'aria-describedby': `${modeId}-description`,
            onChange: (event) => void save('busyMessageMode', event.target.value),
          },
          h('option', { value: 'queue' }, '排队'),
          h('option', { value: 'steer' }, '插话')),
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'm4 6 4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })))),
      channel === 'feishu' ? [
        ['thinkingExpanded', '展开思考过程'],
        ['toolsExpanded', '展开工具摘要'],
      ].map(([field, label]) => h('div', { key: field, className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
        h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-${field}` }, label),
        h('div', { className: 'dim-botGeneralControl' },
          h('input', {
            id: `${modeId}-${field}`, type: 'checkbox', role: 'switch', className: 'dim-contextSwitch',
            checked: settings.stepCardPanels[field], disabled: busy || savedSettings === null,
            'aria-label': label, 'aria-describedby': `${modeId}-panels-description`,
            onChange: (event) => void save('stepCardPanels', {
              ...settings.stepCardPanels, [field]: event.target.checked,
            }),
          })))) : null),
    channel === 'feishu' ? h('p', { className: 'dim-botGeneralHelp dim-botGeneralPanelHelp', id: `${modeId}-panels-description` },
      '仅对实时过程卡生效，任务结束后自动收起。') : null,
    isDiscord && persona !== null ? h('div', { className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
      h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-persona` }, '人格'),
      h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-persona-help` },
        `${persona.empty ? '已清空，当前不注入人格' : persona.customized ? '当前为自定义人格' : '当前为内置默认人格'}，最多 ${MAX_PERSONA_CHARS} 字；留空即不注入；保存后重启 DSH 生效。`),
      h('textarea', {
        id: `${modeId}-persona`, className: 'dim-updateCommand', 'aria-label': '人格文本',
        'aria-describedby': `${modeId}-persona-help`, rows: 10,
        placeholder: '留空则不注入任何人格',
        value: personaDraft, disabled: personaBusy, spellCheck: false,
        onChange: (event) => setPersonaDraft(event.target.value),
      }),
      h('div', { className: 'dim-botGeneralActions' },
        h('button', {
          type: 'button', className: 'dim-deliveryButton', 'aria-busy': personaBusy,
          disabled: personaBusy || personaDraft === persona.text,
          onClick: () => void savePersona(),
        }, '保存人格'),
        h('button', {
          type: 'button', className: 'dim-deliveryButton', 'aria-busy': personaBusy,
          disabled: personaBusy || !persona.customized, onClick: () => void resetPersona(),
        }, '恢复默认')),
      personaFeedback ? h('p', {
        className: 'dim-accessFeedback', role: 'alert',
        'data-tone': /已/.test(personaFeedback) ? 'success' : 'error',
      }, personaFeedback) : null) : null,
    isDiscord && allowlist !== null ? h('div', { className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
      h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-allowlist` }, '白名单'),
      h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-allowlist-help` },
        `一行一个 Discord 用户 ID，最多 ${MAX_ALLOWLIST_SIZE} 个；名单里的人可以像主人一样使用完整指令，保存后 30 秒内生效。`),
      h('textarea', {
        id: `${modeId}-allowlist`, className: 'dim-updateCommand', 'aria-label': '白名单用户 ID',
        'aria-describedby': `${modeId}-allowlist-help`, rows: 5,
        value: allowlistDraft, disabled: allowlistBusy, spellCheck: false,
        placeholder: '123456789012345678',
        onChange: (event) => setAllowlistDraft(event.target.value),
      }),
      h('div', { className: 'dim-botGeneralActions' },
        h('button', {
          type: 'button', className: 'dim-deliveryButton', 'aria-busy': allowlistBusy,
          disabled: allowlistBusy || parseAllowlistDraft(allowlistDraft).join(',') === allowlist.ids.join(','),
          onClick: () => void saveAllowlist(),
        }, '保存白名单')),
      allowlistFeedback ? h('p', {
        className: 'dim-accessFeedback', role: 'alert',
        'data-tone': /已/.test(allowlistFeedback) ? 'success' : 'error',
      }, allowlistFeedback) : null) : null,
    feedback ? h('p', {
      className: 'dim-accessFeedback', 'data-tone': 'error', role: 'alert',
    }, feedback) : null,
    savedSettings === null && !busy ? h('div', { className: 'dim-botGeneralActions' },
      h('button', {
        type: 'button', className: 'dim-deliveryButton', onClick: () => void load(),
      }, '重新读取')) : null);
}
