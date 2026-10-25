/**
 * RPC for the editable Discord persona: read the effective text, save an
 * override, or reset back to the built-in default.
 */
import { PERSONA_ENDPOINTS } from '../../src/channels/discord/persona-endpoints.mjs';

function invalid(message) {
  return { ok: false, error: { code: 'persona-invalid', message } };
}

export function createPersonaRpcHandler(store) {
  return async (endpoint, payload, signal) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || signal?.aborted) {
      return invalid('人格设置请求无效。');
    }
    const keys = Object.keys(payload);
    if (endpoint === PERSONA_ENDPOINTS.get) {
      if (keys.length !== 0) return invalid('人格读取请求不接受参数。');
      try {
        return { ok: true, value: store.snapshot() };
      } catch {
        return { ok: false, error: { code: 'persona-unavailable', message: '无法读取人格设置，请稍后重试。' } };
      }
    }
    if (endpoint !== PERSONA_ENDPOINTS.set) return invalid('人格设置请求无效。');
    const isSave = keys.length === 1 && keys[0] === 'text';
    const isReset = keys.length === 1 && keys[0] === 'reset' && payload.reset === true;
    if (!isSave && !isReset) return invalid('人格设置请求无效。');
    try {
      return { ok: true, value: isSave ? store.write(payload.text) : store.reset() };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code ?? 'persona-unavailable',
          message: error?.code === 'persona-invalid' ? error.message : '无法保存人格设置，请稍后重试。',
        },
      };
    }
  };
}
