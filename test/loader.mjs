const map = {
  sdk: new URL('./stub-sdk.mjs', import.meta.url).href,
  'sdk/db': new URL('./stub-sdk-db.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}
