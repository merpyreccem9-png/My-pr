// Первое, что запрашивает Mini App: профиль, настройки, диалог, память, незавершённый запрос.
import { db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { history } from '../schema.js';
import { getAiConfig, getDepth, DEPTHS, listFacts, lastKey } from '../lib/ai.js';
import { getGhLogin } from '../lib/github.js';
import { kvGetMany } from '../lib/store.js';
import { isOwner, AI_HISTORY } from '../lib/config.js';
import { appUser, loadRun, publicRun } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  const [cfg, depth, login, rows, facts, run, last] = await Promise.all([
    getAiConfig(),
    getDepth(user.tgId),
    getGhLogin(user.tgId),
    db.select().from(history).where(eq(history.userId, user.tgId)).orderBy(desc(history.id)).limit(AI_HISTORY).all(),
    listFacts(user.tgId),
    loadRun(user.tgId),
    kvGetMany([lastKey(user.tgId)]),
  ]);
  return {
    name: user.name,
    owner: isOwner(user.tgId),
    configured: Boolean(cfg),
    model: cfg?.model ?? null,
    depth,
    depths: Object.entries(DEPTHS).map(([key, [label]]) => ({ key, label })),
    github: { connected: Boolean(login), login },
    facts: facts.map((f) => f.body),
    history: rows.reverse().map((r) => ({ role: r.role, content: r.content })),
    hasLast: Boolean(last[lastKey(user.tgId)]),
    run: run && !run.done ? publicRun(run) : null,   // запрос ещё идёт (например, приложение закрыли и открыли снова)
  };
}
