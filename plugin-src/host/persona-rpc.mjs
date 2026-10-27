/**
 * RPC for the Discord persona library: list, read, create, save, delete, and
 * activate personas, plus the legacy single-persona shape the old card calls.
 *
 * The handler owns validation and error mapping only; every rule about the
 * personas themselves lives in `DiscordPersonaLibrary`.
 */
import { PERSONA_ENDPOINTS } from '../../src/channels/discord/persona-endpoints.mjs';
import { DISCORD_PERSONA_PROMPT } from '../../src/channels/discord/persona.mjs';

const FALLBACK_MESSAGES = {
  'persona-not-found': '找不到这个人格。',
  'persona-active-undeletable': '正在使用的人格不能删除，请先切换到别的人格。',
  'persona-limit': '人格数量已达上限，请先删除一个。',
  'persona-too-large': '人格正文太长。',
};

function invalid(message) {
  return { ok: false, error: { code: 'persona-invalid', message } };
}

function failure(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('persona-')
    ? error.code
    : 'persona-unavailable';
  if (code === 'persona-invalid') {
    return { ok: false, error: { code, message: error?.message ?? '人格设置请求无效。' } };
  }
  return {
    ok: false,
    error: { code, message: FALLBACK_MESSAGES[code] ?? '无法保存人格设置，请稍后重试。' },
  };
}

/** `keys` must hold every required key and nothing outside `allowed`. */
function shape(payload, allowed, required = []) {
  const keys = Object.keys(payload);
  if (!keys.every((key) => allowed.includes(key))) return false;
  return required.every((key) => key in payload);
}

function legacySnapshot(library) {
  const text = library.activeText();
  return {
    text,
    defaultText: DISCORD_PERSONA_PROMPT,
    customized: text !== '',
    empty: text === '',
  };
}

export function createPersonaRpcHandler(library) {
  return async (endpoint, payload, signal) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || signal?.aborted) {
      return invalid('人格设置请求无效。');
    }
    try {
      if (endpoint === PERSONA_ENDPOINTS.list) {
        if (Object.keys(payload).length !== 0) return invalid('人格清單请求不接受参数。');
        return { ok: true, value: library.snapshot() };
      }
      if (endpoint === PERSONA_ENDPOINTS.get) {
        if (Object.keys(payload).length === 0) return { ok: true, value: legacySnapshot(library) };
        if (!shape(payload, ['id'], ['id'])) return invalid('人格读取请求无效。');
        const persona = library.read(payload.id);
        return { ok: true, value: { id: persona.id, name: persona.name, text: persona.text } };
      }
      if (endpoint === PERSONA_ENDPOINTS.create) {
        if (!shape(payload, ['name', 'text'], ['name'])) return invalid('人格新增请求无效。');
        const created = library.create({ name: payload.name, text: payload.text ?? '' });
        return { ok: true, value: { id: created.id } };
      }
      if (endpoint === PERSONA_ENDPOINTS.save) {
        if (!shape(payload, ['id', 'name', 'text'], ['id', 'text'])) return invalid('人格保存请求无效。');
        library.save({ id: payload.id, name: payload.name, text: payload.text });
        return { ok: true, value: { ok: true } };
      }
      if (endpoint === PERSONA_ENDPOINTS.delete) {
        if (!shape(payload, ['id'], ['id'])) return invalid('人格删除请求无效。');
        library.remove(payload.id);
        return { ok: true, value: { ok: true } };
      }
      if (endpoint === PERSONA_ENDPOINTS.activate) {
        if (!shape(payload, ['id'], ['id'])) return invalid('人格切换请求无效。');
        const { epoch } = library.activate(payload.id);
        // The handoff summary is generated after the next message retires the old
        // Session, so activation itself can only promise that it is deferred.
        return { ok: true, value: { ok: true, epoch, handoff: 'deferred' } };
      }
      if (endpoint === PERSONA_ENDPOINTS.set) {
        // Old card: { text } saves the active persona, { reset: true } clears it.
        if (shape(payload, ['reset'], ['reset']) && payload.reset === true) {
          library.save({ id: library.snapshot().activeId, text: '' });
          return { ok: true, value: { ok: true } };
        }
        if (!shape(payload, ['text'], ['text'])) return invalid('人格设置请求无效。');
        library.save({ id: library.snapshot().activeId, text: payload.text });
        return { ok: true, value: { ok: true } };
      }
      return invalid('人格设置请求无效。');
    } catch (error) {
      return failure(error);
    }
  };
}
