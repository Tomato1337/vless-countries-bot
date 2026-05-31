# vless-countries-bot

Telegram-бот для управления страновыми VLESS-выходами в RU 3x-ui.

Для каждого уникального `subId` существующего RU inbound бот создаёт один профиль
вида `🇺🇸 ilya-usa`. Старые device-профили (`ilya-phone`, `ilya-pc`) не изменяются.
Новый outbound набирается через существующий Germany outbound:

```text
client -> RU -> GE -> selected country
```

## Требования

- Bun 1.3+
- 3x-ui с доступом по HTTP с RU-сервера
- Один VLESS inbound на RU
- Настроенный outbound RU -> GE

## Настройка

```bash
bun install
cp .env.example .env
```

Заполните `.env`:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
XUI_BASE_URL=http://127.0.0.1:2053
XUI_USERNAME=
XUI_PASSWORD=
XUI_INBOUND_ID=
GE_OUTBOUND_TAG=
DATABASE_PATH=./data/bot.sqlite
```

`XUI_BASE_URL` должен включать secret base path панели, если он настроен:
`http://127.0.0.1:2053/your-panel-path`.

`GE_OUTBOUND_TAG` — это поле `tag` уже существующего Germany outbound в
`Xray Configs -> Outbounds`, например `germany`. Это не `vless://` ссылка.

## Запуск

```bash
bun run start
```

Перед запуском Telegram polling бот проверит cookie/CSRF-интеграцию с 3x-ui,
наличие RU inbound и Germany outbound. SQLite-файл создаётся с правами `0600`.

Для отдельной read-only проверки без запуска Telegram polling:

```bash
bun run check
```

## Команды

```text
/countries
/set usa <vless://...>
/remove usa
/sync
/allow <telegram-id>
/deny <telegram-id>
/trusted
```

`/allow`, `/deny` и `/trusted` доступны только владельцу из
`TELEGRAM_OWNER_ID`. Остальные команды доступны владельцу и доверенным
пользователям.

Флаг берётся из начала slug: `usa` становится `🇺🇸`, `de` — `🇩🇪`,
`nl-free` — `🇳🇱`. Поддерживаются ISO-2 коды и распространённые алиасы вроде
`usa`, `germany`, `france`. Если флаг определить нельзя, `/set` отклоняется до
изменения Xray-template. `/sync` также мигрирует ранее созданные ботом профили
в новый формат, сохраняя UUID и `subId`.

Чтобы подпись экспортированного профиля начиналась именно с emoji, задайте в
настройках подписок 3x-ui `Remark Model` равным `-ei`. Это глобальная настройка
панели: она влияет и на остальные профили.

Поддерживаются VLESS-ссылки с transport `tcp`, `ws`, `xhttp`, `grpc` и
security `none`, `tls`, `reality`. Неизвестный transport или security
отклоняется до изменения рабочего Xray-template. Дополнительные неизвестные
query-параметры игнорируются; итоговый outbound всё равно проверяется через
3x-ui перед применением.

## Проверка

```bash
bun test
bun run typecheck
```

После первого `/set usa <vless://...>`:

1. Обновите подписку тестового пользователя и убедитесь, что появился профиль
   `🇺🇸 ilya-usa`.
2. Проверьте, что старый device-профиль по-прежнему выходит через GE.
3. Подключитесь к `🇺🇸 ilya-usa` и проверьте внешний IP: он должен принадлежать USA.
