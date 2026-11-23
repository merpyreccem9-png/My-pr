// Выбрать модель (основную, быструю для «Короче» и сводок, или для картинок) — только для админов.
import { EndpointError } from 'sdk';
import { getAiConfig, setAiConfig } from '../lib/ai.js';
import { appUser, requireOwner } from '../lib/webapp.js';

const FIELD = { model: 'model', fast: 'fastModel', image: 'imageModel' };

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  requireOwner(user);
  const field = FIELD[input.kind];
  const id = String(input.id ?? '').trim();
  if (!field) throw new EndpointError('Неизвестный тип модели', { code: 'BAD_KIND' });
  const isOff = id === 'off';   // «как основная» бывает только у быстрой модели
  if ((isOff && input.kind !== 'fast') || (!isOff && !/^[\w.:/@+-]{1,100}$/.test(id))) {
    throw new EndpointError('Название модели выглядит странно', { code: 'BAD_MODEL' });
  }
  await setAiConfig({ [field]: id });
  const cfg = await getAiConfig();
  return { current: { model: cfg.model, fast: cfg.fastModel, image: cfg.imageModel } };
}
