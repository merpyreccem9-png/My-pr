// Подменяет `sdk` и `sdk/db` на тестовые заглушки при загрузке модулей бота.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
