import test from 'node:test';
import assert from 'node:assert/strict';

import { splitCommand, parseDuration, formatDuration, timeAndReason, parseGender, tokens } from '../tgcloud/lib/parse.js';
import { esc, mdToHtml, chunk, mention, fullName, maskKey } from '../tgcloud/lib/fmt.js';
import { ACTIONS, RP_BY_WORD, vf, renderRp, searchActions } from '../tgcloud/lib/rp.js';

test('splitCommand: слэш, русские слова, суффикс бота, мусор', () => {
  assert.deepEqual(splitCommand('/mute@YoruxiiBot 10m спам'), { prefix: '/', word: 'mute', at: 'yoruxiibot', args: '10m спам' });
  assert.deepEqual(splitCommand('мут 10м'), { prefix: '', word: 'мут', at: null, args: '10м' });
  assert.deepEqual(splitCommand('Обнять!'), { prefix: '', word: 'обнять', at: null, args: '' });
  assert.equal(splitCommand('@bot привет'), null);
  assert.equal(splitCommand('   '), null);
  assert.equal(splitCommand('/setwelcome Привет,\nмир!').args, 'Привет,\nмир!');
});

test('parseDuration / formatDuration', () => {
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('2ч'), 7200);
  assert.equal(parseDuration('1д'), 86400);
  assert.equal(parseDuration('1w'), 604800);
  assert.equal(parseDuration('30с'), 30);
  assert.equal(parseDuration('спам'), null);
  assert.equal(parseDuration('10'), null);
  assert.equal(parseDuration('10xyz'), null);
  assert.equal(formatDuration(0), 'навсегда');
  assert.equal(formatDuration(3600), '1 ч');
  assert.equal(formatDuration(90), '1 мин 30 сек');
  assert.equal(formatDuration(86400 + 7200 + 60), '1 д 2 ч');
});

test('timeAndReason', () => {
  assert.deepEqual(timeAndReason(['10m', 'флуд', 'в', 'чате'], 3600), { seconds: 600, reason: 'флуд в чате' });
  assert.deepEqual(timeAndReason(['спам'], 3600), { seconds: 3600, reason: 'спам' });
  assert.deepEqual(timeAndReason([], 3600), { seconds: 3600, reason: '' });
  assert.deepEqual(timeAndReason(['навсегда', 'хам'], 3600), { seconds: 0, reason: 'хам' });
  assert.deepEqual(timeAndReason(['0m', 'x'], 3600), { seconds: 3600, reason: '0m x' });
});

test('parseGender / tokens', () => {
  assert.equal(parseGender('м'), 'm');
  assert.equal(parseGender(' Ж '), 'f');
  assert.equal(parseGender('-'), null);
  assert.equal(parseGender('кот'), undefined);
  assert.deepEqual(tokens('  a  b\nc '), ['a', 'b', 'c']);
});

test('esc / mention / fullName / maskKey', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(fullName({ id: 1, first_name: 'Иван', last_name: 'П' }), 'Иван П');
  assert.equal(fullName({ id: 7 }), '7');
  assert.equal(mention({ id: 5, first_name: '<x>' }), '<a href="tg://user?id=5">&lt;x&gt;</a>');
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-1…cd');
  assert.equal(maskKey(''), '—');
});

test('mdToHtml: жирный, код, блоки, заголовки, списки, экранирование', () => {
  assert.equal(mdToHtml('**Привет** <мир> & `a<b`'), '<b>Привет</b> &lt;мир&gt; &amp; <code>a&lt;b</code>');
  assert.equal(mdToHtml('# Заголовок\n- один\n* два'), '<b>Заголовок</b>\n• один\n• два');
  assert.equal(mdToHtml('# **Жирный** заголовок'), '<b>Жирный заголовок</b>');
  assert.equal(mdToHtml('```js\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
  // звёздочки внутри кода не превращаются в теги
  assert.equal(mdToHtml('`**x**`'), '<code>**x**</code>');
  // незакрытый ``` остаётся текстом и не ломает HTML
  assert.ok(!mdToHtml('```oops <b>').includes('<b>'));
});

test('chunk: режет по границам и не теряет текст', () => {
  const para = 'слово '.repeat(200).trim();            // ~1200 символов
  const text = [para, para, para, para].join('\n\n');   // ~4800
  const parts = chunk(text, 3000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 3000));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.deepEqual(chunk('коротко'), ['коротко']);
  assert.equal(chunk('x'.repeat(7000), 3000).length, 3);
});

test('РП: нет дублей слов, у каждого действия есть слова и глагол', () => {
  const seen = new Map();
  for (const a of ACTIONS) {
    assert.ok(a.words.length && a.m && a.emoji, a.id);
    for (const w of a.words) {
      assert.ok(!seen.has(w), `дубль слова «${w}»: ${seen.get(w)} и ${a.id}`);
      seen.set(w, a.id);
      assert.equal(w, w.toLowerCase());
    }
  }
  assert.equal(RP_BY_WORD.get('обнять').id, 'hug');
});

test('РП: слова не пересекаются с командами модерации', () => {
  const mod = ['mute', 'мут', 'unmute', 'размут', 'ban', 'бан', 'unban', 'разбан', 'kick', 'кик', 'warn', 'варн',
    'unwarn', 'del', 'удалить', 'purge', 'pin', 'unpin', 'help', 'id', 'ai', 'rules', 'settings', 'gender', 'rp'];
  for (const w of mod) assert.ok(!RP_BY_WORD.has(w), `«${w}» занято и модерацией, и РП`);
});

test('vf: глаголы по полу', () => {
  assert.equal(vf('обнял', 'm'), 'обнял');
  assert.equal(vf('обнял', 'f'), 'обняла');
  assert.equal(vf('обнял', null), 'обнял(а)');
  assert.equal(vf('улыбнулся', 'f'), 'улыбнулась');
  assert.equal(vf('улыбнулся', null), 'улыбнулся(ась)');
  assert.equal(vf('шлёпнул', 'f'), 'шлёпнула');
});

test('renderRp', () => {
  const hug = RP_BY_WORD.get('обнять');
  assert.equal(renderRp(hug, '<b>А</b>', 'f', '<b>Б</b>', ''), '🤗 <b>А</b> обняла 👤 <b>Б</b>');
  assert.equal(renderRp(hug, 'А', null, null, ''), '🤗 А обнял(а) 👤 всех');
  assert.equal(renderRp(hug, 'А', 'm', 'Б', 'крепко <3'), '🤗 А обнял 👤 Б\n💬 <i>крепко &lt;3</i>');
  const smile = RP_BY_WORD.get('улыбнуться');
  assert.equal(renderRp(smile, 'А', 'f', 'игнор', ''), '😊 А улыбнулась');
});

test('searchActions', () => {
  assert.equal(searchActions('').length, ACTIONS.length);
  assert.deepEqual(searchActions('обн').map((a) => a.id), ['hug']);
  assert.deepEqual(searchActions('xyz'), []);
});
