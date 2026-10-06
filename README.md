# Twitch badge chat

Имитация чата Twitch для проверки канальных значков (Creator Badge Drops, значки подписчика) перед загрузкой на Twitch.

Сайт: https://alkatrazzjr.github.io/twitch-badge-chat/

## Как пользоваться

- Значок слева в поле ввода → «Имя в чате»: ник, роль, значок канала, общий значок, цвет имени.
- Каждое сообщение запоминает значки, с которыми оно отправлено. Сообщения хранятся в браузере зрителя.
- ⚙ → «Управление значками» — загрузка и удаление (только владелец).

## Права владельца

Значки хранятся в `badges/` этого репозитория. Сайт коммитит их через GitHub API токеном владельца, поэтому
у остальных зрителей прав на изменение нет.

Токен: [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) →
Repository access: *Only select repositories* → `twitch-badge-chat` → Permissions: **Contents: Read and write**.
Токен хранится только в localStorage твоего браузера.

## Требования к значкам (по документации Twitch)

**Creator Badge Drops** ([Twitch Help](https://help.twitch.tv/s/article/creator-badge-rewards), лимиты подняты в августе 2026):
квадратный PNG без анимации, до 25 КБ, рекомендуется от 120×120; название до 25 символов;
в событии до 3 значков — за подписки/подарки (1–100, обязательный), за просмотр (до 24 ч), Top Supporter (топ 1/3/5/10);
событие не дольше 28 дней, одновременно активно только одно.

**Значок подписчика** ([Subscriber Badge Guide](https://help.twitch.tv/s/article/subscriber-badge-guide)):
три PNG 18×18, 36×36, 72×72 с прозрачным фоном, каждый до 25 КБ.

**Общий значок** — для имитации глобальных значков (на Twitch их выдаёт только Twitch): квадратный PNG до 100 КБ.
