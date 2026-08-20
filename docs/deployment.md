# Развёртывание

## Архитектура контейнера

Контейнер запускает только Telegram-бота. Xray и 3x-ui остаются на RU-сервере.
Бот обращается к панели по существующему HTTPS URL:

```text
bot container -> HTTPS 3x-ui panel -> Xray on RU server
```

Используется обычная Docker bridge-сеть с исходящим интернетом. Контейнеру
нужен доступ к Telegram Bot API, NordVPN API и HTTPS URL панели.

Контейнер не публикует порты и не использует:

- `network_mode: host`;
- `host.docker.internal`;
- privileged mode;
- `NET_ADMIN`;
- `/dev/net/tun`.

NordLynx работает внутри Xray на RU-сервере, а не внутри контейнера бота.

## Требования сервера

- Linux-сервер с установленными Docker Engine и Docker Compose plugin.
- Работающая панель 3x-ui `3.4.2`.
- Доверенный TLS-сертификат на HTTPS URL панели.
- Существующий outbound из RU в Germany.
- Git для получения и обновления проекта.

Проверка Docker:

```bash
docker --version
docker compose version
```

## Первый запуск

Получите проект и перейдите в его каталог:

```bash
git clone <repository-url> vless-countries-bot
cd vless-countries-bot
cp .env.example .env
```

Заполните `.env`. Минимально необходимы:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
XUI_BASE_URL=https://panel.example.com/secret-panel-path
XUI_USERNAME=
XUI_PASSWORD=
XUI_INBOUND_ID=
GE_OUTBOUND_TAG=
DATABASE_PATH=./data/bot.sqlite
NORDVPN_PRIVATE_KEY=
```

`DATABASE_PATH` можно оставить без изменений: Compose переопределяет его на
`/app/data/bot.sqlite` внутри контейнера.

Создайте persistent-каталог и соберите образ:

```bash
mkdir -p data
docker compose build
```

Подготовьте права каталога для непривилегированного пользователя `bun` внутри
контейнера:

```bash
docker compose run --rm --user root bot \
  sh -c 'chown -R bun:bun /app/data && chmod 700 /app/data'
```

Проверьте доступность 3x-ui до запуска long polling:

```bash
docker compose run --rm bot bun index.ts --check
```

Ожидаемый результат:

```text
Compatibility check passed.
```

Запустите бота:

```bash
docker compose up -d
docker compose logs -f bot
```

## Управление сервисом

Статус:

```bash
docker compose ps
```

Логи:

```bash
docker compose logs --tail=200 bot
docker compose logs -f bot
```

Перезапуск:

```bash
docker compose restart bot
```

Остановка и запуск:

```bash
docker compose stop bot
docker compose start bot
```

Проверка healthcheck:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q bot)"
```

Healthcheck выполняет `bun index.ts --check`: проверяет авторизацию в 3x-ui,
наличие RU inbound и Germany outbound. Он не запускает Telegram polling.

## Обновление

Перед обновлением сделайте backup SQLite:

```bash
mkdir -p backups
docker compose stop bot
cp -p data/bot.sqlite "backups/bot-$(date +%F-%H%M%S).sqlite"
docker compose start bot
```

Обновите исходники, пересоберите образ и выполните compatibility check:

```bash
git pull --ff-only
docker compose build --pull
docker compose run --rm bot bun index.ts --check
docker compose up -d
docker compose logs --tail=100 bot
```

Compose пересоздаст контейнер при изменении образа. Persistent SQLite останется
в `./data`.

## Backup и restore

В SQLite хранятся managed exits, созданные ботом профили, trusted users,
template backups и audit events.

Надёжный backup создаётся на остановленном боте:

```bash
mkdir -p backups
docker compose stop bot
cp -p data/bot.sqlite "backups/bot-$(date +%F-%H%M%S).sqlite"
docker compose start bot
```

Восстановление:

```bash
docker compose stop bot
cp -p backups/<backup-file>.sqlite data/bot.sqlite
docker compose run --rm --user root bot \
  sh -c 'chown bun:bun /app/data/bot.sqlite && chmod 600 /app/data/bot.sqlite'
docker compose start bot
```

После restore выполните `/sync` в Telegram и проверьте нужный профиль.

## Удаление контейнера

Удалить контейнер и локальный образ, сохранив SQLite:

```bash
docker compose down
docker image rm vless-countries-bot:local
```

Не удаляйте `./data`, если хотите сохранить exits и trusted users.

## Локальный запуск без Docker

Docker не обязателен:

```bash
bun install
bun run check
bun run start
```
