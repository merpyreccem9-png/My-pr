// РП-действия: данные и рендер (чистые функции).
// Глагол хранится в мужской форме прошедшего времени; женская и «нейтральная» выводятся.

import { esc } from './fmt.js';

const T = (id, emoji, m, words) => ({ id, emoji, m, words, solo: false });
const S = (id, emoji, m, words) => ({ id, emoji, m, words, solo: true });

export const ACTIONS = [
  T('hug',     '🤗', 'обнял',      ['обнять', 'обними', 'обнимашки', 'hug']),
  T('kiss',    '😘', 'поцеловал',  ['поцеловать', 'поцелуй', 'чмок', 'kiss']),
  T('pat',     '🥰', 'погладил',   ['погладить', 'погладь', 'pat']),
  T('hit',     '👊', 'ударил',     ['ударить', 'ударь', 'втащить', 'hit']),
  T('slap',    '🖐', 'шлёпнул',    ['шлёпнуть', 'шлепнуть', 'шлёпни', 'шлепни', 'slap']),
  T('boot',    '🦶', 'пнул',       ['пнуть', 'пни']),
  T('bite',    '😬', 'укусил',     ['укусить', 'укуси', 'кусь', 'bite']),
  T('poke',    '👉', 'ткнул',      ['ткнуть', 'тыкнуть', 'тык', 'poke']),
  T('tickle',  '🤭', 'пощекотал',  ['пощекотать', 'щекотать', 'tickle']),
  T('praise',  '👏', 'похвалил',   ['похвалить', 'хвалить', 'praise']),
  T('congrat', '🎉', 'поздравил',  ['поздравить', 'поздравляю', 'congrats']),
  T('feed',    '🍲', 'покормил',   ['покормить', 'накормить', 'feed']),
  T('comfort', '🫂', 'утешил',     ['утешить', 'пожалеть', 'comfort']),
  T('push',    '💥', 'толкнул',    ['толкнуть', 'толкни', 'push']),
  T('scare',   '😱', 'напугал',    ['напугать', 'испугать', 'scare']),
  T('wave',    '👋', 'помахал',    ['помахать', 'wave']),
  S('smile',   '😊', 'улыбнулся',  ['улыбнуться', 'улыбка', 'smile']),
  S('laugh',   '😂', 'рассмеялся', ['засмеяться', 'смеяться', 'ржать', 'laugh']),
  S('cry',     '😢', 'заплакал',   ['заплакать', 'плакать', 'cry']),
  S('dance',   '💃', 'потанцевал', ['потанцевать', 'танцевать', 'dance']),
  S('sleep',   '😴', 'уснул',      ['уснуть', 'спать', 'sleep']),
  S('think',   '🤔', 'задумался',  ['задуматься', 'думать', 'think']),
  S('blush',   '😳', 'покраснел',  ['покраснеть', 'смутиться', 'blush']),
  S('sigh',    '😮‍💨', 'вздохнул',  ['вздохнуть', 'вздох', 'sigh']),
];

// слово → действие (O(1) на каждое сообщение в группе)
export const RP_BY_WORD = new Map();
for (const a of ACTIONS) for (const w of a.words) RP_BY_WORD.set(w, a);

// Глагол с учётом пола: 'm' → обнял, 'f' → обняла, иначе → обнял(а).
export function vf(masc, gender) {
  const reflexive = masc.endsWith('ся');
  if (gender === 'm') return masc;
  if (gender === 'f') return reflexive ? `${masc.slice(0, -2)}ась` : `${masc}а`;
  return reflexive ? `${masc}(ась)` : `${masc}(а)`;
}

// actorHtml/targetHtml — уже готовый HTML; comment — обычный текст (экранируется здесь).
export function renderRp(action, actorHtml, gender, targetHtml, comment) {
  let line = `${action.emoji} ${actorHtml} ${vf(action.m, gender)}`;
  if (!action.solo) line += ` 👤 ${targetHtml || 'всех'}`;
  if (comment) line += `\n💬 <i>${esc(comment)}</i>`;
  return line;
}

// Для inline-режима: действия, чьё любое слово начинается с запроса.
export function searchActions(query) {
  const q = query.toLowerCase();
  return q ? ACTIONS.filter((a) => a.words.some((w) => w.startsWith(q))) : ACTIONS;
}
