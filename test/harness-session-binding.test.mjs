import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptRegisteredWorkspaceSession } from '../src/channels/shared/harness-session-binding.mjs';

const SESSION = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = 'C:\\work\\space';

function client({ sessions = [], workspace = { workspaceId: 'w1', path: WORKSPACE, sessionIds: [SESSION] } } = {}) {
  const calls = [];
  return {
    calls,
    ensureRunning: async () => {},
    isUngroupedWorkspace: async () => false,
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'workspace.list') {
        return { items: workspace ? [workspace] : [], archivedSessionIds: [] };
      }
      if (method === 'session.list') return { items: sessions };
      if (method === 'session.create') return { sessionId: params.sessionId };
      throw new Error(`unexpected rpc ${method}`);
    },
  };
}

test('a session missing from session.list still binds when its workspace accounts for it', async () => {
  // Regression: a large Session written by an earlier process can be absent from
  // session.list while still on disk and registered to its workspace. Refusing to
  // bind left the user stuck on "/session" with "暂时无法读取该会话的信息".
  const fake = client({ sessions: [{ sessionId: 'other-session', cwd: WORKSPACE, projections: { values: { title: 'Other' } } }] });
  const adopted = await adoptRegisteredWorkspaceSession(fake, SESSION);
  assert.equal(adopted.sessionId, SESSION);
  assert.equal(adopted.workspace, WORKSPACE);
  assert.equal(adopted.title, null);
  assert.equal(adopted.archived, false);
  const create = fake.calls.find((call) => call.method === 'session.create');
  assert.deepEqual(create.params, { workspaceId: 'w1', sessionId: SESSION });
});

test('a listed session still contributes its title', async () => {
  const fake = client({
    sessions: [{ sessionId: SESSION, cwd: WORKSPACE, projections: { values: { title: '舊對話' } } }],
  });
  const adopted = await adoptRegisteredWorkspaceSession(fake, SESSION);
  assert.equal(adopted.title, '舊對話');
});

test('a session no workspace claims is still refused', async () => {
  const fake = client({ workspace: null, sessions: [] });
  await assert.rejects(
    () => adoptRegisteredWorkspaceSession(fake, SESSION),
    (error) => error?.code === 'session-not-registered',
  );
});
