// Подключить / отключить GitHub (токен только на чтение). Токен в ответе не возвращается.
import { EndpointError } from 'sdk';
import { ghWhoami, ghErrorText, setGhToken, getGhLogin } from '../lib/github.js';
import { appUser } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  if (input.action === 'disconnect') {
    await setGhToken(user.tgId, '');
    return { connected: false, login: null };
  }
  if (input.action === 'connect') {
    const token = String(input.token ?? '').trim();
    if (token.length < 20) throw new EndpointError('Это не похоже на токен GitHub', { code: 'BAD_TOKEN' });
    try {
      const me = await ghWhoami(token);
      await setGhToken(user.tgId, token, me.login);
      return { connected: true, login: me.login, wide: /\b(repo|write|delete|admin)/.test(me.scopes ?? '') };
    } catch (e) {
      throw new EndpointError(`Токен не подошёл: ${ghErrorText(e)}`, { code: 'BAD_TOKEN' });
    }
  }
  const login = await getGhLogin(user.tgId);
  return { connected: Boolean(login), login };
}
