# vless-countries-bot

Telegram-бот для управления страновыми VPN-выходами в RU 3x-ui.

Бот добавляет в существующую подписку отдельные профили стран и регионов,
не изменяя старые device-профили. Для каждого уникального `subId` создаётся
ровно один управляемый профиль на exit:

```text
🇨🇿-ilya-cz-prague
🇫🇮-ilya-fi-helsinki
🇺🇸-ilya-us-chicago
```

Трафик управляемого NordVPN-профиля проходит по цепочке:

```text
client -> RU -> GE -> NordVPN region -> internet
```

Ручные VLESS-выходы также поддерживаются:

```text
client -> RU -> GE -> custom VLESS exit -> internet
```

## Возможности

- Кнопочное Telegram-меню на grammY long polling.
- NordVPN-регионы с выбором страны, города и сервера.
- Несколько регионов одной страны, например Chicago и New York.
- Автоматический подбор рабочего NordVPN hostname и отдельный `Repair`.
- Ручные VLESS exits через `/set`.
- Синхронизация новых подписок через `/sync`.
- Разделение прав владельца и доверенных Telegram-пользователей.
- Безопасное изменение Xray-template с backup, outbound test, rollback и
  штатным restart Xray.
- SQLite с правами `0600`.
- Docker Compose-развёртывание без privileged mode и опубликованных портов.

## Требования

- 3x-ui `3.2.5`.
- Один управляемый VLESS inbound на RU-сервере.
- Существующий outbound `RU -> GE`.
- HTTPS URL панели 3x-ui с доверенным сертификатом.
- Docker Engine и Docker Compose plugin для контейнерного запуска.

## Быстрый старт Docker

```bash
cp .env.example .env
# Заполните .env

mkdir -p data
docker compose build
docker compose run --rm --user root bot \
  sh -c 'chown -R bun:bun /app/data && chmod 700 /app/data'
docker compose run --rm bot bun index.ts --check
docker compose up -d
docker compose logs -f bot
```

Контейнер использует обычную Docker bridge-сеть. Укажите в `.env` существующий
HTTPS URL панели вместе с secret path:

```env
XUI_BASE_URL=https://panel.example.com/secret-panel-path
```

Контейнер не запускает Xray и не требует `network_mode: host`, `NET_ADMIN`,
`/dev/net/tun` или опубликованных портов.

## Документация

- [Развёртывание и обновления](docs/deployment.md)
- [Настройка 3x-ui и переменных окружения](docs/configuration.md)
- [Telegram-команды, safe apply и troubleshooting](docs/operations.md)

## Локальная разработка

```bash
bun install
cp .env.example .env
bun run check
bun run start
```

Проверки:

```bash
bun test
bun run typecheck
git diff --check
docker compose config --quiet
```

## Важные детали NordVPN

NordVPN outbounds используют:

```json
{
  "mtu": 1280,
  "noKernelTun": true,
  "proxySettings": {
    "tag": "<GE_OUTBOUND_TAG>",
    "transportLayer": true
  }
}
```

`transportLayer` сохраняет UDP-границы WireGuard-пакетов при передаче NordLynx
через Germany VLESS outbound. Без него короткий IP-check может работать, а
обычные страницы и загрузки зависают в `pending`.
