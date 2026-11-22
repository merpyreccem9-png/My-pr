import { EndpointError } from 'sdk';
import { DEPTHS, setDepth } from '../lib/ai.js';
import { appUser } from '../lib/webapp.js';

export default async function (input, ctx) {
  const { user } = await appUser(ctx);
  if (!DEPTHS[input.depth]) throw new EndpointError('Неизвестный режим', { code: 'BAD_DEPTH' });
  await setDepth(user.tgId, input.depth);
  return { depth: input.depth };
}
