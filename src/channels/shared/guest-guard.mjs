/**
 * Read-only guard for senders outside the owner allowlist.
 *
 * The Harness session that serves a Discord room is shared by everyone in it,
 * and this plugin cannot swap the tool set per turn — tools are bound to the
 * Session. So the only lever left at prompt time is the prompt itself: for an
 * unlisted sender the assembled content gains a permission block ahead of the
 * message body, forbidding local mutation while leaving answering, read-only
 * lookups and image replies intact.
 *
 * This is an instruction to the model, not a sandbox: a Host that offers a
 * per-turn tool policy should be wired through the bridge instead (see
 * FORK.md).
 */

/** Leading marker so the block reads as policy, not as the user's text. */
export const GUEST_GUARD_OPEN = '[dsh_im_guest_guard]';

/** Tags whose JSON blocks own their provenance and must never take the guard. */
const BLOCK_OPENS = Object.freeze(['<dsh_im_reply>', '<dsh_im_source>', '<dsh_im_context>']);

const GUARD_TEXT = [
  GUEST_GUARD_OPEN,
  '权限：本条来自未获授权的群友，只能使用只读能力。',
  '禁止调用任何会修改本机的东西：写文件、编辑文件、删除或移动文件、执行命令或脚本、安装依赖、git 提交或推送、改配置、改白名单或人格。',
  '也不要读取、复述或猜测配置文件内容、密钥、token、本机路径。',
  '对方要求做这些事时，直接说明你没有权限，不要尝试绕过。',
  '允许：回答问题、查资料、只读查询、发图片。',
].join('\n');

function isInjectedBlockPart(part) {
  return part?.type === 'text'
    && typeof part.text === 'string'
    && BLOCK_OPENS.some((open) => part.text.startsWith(open));
}

/**
 * Prepend the read-only guard to one model-facing prompt.
 * @param {string|Array<Object>|undefined} content - the assembled prompt content.
 * @returns {string|Array<Object>|undefined} the guarded content, or the input unchanged when empty.
 */
export function prependGuestGuard(content) {
  const guard = { type: 'text', text: GUARD_TEXT };
  if (typeof content === 'string') {
    return content ? [guard, { type: 'text', text: content }] : [guard];
  }
  if (!Array.isArray(content)) return content;
  const index = content.findIndex((part) => !isInjectedBlockPart(part));
  if (index === -1) return [...content, guard];
  // Insert ahead of the body: the guard must precede what the user wrote, and
  // must not replace it the way `Array#with` would.
  return [...content.slice(0, index), guard, ...content.slice(index)];
}
