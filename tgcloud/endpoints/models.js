// Список моделей провайдера и текущий выбор — только для админов.
import { EndpointError, fetch } from 'sdk';
import { getAiConfig } from '../lib/ai.js';
import { appUser, requireOwner } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  requireOwner(user);
  const cfg = await getAiConfig();
  if (!cfg) throw new EndpointError('ИИ не настроен: отправьте боту /setkey ВАШ_КЛЮЧ', { code: 'NOT_CONFIGURED' });
  let list = [];
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (res.ok) list = (JSON.parse(await res.text()).data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string');
  } catch (e) { console.warn('models list failed', e?.message ?? e); }   // список — удобство; название можно ввести вручную
  return {
    current: { model: cfg.model, fast: cfg.fastModel, image: cfg.imageModel },
    list: [...new Set(list)].sort().slice(0, 400),
  };
}
